/**
 * AfriBot — contrôleur de webhooks entrants.
 *
 * Reçoit les événements d'Evolution API (messages Cloud API Meta officiels),
 * valide la signature, extrait les données minimales puis délègue au
 * ConversationRouter. Le traitement est asynchrone : on répond 200 tout de
 * suite pour que Meta ne re-tool pas le webhook (sinon retries + délais).
 *
 * GET /webhook : vérification initiale du webhook Meta (hub.challenge).
 */
import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { config } from '../config/env';
import { logger } from '../config/logger';
import { conversationRouter } from './conversation.router';
import { history } from './history';
import { logConversation } from './meta.compliance';
import { handleCTWAWebhook } from '../modules/campaigns/campaign.service';
import { PaymentModule } from '../modules/payments/payment.module';
import type { CinetPayWebhook, FedaPayWebhook } from '../modules/payments/payment.types';

export const webhookRouter = Router();

// ---------------------------------------------------------------------------
// Schéma Zod du payload "messages.upsert" Evolution API (sous-ensemble utilisé)
// ---------------------------------------------------------------------------

export const evolutionWebhookPayloadSchema = z.object({
  event: z.literal('messages.upsert'),
  instance: z.string().min(1),
  data: z.object({
    key: z.object({
      remoteJid: z.string().min(1),
      fromMe: z.boolean(),
      id: z.string().min(1),
    }),
    pushName: z.string().optional(),
    messageType: z.string().min(1),
    // Le texte peut arriver sous plusieurs formes selon la version d'Evolution
    // API : content (champ simplifié) ou message.conversation /
    // message.extendedTextMessage.text (format Cloud API brut).
    content: z.string().optional(),
    message: z
      .object({
        conversation: z.string().optional(),
        extendedTextMessage: z.object({ text: z.string() }).optional(),
      })
      .optional(),
  }),
});
export type EvolutionWebhookPayload = z.infer<typeof evolutionWebhookPayloadSchema>;

// ---------------------------------------------------------------------------
// Validation de signature — header x-evolution-signature
// HMAC-SHA256 du corps brut avec le token webhook partagé
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Détection CTWA — arrivée d'un client depuis une pub Facebook/Instagram
// ---------------------------------------------------------------------------

interface CtwaReferral {
  phoneNumber: string;
  ctwaClid?: string | undefined;
  adId?: string | undefined;
  sourceId?: string | undefined;
}

/**
 * Extrait les données CTWA du payload brut Evolution API si présentes :
 * `referral.source_type === "ad"` + `referral.ctwa_clid`. La structure peut
 * varier selon la version d'Evolution API (data.referral ou
 * data.context.referral) — on sonde les deux emplacements de manière sûre.
 */
function extractCtwaReferral(rawBody: unknown, phone: string): CtwaReferral | null {
  const data = (rawBody as { data?: Record<string, unknown> }).data;
  if (!data) return null;
  const referral =
    (data.referral as Record<string, unknown> | undefined) ??
    ((data.context as Record<string, unknown> | undefined)?.referral as
      | Record<string, unknown>
      | undefined);
  if (!referral || referral.source_type !== 'ad') return null;

  return {
    phoneNumber: phone,
    ctwaClid: typeof referral.ctwa_clid === 'string' ? referral.ctwa_clid : undefined,
    adId: typeof referral.ad_id === 'string' ? referral.ad_id : undefined,
    sourceId: typeof referral.source_id === 'string' ? referral.source_id : undefined,
  };
}

function isValidSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', config.evolution.waBusinessTokenWebhook)
    .update(rawBody)
    .digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function constantTimeCompare(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.from(a.padEnd(maxLen, '\0'), 'utf-8');
  const bufB = Buffer.from(b.padEnd(maxLen, '\0'), 'utf-8');
  const result = timingSafeEqual(bufA, bufB);
  return result && a.length === b.length;
}

// ---------------------------------------------------------------------------
// Extraction minimale du message
// ---------------------------------------------------------------------------

interface IncomingMessage {
  phone: string;
  text: string;
  type: string;
}

function extractMessage(payload: EvolutionWebhookPayload): IncomingMessage | null {
  // Ignore les messages émis par le bot lui-même
  if (payload.data.key.fromMe) return null;
  // Ne traite que les messages de conversation individuelle (pas les groupes)
  if (payload.data.key.remoteJid.endsWith('@g.us')) return null;

  const text =
    payload.data.content ??
    payload.data.message?.conversation ??
    payload.data.message?.extendedTextMessage?.text ??
    '';

  return {
    phone: payload.data.key.remoteJid.replace('@s.whatsapp.net', ''),
    text,
    type: payload.data.messageType,
  };
}

// ---------------------------------------------------------------------------
// GET /webhook — vérification initiale du webhook par Meta
// Meta appelle GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
// On répond avec le challenge en texte brut si le token correspond.
// ---------------------------------------------------------------------------

webhookRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string | undefined;
  const token = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge'] as string | undefined;

  if (mode === 'subscribe' && constantTimeCompare(token, config.evolution.waBusinessTokenWebhook) && challenge) {
    logger.info('Vérification du webhook Meta réussie (hub.challenge)');
    res.status(200).type('text/plain').send(challenge);
    return;
  }

    logger.warn('Vérification du webhook Meta refusée (token ou mode invalide)');
  res.status(403).json({ error: 'Vérification refusée'   });

