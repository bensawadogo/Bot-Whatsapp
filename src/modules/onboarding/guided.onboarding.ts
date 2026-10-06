/**
 * AfriBot — onboarding commerçant GUIDÉ PAR LE BOT (MODULE 4 — chemin B).
 *
 * Un numéro WhatsApp MAÎTRE permet à un commerçant non-lettré de configurer
 * son bot par conversation, avec des phrases courtes, des émojis et des
 * réponses numérotées (1️⃣, 2️⃣...) — aucune saisie libre difficile.
 *
 * Déclencheur : le message « ACTIVER » envoyé au numéro AfriBot.
 * Garde-fou : si le bot est DÉJÀ configuré, l'onboarding est refusé sauf pour
 * le numéro du commerçant lui-même (anti-détournement par un client).
 *
 * Les étapes sont persistées dans la session Redis (états ONBOARDING_*), donc
 * survivent à un redémarrage ; « annuler » permet de sortir à tout moment.
 */
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { messageSender } from '../../shared/sender';
import { configService } from '../../shared/config.service';
import { SINGLE_TENANT_MERCHANT_ID, ensureMerchant } from '../../shared/tenant';
import {
  ConversationStateEnum,
  sessionManager,
  type OnboardingDraft,
} from '../../shared/session';
import { createLivreur } from '../delivery/delivery.service';

/** Heures proposées pour l'ouverture (1️⃣ → 4️⃣). */
const OPEN_HOUR_CHOICES: Record<string, number> = { '1': 6, '2': 7, '3': 8, '4': 9 };
/** Heures proposées pour la fermeture (1️⃣ → 4️⃣). */
const CLOSE_HOUR_CHOICES: Record<string, number> = { '1': 17, '2': 18, '3': 19, '4': 20 };

/** Le numéro tape-t-il actuellement l'onboarding ? (utilisé par le router) */
export function isOnboardingState(state: ConversationStateEnum): boolean {
  return state.startsWith('ONBOARDING');
}

/** Démarre l'onboarding (message « ACTIVER ») ou refuse si déjà configuré. */
export async function start(phone: string): Promise<void> {
  const alreadyConfigured = await configService.isConfigured(SINGLE_TENANT_MERCHANT_ID);
  const merchantPhone = config.merchant.phone;
  if (alreadyConfigured && phone !== merchantPhone) {
    await messageSender.sendText(
      phone,
      'ℹ️ Ce bot est déjà configuré.\nTapez *aide* pour parler à un agent humain.',
    );
    return;
  }

  await sessionManager.updateSession(phone, {
    state: ConversationStateEnum.ONBOARDING_NAME,
    onboarding: {},
  });

  await messageSender.sendText(
    phone,
    [
      '👋 Bonjour ! Je suis AfriBot.',
      'Je vais configurer votre bot WhatsApp.',
      "C'est facile, je vous guide.",
      '',
      "D'abord : comment s'appelle votre commerce ?",
      '(Tapez juste le nom, exemple : Boutique Fati)',
      '',
      'Tapez *annuler* pour arrêter.',
    ].join('\n'),
  );
}

/** Point d'entrée : traite tout message d'un numéro en cours d'onboarding. */
export async function handle(phone: string, message: string): Promise<void> {
  const session = await sessionManager.getSession(phone);
  const draft = session.onboarding ?? {};

  // Sortie volontaire à tout moment
  const normalized = message.trim().toLowerCase();
  if (normalized === 'annuler' || normalized === 'cancel') {
    await sessionManager.updateSession(phone, { onboarding: undefined });
    await sessionManager.setState(phone, ConversationStateEnum.IDLE);
    await messageSender.sendText(phone, '👍 Configuration annulée. Tapez *ACTIVER* pour reprendre.');
    return;
  }

  switch (session.state) {
    case ConversationStateEnum.ONBOARDING_NAME:
      await handleName(phone, message.trim(), draft);
      break;
    case ConversationStateEnum.ONBOARDING_HOURS_OPEN:
      await handleOpenHour(phone, normalized, draft);
      break;
    case ConversationStateEnum.ONBOARDING_HOURS_CLOSE:
      await handleCloseHour(phone, normalized, draft);
      break;
    case ConversationStateEnum.ONBOARDING_PAYMENT:
      await handlePayment(phone, normalized, draft);
      break;
    case ConversationStateEnum.ONBOARDING_WAVE:
      await handleWaveNumber(phone, message.trim(), draft);
      break;
    case ConversationStateEnum.ONBOARDING_LIVREUR:
      await handleLivreurChoice(phone, normalized, draft);
      break;
    case ConversationStateEnum.ONBOARDING_LIVREUR_PHONE:
      await handleLivreurPhone(phone, message.trim(), draft);
      break;
    default:
      await start(phone);
      break;
  }
}

