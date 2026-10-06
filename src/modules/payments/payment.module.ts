/**
 * AfriBot — module paiements (Phase 2).
 *
 * État AWAITING_PAYMENT : le bot a créé une commande (PENDING) et doit
 * initier le paiement Mobile Money. Le client peut :
 *   - « relancer » / « réessayer » → re-générer le lien de paiement
 *   - « annuler » → annuler la commande + retour IDLE
 *
 * Le webhook fournisseur (CinetPay/FedaPay) confirme le paiement : on
 * RE-VÉRIFIE le statut auprès du fournisseur (anti-fraude) avant de passer
 * la commande à PAID, d'envoyer le reçu et de noter le commerçant.
 */
import { logger } from '../../config/logger';
import { config } from '../../config/env';
import { prisma } from '../../config/database';
import { messageSender } from '../../shared/sender';
import { formatPrice } from '../../shared/format';
import { configService, type MerchantConfigView } from '../../shared/config.service';
import { ConversationStateEnum, sessionManager, type ConversationState } from '../../shared/session';
import * as orderService from '../orders/order.service';
import { OrderStatus } from '../orders/order.types';
import type { Order } from '../orders/order.types';
import {
  createCinetPayLink,
  createFedaPayLink,
  createPawaPayDeposit,
  isPawaPayEnabled,
  redactId,
  verifyPayment,
  updatePaymentStatus,
} from './payment.service';
import { PaymentProvider, PaymentStatus, type CinetPayWebhook, type FedaPayWebhook } from './payment.types';
// ---------------------------------------------------------------------------
// Détection du fournisseur et extraction du statut (payloads CinetPay/FedaPay)
// ---------------------------------------------------------------------------

/** Identifie le fournisseur à partir du payload webhook reçu. */
function detectProvider(payload: CinetPayWebhook | FedaPayWebhook): PaymentProvider | null {
  if ('cpm_trans_id' in payload) return PaymentProvider.CINETPAY;
  if ('event' in payload) return PaymentProvider.FEDAPAY;
  return null;
}

/** Extrait l'identifiant de transaction du fournisseur. */
function extractTransactionId(payload: CinetPayWebhook | FedaPayWebhook, provider: PaymentProvider): string {
  if (provider === PaymentProvider.CINETPAY) {
    return (payload as CinetPayWebhook).cpm_trans_id;
  }
  const fwp = payload as FedaPayWebhook;
  return String(fwp.data?.id ?? fwp.id);
}

/** Extrait le statut du paiement depuis le webhook. */
function extractPaymentStatus(
  payload: CinetPayWebhook | FedaPayWebhook,
  provider: PaymentProvider,
): PaymentStatus | null {
  if (provider === PaymentProvider.CINETPAY) {
    const status = (payload as CinetPayWebhook).cpm_trans_status?.toUpperCase() ?? '';
    if (['ACCEPTED', 'SUCCESSFUL', 'SUCCESS'].includes(status)) return PaymentStatus.SUCCESS;
    if (['FAILED', 'CANCELLED', 'DENIED', 'REFUNDED'].includes(status)) return PaymentStatus.FAILED;
    return null;
  }
  const parts = (payload as FedaPayWebhook).event?.split('.') ?? [];
  const verb = parts[1]?.toLowerCase() ?? '';
  if (['approved', 'transferred'].includes(verb)) return PaymentStatus.SUCCESS;
  if (verb === 'declined') return PaymentStatus.FAILED;
  if (verb === 'refunded') return PaymentStatus.REFUNDED;
  return null;
}

// ---------------------------------------------------------------------------
// PaymentModule — point d'entrée conversationnel (état AWAITING_PAYMENT)
// ---------------------------------------------------------------------------