// ---------------------------------------------------------------------------
// Route principale — POST /webhook/messages (monté sous /webhook par index.ts)
// ---------------------------------------------------------------------------

webhookRouter.post('/messages', async (req: Request, res: Response) => {
  // Guard : req.body doit être un Buffer (produit par express.raw() dans index.ts)
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: 'Corps de requête invalide'   });
    return;
  }

  // req.body est un Buffer grâce à express.raw() — HMAC calculé sur le corps BRUT
  const bodyString = (req.body as Buffer).toString('utf-8');

  const signature = req.header('x-evolution-signature');
  if (!isValidSignature(bodyString, signature)) {
    logger.warn('Webhook refusé : signature invalide');
    res.status(401).json({ error: 'Signature invalide'   });
    return;
  }

  // Signature validée → parsing du JSON une seule fois
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyString) as unknown;
  } catch {
    logger.warn('Webhook refusé : JSON invalide');
    res.status(400).json({ error: 'JSON invalide'   });
    return;
  }

  // Filtrage rapide des événements qui ne sont pas des messages entrants
  const eventType = (parsedBody as { event?: unknown }).event;
  if (eventType !== 'messages.upsert') {
    res.status(200).json({ received: true, processed: false   });
    return;
  }

  // Validation Zod stricte du payload messages.upsert
  const parsedPayload = evolutionWebhookPayloadSchema.safeParse(parsedBody);
  if (!parsedPayload.success) {
    // Payload incompris : 200 quand même (Meta re-tool le webhook en cas d'erreur)
    logger.warn(`Webhook messages.upsert au format inattendu : ${parsedPayload.error.message}`);
    res.status(200).json({ received: true, processed: false   });
    return;
  }

  // Validation de l’identité de l’instance Evolution API (défense en profondeur)
  if (parsedPayload.data.instance !== config.evolution.instanceName) {
    logger.warn(`Webhook refusé : instance "${parsedPayload.data.instance}" ≠ "${config.evolution.instanceName}"`);
    res.status(403).json({ error: 'Instance invalide'   });
    return;
  }

  const message = extractMessage(parsedPayload.data);
  if (!message) {
    // Événement sans message traitable : OK pour Meta, pas de traitement
    res.status(200).json({ received: true, processed: false   });
    return;
  }

  // Historique conversationnel (utilisé par l'escalade Chatwoot — Phase 3)
  void history
    .append(message.phone, { fromMe: false, text: message.text.slice(0, 1000), type: message.type })
    .catch((err: unknown) => {
      logger.warn(`Historique entrant non enregistré pour ${message.phone} : ${String(err)}`);
    })

  // Le journal durable ouvre la fenêtre de service 24 h. Il est attendu
  // avant le routage afin qu'enforceOptIn() voie immédiatement le message entrant.
  await logConversation({ phone: message.phone, fromMe: false, text: message.text, type: message.type   });

  // Attribution CTWA (MODULE CAMPAGNES) : si le client arrive d'une pub
  // Meta (referral.source_type === "ad"), on marque le contact de campagne
  // et on envoie le flow d'accueil CTWA. La fenêtre gratuite de 72 h est
  // automatiquement ouverte par Meta — le client a initié la conversation.
  const ctwa = extractCtwaReferral(parsedBody, message.phone);
  if (ctwa) {
    logger.info(`Client ${message.phone} arrivé via une pub Meta (CTWA)`);
    void handleCTWAWebhook(ctwa).catch((err: unknown) => {
      logger.warn(`Traitement CTWA échoué pour ${message.phone} : ${String(err)}`);
    })
  }

  // Traitement asynchrone : réponse HTTP immédiate, le router continue en tâche de fond
  void conversationRouter
    .route(message.phone, message.text, message.type)
    .catch((err: unknown) => {
      logger.error(`Erreur de traitement du message de ${message.phone} : ${String(err)}`);
    })

  res.status(200).json({ received: true, processed: true   });

// ---------------------------------------------------------------------------
// POST /webhook/payment — callbacks CinetPay / FedaPay (confirmations paiement)
// ---------------------------------------------------------------------------
// Monté sous /webhook par index.ts → POST /webhook/payment
// Aucun auth HTTP : la sécurité repose sur verifyPayment() (re-vérification
// auprès du fournisseur) dans PaymentModule.handleWebhook — on ne fait JAMAIS
// confiance au webhook fournisseur seul (defence-in-depth).


webhookRouter.post('/payment', async (req: Request, res: Response) => {
  let body: CinetPayWebhook | FedaPayWebhook = req.body;
  if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString('utf-8')) as CinetPayWebhook | FedaPayWebhook;
    } catch {
      res.status(400).json({ error: 'JSON invalide'   });
      return;
    }
  }

  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Payload invalide'   });
    return;
  }

  res.status(200).json({ received: true });


  // Traitement asynchrone (r�ponse imm�diate � �vite les timeouts du fournisseur)
  void Promise.resolve()
    .then(() => {
      const paymentModule = new PaymentModule();
      return paymentModule.handleWebhook(body);
    })
    .catch((err: unknown) => {
      logger.error(`Webhook paiement : ${String(err)}`);
    })
  })
});

}
)