/** Étape 2 : nom du commerce → question horaires d'ouverture. */
async function handleName(phone: string, name: string, draft: OnboardingDraft): Promise<void> {
  if (name.length < 2 || name.length > 40) {
    await messageSender.sendText(phone, '✍️ Tapez le nom du commerce (2 à 40 lettres).\nExemple : Boutique Fati');
    return;
  }

  await sessionManager.updateSession(phone, {
    state: ConversationStateEnum.ONBOARDING_HOURS_OPEN,
    onboarding: { ...draft, businessName: name },
  });

  await messageSender.sendText(
    phone,
    [
      `Très bien ! *${name}* est enregistré ✅`,
      '',
      'À quelle heure vous ouvrez ?',
      'Tapez le chiffre :',
      '1️⃣ 6h du matin',
      '2️⃣ 7h du matin',
      '3️⃣ 8h du matin',
      '4️⃣ 9h du matin',
      '5️⃣ Autre heure',
    ].join('\n'),
  );
}

/** Étape 3a : heure d'ouverture (liste numérotée, pas de saisie libre). */
async function handleOpenHour(phone: string, input: string, draft: OnboardingDraft): Promise<void> {
  if (input === '5') {
    await messageSender.sendText(phone, "🕒 Entrez l'heure d'ouverture (0 à 23).\nExemple : *10*");
    return;
  }

  const choice = OPEN_HOUR_CHOICES[input];
  const free = /^\d{1,2}$/.test(input) ? Number(input) : undefined;
  const openHour = choice ?? (free !== undefined && free >= 0 && free <= 23 ? free : undefined);
  if (openHour === undefined) {
    await messageSender.sendText(
      phone,
      "🕒 Tapez un chiffre entre 1 et 4, ou 5 pour saisir une autre heure (0 à 23).\nExemple : *10*",
    );
    return;
  }

  await sessionManager.updateSession(phone, {
    state: ConversationStateEnum.ONBOARDING_HOURS_CLOSE,
    onboarding: { ...draft, openHour },
  });

  await messageSender.sendText(
    phone,
    [
      `✅ Ouverture à ${openHour}h notée.`,
      '',
      'À quelle heure vous fermez ?',
      'Tapez le chiffre :',
      '1️⃣ 17h',
      '2️⃣ 18h',
      '3️⃣ 19h',
      '4️⃣ 20h',
      '5️⃣ Autre heure',
    ].join('\n'),
  );
}

/** Étape 3b : heure de fermeture. */
async function handleCloseHour(phone: string, input: string, draft: OnboardingDraft): Promise<void> {
  if (input === '5') {
    await messageSender.sendText(phone, "🕒 Entrez l'heure de fermeture (0 à 24).\nExemple : *21*");
    return;
  }

  const choice = CLOSE_HOUR_CHOICES[input];
  const free = /^\d{1,2}$/.test(input) ? Number(input) : undefined;
  const closeHour = choice ?? (free !== undefined && free >= 0 && free <= 24 ? free : undefined);

  if (closeHour === undefined) {
    await messageSender.sendText(
      phone,
      "🕒 Tapez un chiffre entre 1 et 4, ou 5 pour saisir une autre heure (0 à 24).\nExemple : *21*",
    );
    return;
  }

  await sessionManager.updateSession(phone, {
    state: ConversationStateEnum.ONBOARDING_PAYMENT,
    onboarding: { ...draft, closeHour },
  });

  await messageSender.sendText(
    phone,
    [
      `✅ Parfait ! Ouvert de ${draft.openHour}h à ${closeHour}h.`,
      '',
      'Comment vos clients paient-ils ?',
      '1️⃣ Argent cash à la livraison',
      '2️⃣ Wave ou Orange Money direct',
      '3️⃣ Les deux',
    ].join('\n'),
  );
}

/** Étape 4 : mode de paiement (COD / direct / les deux). */
async function handlePayment(phone: string, input: string, draft: OnboardingDraft): Promise<void> {
  if (!['1', '2', '3'].includes(input)) {
    await messageSender.sendText(phone, '💳 Tapez *1*, *2* ou *3*.');
    return;
  }

  const paymentMode = input === '2' || input === '3' ? 'DIRECT' : 'COD';
  const codEnabled = input !== '2';

  await sessionManager.updateSession(phone, {
    state: input === '1' ? ConversationStateEnum.ONBOARDING_LIVREUR : ConversationStateEnum.ONBOARDING_WAVE,
    onboarding: { ...draft, paymentMode, codEnabled },
  });

  if (input === '1') {
    await askLivreur(phone);
    return;
  }

  await messageSender.sendText(
    phone,
    [
      '📱 Votre numéro Wave ? (tapez juste le numéro)',
      'Exemple : 22670000000',
      '',
      '(Le numéro Orange/Moov pourra être ajouté',
      'depuis le tableau de bord plus tard.)',
    ].join('\n'),
  );
}

/** Étape 4bis : numéro Wave/Orange du commerçant (MODE B). */
async function handleWaveNumber(phone: string, input: string, draft: OnboardingDraft): Promise<void> {
  const digits = normalizePhoneInput(input);
  if (digits.length < 8 || digits.length > 15) {
    await messageSender.sendText(
      phone,
      '📞 Ce numéro ne semble pas correct.\nTapez juste les chiffres, exemple : *22670000000*',
    );
    return;
  }

  await sessionManager.updateSession(phone, {
    state: ConversationStateEnum.ONBOARDING_LIVREUR,
    onboarding: { ...draft, waveNumber: digits, orangeNumber: digits },
  });

  await askLivreur(phone);
}