export class PaymentModule {
  /** Point d'entrée du module pour un message en état AWAITING_PAYMENT. */
  handle(phone: string, message: string, session: ConversationState): Promise<void> {
    const normalized = message.trim().toLowerCase();

    // « annuler » disponible à tout moment
    if (normalized === 'annuler' || normalized === 'cancel') {
      return cancelPaymentAndOrder(phone, session.currentOrderId);
    }

    // « relancer » / « réessayer » / « payer » → re-générer le lien
    if (['relancer', 'réessayer', 'reessayer', 'payer', '1', 'oui'].includes(normalized)) {
      return this.initiatePayment(phone, session.currentOrderId ?? '');
    }

        // Tout autre message = code de transaction (MODE B) — codes Wave/Orange/Moov
    // font 8-12 caractères. On exige au moins 8 caractères pour éviter de
    // capturer les messages courts / mots de 6-7 caractères (ex: "blabla",
    // "annuler"). Une capture d'écran arrive en légende textuelle → traitée comme code.
    if (message.trim().length >= 8 && /^[A-Za-z0-9]+$/.test(message.trim())) {
      return this.handleTransactionCode(phone, message.trim());
    }

    // Message trop court → rappeler les options
    logger.debug(
      `PaymentModule.handle(${phone}) : "${message}" (commande: ${session.currentOrderId ?? 'aucune'})`,
    );
    return messageSender.sendText(
      phone,
      'Votre paiement est en cours. Répondez « relancer » pour un nouveau lien, ou « annuler » pour annuler.',
    );
  }
  /** Détecte le fournisseur de paiement depuis la config (CinetPay → FedaPay). */
  private preferredProvider(): {
    provider: PaymentProvider;
    createLink: (order: Order) => Promise<{ paymentUrl: string; transactionId: string }>;
  } {
    const cp = config.payment.cinetpay;
    if (cp.siteId && cp.apiKey && cp.notifyUrl) {
      return { provider: PaymentProvider.CINETPAY, createLink: createCinetPayLink };
    }
    const fp = config.payment.fedapay;
    if (fp.secretKey) {
      return { provider: PaymentProvider.FEDAPAY, createLink: createFedaPayLink };
    }
    throw new Error("Aucun fournisseur de paiement (CinetPay/FedaPay) n'est configuré");
  }

  /**
   * Génère le lien de paiement et l'envoie au client sur WhatsApp.
   * Persiste le paiement en PENDING, notifie le commerçant, puis attend webhook.
   *
   * STRATÉGIE PROGRESSIVE (MODULE 2) :
   *   COD      → rappel « paiement à la livraison » (géré par le flux commande)
   *   DIRECT   → instructions de virement Wave/Orange/Moov (aucune API)
   *   PAWAPAY  → dépôt PawaPay si le token existe, repli DIRECT sinon,
   *              repli final CinetPay/FedaPay (liens historiques).
   */
  async initiatePayment(phone: string, orderId: string): Promise<void> {
    if (!orderId) {
      await sessionManager.setState(phone, ConversationStateEnum.IDLE);
      await messageSender.sendText(phone, 'Session expirée. Tapez « catalogue » pour recommencer.');
      return;
    }

    try {
      const order = await orderService.getOrderById(orderId);
      if (!order) {
        logger.warn(`initiatePayment : commande ${orderId} introuvable pour ${phone}`);
        await sessionManager.setState(phone, ConversationStateEnum.IDLE);
        await messageSender.sendText(phone, 'Commande introuvable. Tapez « catalogue » pour recommencer.');
        return;
      }

      const cfg = await configService.getConfig();

      // MODE A — COD : le client paie le livreur, rien à initier
      // (uniquement quand le commerçant a explicitement configuré COD —
      // sinon on garde le comportement historique liens CinetPay/FedaPay)
      if (cfg.isConfigured && cfg.paymentMode === 'COD') {
        await messageSender.sendText(
          phone,
          `💵 Paiement à la LIVRAISON pour la commande #${orderId.slice(0, 8)}.\n` +
            `Préparez ${formatPrice(order.total)} — le livreur vous les collecte.\n\n` +
            `Tapez « annuler » pour annuler.`,
        );
        await notifyMerchant(
          `💵 Commande COD #${orderId.slice(0, 8)} — ${formatPrice(order.total)} — ${phone}`,
        );
        return;
      }

      // MODE B — virement direct (aucun agrégateur requis). Prioritaire si le
      // commerçant l'a choisi, ou si des numéros .env existent et qu'aucun
      // agrégateur n'est configuré (démarrage sans dashboard).
      const directNumbers = await this.getDirectNumbers(cfg);
      const wantsDirect =
        (cfg.isConfigured ? cfg.paymentMode === 'DIRECT' : Boolean(directNumbers.wave || directNumbers.orange || directNumbers.moov));
      if (wantsDirect && !isPawaPayEnabled()) {
        await this.sendDirectPaymentInstructions(phone, order, cfg);
        await sessionManager.setState(phone, ConversationStateEnum.AWAITING_PAYMENT);
        await notifyMerchant(
          `💰 Attente du virement du client pour #${orderId.slice(0, 8)} — ${formatPrice(order.total)}`,
        );
        return;
      }

      // MODE C — PawaPay (entreprise créée) sinon agrégateurs historiques
      if (isPawaPayEnabled()) {
        try {
          const { instructions } = await createPawaPayDeposit(order);
          await messageSender.sendText(phone, instructions);
          await notifyMerchant(
            `🏦 Dépôt PawaPay créé pour #${orderId.slice(0, 8)} — ${formatPrice(order.total)}`,
          );
          return;
        } catch (err) {
          // Échec PawaPay → repli automatique sur le MODE B (résilience)
          logger.warn(`PawaPay indisponible, repli MODE B : ${String(err)}`);
          await this.sendDirectPaymentInstructions(phone, order, cfg);
          await sessionManager.setState(phone, ConversationStateEnum.AWAITING_PAYMENT);
          return;
        }
      }

      // Agrégateurs historiques (liens CinetPay / FedaPay)
      const { provider, createLink } = this.preferredProvider();
      const { paymentUrl, transactionId } = await createLink(order);
      logger.info(`Lien paiement ${provider} généré : ${redactId(transactionId)} (${formatPrice(order.total)} — ${phone})`);

      await messageSender.sendText(
        phone,
        `💳 ${provider === PaymentProvider.CINETPAY ? 'CinetPay' : 'FedaPay'}\nPour régler votre commande #${orderId.slice(0, 8)} (${formatPrice(order.total)}),\ncliquez sur le lien ci-dessous :\n${paymentUrl}\n\nRépondez « relancer » si le lien ne fonctionne pas.`      );

      await notifyMerchant(
        `💳 Paiement en attente — commande #${orderId.slice(0, 8)} — ${formatPrice(order.total)} — ${phone}`,
      );
    } catch (err) {
      logger.error(`initiatePayment ${phone} / ${orderId} : ${String(err)}`);
      await messageSender.sendText(
        phone,
        "Impossible de générer le lien de paiement. Réessayez plus tard ou tapez « aide ».",
      );
    }
  }

  /**
   * Traite le webhook fournisseur (CinetPay/FedaPay) :
   * 1. Distingue le fournisseur → 2. RE-VÉRIFIE statut (anti-fraude) →
   * 3. Met à jour paiement + commande (→ PAID) → 4. reçu + notification →
   * 5. session COMPLETED.
   */
  async handleWebhook(payload: CinetPayWebhook | FedaPayWebhook): Promise<void> {
    const provider = detectProvider(payload);
    if (!provider) {
      logger.warn('Webhook paiement : fournisseur introuvable dans le payload');
      return;
    }
    const transactionId = extractTransactionId(payload, provider);
    const webhookStatus = extractPaymentStatus(payload, provider);
    logger.info(`Webhook paiement ${provider} ${redactId(transactionId)} : statut=${webhookStatus ?? 'pending'}`);

    // 2. RE-VÉRIFICATION auprès du fournisseur (anti-fraude)
    const verified = await verifyPayment(transactionId, provider);
    if (!verified) {
      logger.warn(`Webhook ${provider} ${redactId(transactionId)} : vérification fournisseur échouée — ignorée`);
      return;
    }

    // 3. Charger le paiement existant (de-dup + cross-check montant)
    const payment = await prisma.payment.findUnique({
      where: { transactionId },
      select: { orderId: true, status: true, amount: true },
    });
    if (!payment) {
      logger.error(`Webhook paiement : Payment introuvable pour ${redactId(transactionId)}`);
      return;
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      logger.info(`Webhook ${provider} ${redactId(transactionId)} : déjà traité (SUCCESS) — ignoré`);
      return;
    }

    const webhookAmount =
      provider === PaymentProvider.CINETPAY
        ? Number((payload as CinetPayWebhook).cpm_amount)
        : (payload as FedaPayWebhook).data?.amount;
    if (webhookAmount !== undefined && webhookAmount !== null && webhookAmount !== payment.amount) {
      logger.warn(
        `Webhook ${provider} ${redactId(transactionId)} : montant ${webhookAmount} ≠ ${payment.amount} attendu — ignoré`,
      );
      return;
    }

    // 4. Mise à jour du paiement + commande → PAID
    await updatePaymentStatus(transactionId, PaymentStatus.SUCCESS);
    try {
      await orderService.updateOrderStatus(payment.orderId, OrderStatus.PAID);
    } catch (err) {
      logger.error(`handleWebhook : update commande ${payment.orderId} → PAID : ${String(err)}`);
    }

    // 5. Reçu client + notification commerçant
    const order = await orderService.getOrderById(payment.orderId);
    if (order) {
      const total = formatPrice(order.total);
      await messageSender.sendText(
        order.phoneNumber,
        `✅ Paiement confirmé !\n\n🧾 Reçu — Commande #${order.id.slice(0, 8)}\nTotal : ${total}\nStatut : PAYÉE\n\nMerci ! Votre commande est en préparation.`,
      );
      await notifyMerchant(`✅ Paiement reçu — commande #${order.id.slice(0, 8)} — ${total} — ${order.phoneNumber}`);
      await sessionManager.setState(order.phoneNumber, ConversationStateEnum.COMPLETED);
    }
  }