/** Étape 5 : le commerçant a-t-il un livreur ? */
async function handleLivreurChoice(phone: string, input: string, draft: OnboardingDraft): Promise<void> {
  if (!['1', '2', '3'].includes(input)) {
    await messageSender.sendText(phone, '🚗 Tapez *1*, *2* ou *3*.');
    return;
  }

  const livreurChoice = Number(input);
  const nextDraft = { ...draft, livreurChoice };
  await sessionManager.updateSession(phone, {
    state: input === '1' ? ConversationStateEnum.ONBOARDING_LIVREUR_PHONE : ConversationStateEnum.ONBOARDING_LIVREUR,
    onboarding: nextDraft,
  });

  if (input === '1') {
    await messageSender.sendText(
      phone,
      ['🚗 Numéro WhatsApp de votre livreur ?', '(Tapez juste les chiffres, exemple : 22671111111)'].join('\n'),
    );
    return;
  }
  await finish(phone, nextDraft);
}

/** Étape 5bis : numéro du livreur → création + message de bienvenue. */
async function handleLivreurPhone(phone: string, input: string, draft: OnboardingDraft): Promise<void> {
  const digits = normalizePhoneInput(input);
  if (digits.length < 8 || digits.length > 15) {
    await messageSender.sendText(
      phone,
      '📞 Ce numéro ne semble pas correct.\nTapez juste les chiffres, exemple : *22671111111*',
    );
    return;
  }

  await sessionManager.updateSession(phone, {
    state: ConversationStateEnum.ONBOARDING_LIVREUR,
    onboarding: { ...draft, livreurPhone: digits },
  });
  await finish(phone, { ...draft, livreurPhone: digits });
}

/** Question « avez-vous un livreur ? » (réutilisée après l'étape paiement). */
async function askLivreur(phone: string): Promise<void> {
  await messageSender.sendText(
    phone,
    [
      'Voulez-vous un livreur ?',
      '1️⃣ Oui, j\'ai un livreur',
      '2️⃣ Non, je livre moi-même',
      '3️⃣ Pas de livraison',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Finalisation : sauvegarde de la config + messages de bienvenue
// ---------------------------------------------------------------------------

async function finish(phone: string, draft: OnboardingDraft): Promise<void> {
  const deliveryEnabled = draft.livreurChoice !== 3;

  await ensureMerchant();
  await configService.updateConfig({
    businessName: draft.businessName ?? 'Mon commerce',
    openHour: draft.openHour,
    closeHour: draft.closeHour,
    timezone: config.merchant.timezone,
    paymentMode: draft.paymentMode ?? 'COD',
    waveNumber: draft.waveNumber,
    orangeNumber: draft.orangeNumber,
    // Le commerçant qui s'auto-configure reçoit les alertes sur son numéro
    merchantNotifPhone: phone,
    deliveryEnabled,
    codEnabled: draft.codEnabled ?? true,
  }, SINGLE_TENANT_MERCHANT_ID);

  // Livreur déclaré pendant l'onboarding → création + message de bienvenue
  if (draft.livreurChoice === 1 && draft.livreurPhone) {
    try {
      const livreur = await createLivreur({
        merchantId: SINGLE_TENANT_MERCHANT_ID,
        name: `Livreur ${draft.businessName ?? ''}`.trim(),
        phone: draft.livreurPhone,
      });
      await messageSender.sendText(
        livreur.phone,
        [
          `👋 Bonjour ! Vous êtes maintenant livreur pour ${draft.businessName ?? 'notre boutique'}.`,
          'Vous recevrez les commandes ici.',
          'Tapez *DISPO* si disponible, *INDISPO* si pas disponible.',
        ].join('\n'),
      );
    } catch (err) {
      // Numéro déjà utilisé (ex : le commerçant livre lui-même) → non bloquant
      logger.warn(`Onboarding : création livreur ${draft.livreurPhone} échouée : ${String(err)}`);
      await messageSender.sendText(
        phone,
        '⚠️ Le numéro du livreur est déjà enregistré — il reste actif.',
      );
    }
  }

  await sessionManager.updateSession(phone, { onboarding: undefined });
  await sessionManager.setState(phone, ConversationStateEnum.IDLE);

  const dashboardUrl = `${config.server.appUrl}/dashboard`;
  await messageSender.sendText(
    phone,
    [
      '✅ Votre bot est configuré !',
      '',
      'Votre bot va maintenant :',
      '✅ Répondre à vos clients automatiquement',
      '✅ Gérer vos commandes',
      '✅ Alerter votre livreur',
      '',
      `Pour voir vos ventes : ${dashboardUrl}`,
      "Pour de l'aide : tapez AIDE",
    ].join('\n'),
  );
  logger.info(`Onboarding terminé pour ${phone} (commerce : ${draft.businessName ?? '?'})`);
}

/** Chiffres uniquement (retire « + », espaces, tirets). */
function normalizePhoneInput(input: string): string {
  return input.replace(/\D/g, '');
}