  // ---------------------------------------------------------------------------
  // MODE B — virement direct Wave / Orange Money / Moov (MODULE 2)
  // ---------------------------------------------------------------------------

  /** Numéros de réception du commerçant : config dashboard, sinon .env. */
  private async getDirectNumbers(cfg: MerchantConfigView): Promise<{
    wave: string | null;
    orange: string | null;
    moov: string | null;
  }> {
    return {
      wave: cfg.waveNumber ?? config.payment.direct.waveNumber ?? null,
      orange: cfg.orangeNumber ?? config.payment.direct.orangeNumber ?? null,
      moov: cfg.moovNumber ?? config.payment.direct.moovNumber ?? null,
    };
  }

  /** Envoie les instructions de virement au client (message texte simple). */
  async sendDirectPaymentInstructions(
    phone: string,
    order: Order,
    cfg?: MerchantConfigView,
  ): Promise<void> {
    const conf = cfg ?? (await configService.getConfig());
    const { wave, orange, moov } = await this.getDirectNumbers(conf);
    const lines: string[] = [`💳 Pour payer votre commande de ${formatPrice(order.total)} :`, ''];

    if (wave) lines.push(`📱 Wave : Envoyez ${formatPrice(order.total)} au ${wave}`);
    if (orange) lines.push(`📱 Orange Money : Tapez #144# ou envoyez au ${orange}`);
    if (moov) lines.push(`📱 Moov Money : Envoyez au ${moov}`);

    if (!wave && !orange && !moov) {
      // Aucun numéro configuré → message générique (le commerçant complétera)
      lines.push('📱 Les numéros de paiement ne sont pas encore configurés.');
    }

    lines.push(
      '',
      '✅ Après paiement, envoyez votre *code de transaction*',
      'ou une capture d\u2019écran.',
      '',
      '⚠️ Votre commande sera confirmée après vérification.',
    );

    await messageSender.sendText(phone, lines.join('\n'));
    logger.info(`Instructions MODE B envoyées à ${phone} (commande ${order.id.slice(0, 8)})`);
  }

  /**
   * Le client a envoyé son code de transaction : sauvegarde dans
   * Payment.metadata puis notifie le commerçant pour VALIDER/REFUSER.
   */
  async handleTransactionCode(phone: string, code: string): Promise<void> {
    const session = await sessionManager.getSession(phone);
    const orderId = session.currentOrderId;
    if (!orderId) {
      await messageSender.sendText(phone, 'Aucune commande en attente de paiement. Tapez « catalogue ».');
      return;
    }

    // Le dernier paiement PENDING de la commande reçoit le code du client
    const payment = await prisma.payment.findFirst({
      where: { orderId, status: PaymentStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      await messageSender.sendText(phone, 'Aucun paiement en attente. Tapez « relancer » pour un nouveau paiement.');
      return;
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        metadata: JSON.stringify({ customerTransactionCode: code, submittedAt: new Date().toISOString() }),
      },
    });

    const order = await orderService.getOrderById(orderId);
    const montant = formatPrice(order?.total ?? 0);

    await messageSender.sendText(
      phone,
      '🙏 Merci ! Votre code a été transmis.\nLa boutique vérifie le paiement — vous serez prévenu dès confirmation.',
    );

    // Envoi DIRECT (pas `notifyMerchant`) : le commerçant DOIT recevoir ce code
    // pour taper VALIDER/REFUSER. Cet envoi passe même si l'interrupteur
    // `notifyMerchantOrders` est à `false`, sans quoi un paiement MODE B ne
    // pourrait jamais être confirmé (argent bloqué).
    const merchantPhone = await configService.getNotifyPhone();
    if (merchantPhone) {
      await messageSender.sendText(
        merchantPhone,
        `💰 Paiement reçu de ${phone} pour commande #${orderId.slice(0, 8)}\n` +
          `Code transaction : ${code}\n` +
          `Montant attendu : ${montant}\n\n` +
          `Tapez *VALIDER ${orderId.slice(0, 8)}* pour confirmer\n` +
          `Tapez *REFUSER ${orderId.slice(0, 8)}* si non reçu`,
      );
    } else {
      logger.warn(`Code transaction ${redactId(code)} (${orderId}) sans numéro commerçant pour validation`);
    }
  }

  /**
   * Validation manuelle du commerçant : « VALIDER {ref} » / « REFUSER {ref} ».
   * @returns true si le message correspond à une validation/refus de paiement.
   */
  async handleMerchantValidation(merchantPhone: string, msg: string): Promise<boolean> {
    const match = msg.trim().match(/^(VALIDER|REFUSER)\s+([0-9a-f]{6,})$/i);
    if (!match) return false;

    const action = match[1].toUpperCase();
    const ref = match[2].toLowerCase();

    const order = (await orderService.getOrderById(ref)) ?? (await orderService.findOrderByIdPrefix(ref));
    if (!order) {
      await messageSender.sendText(merchantPhone, `❓ Commande ${ref} introuvable.`);
      return true;
    }

    // Dernier paiement PENDING (ou FAILED à re-vérifier) de cette commande
    const payment = await prisma.payment.findFirst({
      where: { orderId: order.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] } },
      orderBy: { createdAt: 'desc' },
    });

    if (action === 'VALIDER') {
      if (payment) await updatePaymentStatus(payment.transactionId, PaymentStatus.SUCCESS);
      await orderService.updateOrderStatus(order.id, OrderStatus.CONFIRMED);

      await messageSender.sendText(merchantPhone, `✅ Paiement confirmé pour #${order.id.slice(0, 8)}.`);
      await messageSender.sendText(
        order.phoneNumber,
        `✅ Paiement confirmé ! Merci.\nVotre commande #${order.id.slice(0, 8)} est validée — livraison en cours.`,
      );
      await sessionManager.setState(order.phoneNumber, ConversationStateEnum.COMPLETED);
      logger.info(`Paiement MODE B validé par le commerçant (commande ${redactId(order.id)})`);
      return true;
    }

    // REFUSER
    if (payment) await updatePaymentStatus(payment.transactionId, PaymentStatus.FAILED);
    await messageSender.sendText(merchantPhone, `❌ Paiement refusé pour #${order.id.slice(0, 8)}.`);
    await messageSender.sendText(
      order.phoneNumber,
      `❌ Paiement non reçu pour votre commande #${order.id.slice(0, 8)}.\nVérifiez et renvoyez votre code de transaction, ou tapez « relancer ».`,
    );
    logger.info(`Paiement MODE B refusé par le commerçant (commande ${redactId(order.id)})`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Fonctions utilitaires privées (module-level)
// ---------------------------------------------------------------------------

/** Annule la commande en cours (statut CANCELLED). */
async function cancelPaymentAndOrder(phone: string, orderId?: string): Promise<void> {
  if (!orderId) {
    await sessionManager.setState(phone, ConversationStateEnum.IDLE);
    await messageSender.sendText(phone, 'Aucune commande en cours. Tapez « catalogue » pour commencer.');
    return;
  }
  try {
    await orderService.updateOrderStatus(orderId, OrderStatus.CANCELLED);
  } catch (err) {
    logger.warn(`cancelPaymentAndOrder : ${String(err)}`);
  }
  await sessionManager.setState(phone, ConversationStateEnum.IDLE);
  await messageSender.sendText(phone, 'Paiement annulé. Commande annulée. Tapez « catalogue » pour recommencer.');
}

/**
 * Notifie le commerçant (numéro de notification dédié, sinon MERCHANT_PHONE).
 * Respecte l'interrupteur `notifyMerchantOrders` du dashboard : à `false`,
 * aucune notification n'est envoyée.
 */
async function notifyMerchant(text: string): Promise<void> {
  const cfg = await configService.getConfig();
  if (cfg?.notifyMerchantOrders === false) {
    logger.debug(`Notifications commerçant désactivées — message non envoyé : ${text}`);
    return;
  }
  const merchantPhone = await configService.getNotifyPhone();
  if (!merchantPhone) {
    logger.warn(`Aucun numéro commerçant configuré — notification non envoyée : ${text}`);
    return;
  }
  await messageSender.sendText(merchantPhone, text);
}
