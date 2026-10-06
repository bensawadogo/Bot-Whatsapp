/**
 * AfriBot — module livraison (MODULE 1).
 *
 * Flux complet via WhatsApp, du côté LIVREUR (numéro séparé) :
 *
 *   commerçant (dashboard) ──assignDelivery──▶ message au livreur
 *   livreur « OUI »  ──▶ PICKED_UP → client : « votre commande est en route »
 *   livreur « NON »  ──▶ FAILED    → alerte commerçant (réassignation manuelle)
 *   livreur « LIVRÉ <ref> » ──▶ DELIVERED → Order PAID + Payment SUCCESS (COD)
 *   client « REÇU »      ──▶ clôture propre
 *   client « PROBLÈME »  ──▶ escalade automatique vers un agent humain
 *
 * Le livreur a son PROPRE flux : le ConversationRouter l'aiguille ici AVANT
 * la machine à états client (voir `isLivreur()`), donc aucun de ces messages
 * ne touche la session Redis du client.
 */
import { logger } from '../../config/logger';
import { formatPrice } from '../../shared/format';
import { messageSender } from '../../shared/sender';
import { configService } from '../../shared/config.service';
import { ConversationStateEnum, sessionManager } from '../../shared/session';
import { AgentModule } from '../agents/agent.module';
import { EscalationReason } from '../agents/agent.types';
import * as orderService from '../orders/order.service';
import { OrderStatus } from '../orders/order.types';
import { settleCODPayment } from '../payments/payment.service';

import * as deliveryService from './delivery.service';
import {
  DELIVERY_STATUS_LABELS,
  DeliveryStatus,
  type AssignDeliveryOptions,
  type Delivery,
} from './delivery.types';

/** Réponses du livreur acceptant une course. */
const ACCEPT_KEYWORDS = ['oui', 'ok', 'accepte', 'accepté', 'd accord', "d'accord", '1'];
/** Réponses du livreur refusant une course. */
const REFUSE_KEYWORDS = ['non', 'refuse', 'refusé', '2'];

export class DeliveryModule {
  private readonly agent = new AgentModule();

  // -------------------------------------------------------------------------
  // 1) Assignation d'une livraison
  // -------------------------------------------------------------------------

  /**
   * Crée la livraison puis envoie la demande au livreur par WhatsApp.
   *
   * @param orderId Commande à livrer.
   * @param target  Livreur cible : `livreurId` (dashboard) OU `livreurPhone`.
   * @param options Minutes estimées / note interne (facultatif).
   */
  async assignDelivery(
    orderId: string,
    target: { livreurId?: string | undefined; livreurPhone?: string | undefined },
    options: AssignDeliveryOptions = {},
  ): Promise<Delivery | null> {
    const order = await orderService.getOrderById(orderId);
    if (!order) {
      logger.warn(`assignDelivery : commande ${orderId} introuvable`);
      return null;
    }

    // Résolution du livreur (par id depuis le dashboard, par numéro sinon)
    const merchant = await configService.getConfig();
    const livreurs = await deliveryService.listLivreurs(merchant.merchantId);
    const phone = deliveryService.normalizePhone(target.livreurPhone ?? '');
    const livreur = target.livreurId
      ? livreurs.find((l) => l.id === target.livreurId) ?? null
      : livreurs.find((l) => l.phone === phone) ?? null;

    if (!livreur) {
      logger.warn(
        `assignDelivery : livreur introuvable (${target.livreurId ?? target.livreurPhone ?? 'aucun'})`,
      );
      return null;
    }

    // Montant à collecter : uniquement si la commande n'est pas déjà payée
    const codAmount = order.status === OrderStatus.PAID ? null : order.total;

    const delivery = await deliveryService.upsertAssignedDelivery({
      orderId: order.id,
      customerPhone: order.phoneNumber,
      deliveryAddress: order.address,
      livreurId: livreur.id,
      livreurPhone: livreur.phone,
      codAmount,
      options,
    });

    // Message WhatsApp au LIVREUR (adresse, montant, référence courte)
    const ref = order.id.slice(0, 8);
    const zone = livreur.zone ? `\nZone : ${livreur.zone}` : '';
    const temps = options.estimatedTime ? `\nTemps estimé : ${options.estimatedTime} min` : '';
    await messageSender.sendText(
      livreur.phone,
      `📦 Nouvelle livraison #${ref}\n` +
        `Client : ${order.phoneNumber}\n` +
        `Adresse : ${order.address}${zone}${temps}\n` +
        `Montant à collecter : ${formatPrice(codAmount ?? 0)}\n\n` +
        `Tapez *OUI* pour accepter\nTapez *NON* pour refuser`,
    );

    logger.info(`Livraison #${ref} proposée à ${livreur.name} (${livreur.phone})`);
    return delivery;
  }

  // -------------------------------------------------------------------------
  // 2) Réponses du livreur (OUI / NON / DISPO / EN ROUTE)
  // -------------------------------------------------------------------------

  /** Point d'entrée unique pour tout message venant d'un numéro de livreur. */
  async handleLivreurResponse(livreurPhone: string, message: string): Promise<void> {
    const normalized = message.trim().toLowerCase();

    // Disponibilité : « DISPO » / « INDISPO » (voir POST /api/config/livreur).
    // « DISPO » sert AUSSI de « où en est ma course ? » : tous les autres
    // messages du module renvoient le livreur vers *DISPO* pour retrouver sa
    // course active — on ne laisse donc jamais un livreur sans réponse.
    if (['dispo', 'disponible'].includes(normalized)) {
      await deliveryService.setLivreurAvailability(livreurPhone, true);
      await messageSender.sendText(livreurPhone, '✅ Vous êtes noté disponible. Merci !');
      await this.sendActiveCourse(livreurPhone);
      return;
    }
    if (['indispo', 'indisponible', 'pause'].includes(normalized)) {
      await deliveryService.setLivreurAvailability(livreurPhone, false);
      await messageSender.sendText(
        livreurPhone,
        '👍 Vous êtes noté indisponible. Tapez *DISPO* à tout moment.',
      );
      return;
    }

    // Guide rapide : « AIDE » (le routeur aiguille les livreurs ici AVANT les
    // mots-clés globaux, donc « aide » n'ouvre PAS l'escalade humaine ici).
    if (['aide', 'help'].includes(normalized)) {
      await this.sendLivreurHelp(livreurPhone);
      return;
    }

    // Confirmation de livraison : « LIVRÉ <référence> »
    if (/^livr(é|e|ée)?\b/.test(normalized)) {
      await this.confirmDelivery(livreurPhone, deliveryService.extractOrderIdReference(message) ?? '');
      return;
    }

    // Statut intermédiaire : « EN ROUTE »
    if (normalized.includes('en route') || normalized === '3') {
      await this.markEnRoute(livreurPhone);
      return;
    }

    // Acceptation / refus de la course proposée
    const active = await deliveryService.findActiveDeliveryForLivreur(livreurPhone);
    if (!active) {
      await messageSender.sendText(
        livreurPhone,
        'Aucune livraison en attente de votre part.\nTapez *DISPO* si vous êtes disponible.',
      );
      return;
    }

    if (ACCEPT_KEYWORDS.includes(normalized)) {
      await this.acceptDelivery(livreurPhone, active);
      return;
    }
    if (REFUSE_KEYWORDS.includes(normalized)) {
      await this.refuseDelivery(livreurPhone, active);
      return;
    }

    // Message non reconnu → rappel des commandes simples
    await messageSender.sendText(
      livreurPhone,
      `Commande #${active.orderId.slice(0, 8)} en attente de votre réponse.\n` +
        `*OUI* pour accepter — *NON* pour refuser.\n` +
        `Une fois livrée : tapez *LIVRÉ ${active.orderId.slice(0, 8)}*`,
    );
  }

  /** Le livreur accepte : ASSIGNED → PICKED_UP puis le client est prévenu. */
  private async acceptDelivery(livreurPhone: string, delivery: Delivery): Promise<void> {
    await deliveryService.updateDeliveryStatus(delivery.id, DeliveryStatus.PICKED_UP);

    const order = await orderService.getOrderById(delivery.orderId);
    if (order && order.status === OrderStatus.PENDING) {
      await orderService.updateOrderStatus(order.id, OrderStatus.CONFIRMED);
    }

    const livreur = await deliveryService.findLivreurByPhone(livreurPhone);
    const nom = livreur?.name ?? 'Votre livreur';

    // Notification CLIENT : commande en route + montant à préparer
    await messageSender.sendText(
      delivery.customerPhone,
      `🚗 Votre commande est en route !\n\n` +
        `Livreur : ${nom}\n` +
        `Vous serez contacté à votre arrivée.\n` +
        `Paiement à la livraison : ${formatPrice(delivery.codAmount ?? 0)}`,
    );

    await messageSender.sendText(
      livreurPhone,
      `✅ Course acceptée — commande #${delivery.orderId.slice(0, 8)}.\n` +
        `Adresse : ${delivery.deliveryAddress}\n` +
        `À collecter : ${formatPrice(delivery.codAmount ?? 0)}\n\n` +
        `À l'arrivée tapez : *LIVRÉ ${delivery.orderId.slice(0, 8)}*`,
    );

    logger.info(`Livraison ${delivery.id} acceptée par ${nom} → client notifié`);
  }

  /** Le livreur refuse : statut FAILED + alerte du commerçant. */
  private async refuseDelivery(livreurPhone: string, delivery: Delivery): Promise<void> {
    await deliveryService.updateDeliveryStatus(delivery.id, DeliveryStatus.FAILED, {
      failureReason: 'Refusée par le livreur',
    });

    const livreur = await deliveryService.findLivreurByPhone(livreurPhone);
    const nom = livreur?.name ?? 'Un livreur';
    const ref = delivery.orderId.slice(0, 8);

    // Le livreur est prévenu qu'il n'a plus la course
    await messageSender.sendText(
      livreurPhone,
      `Course #${ref} refusée. Tapez *DISPO* si vous êtes disponible.`,
    );

    // Alerte du COMMERÇANT : réassignation manuelle depuis le dashboard.
    // Envoi DIRECT (pas `notifyMerchant`) : cet avertissement exige une action
    // du commerçant (la course est bloquée), il doit donc partir même si
    // l'interrupteur `notifyMerchantOrders` est à `false` — sinon la livraison
    // échouerait sans que personne ne soit prévenu.
    const merchantPhone = await configService.getNotifyPhone();
    if (merchantPhone) {
      await messageSender.sendText(
        merchantPhone,
        `⚠️ Le livreur ${nom} a refusé la commande #${ref}\n` +
          `Réassignez manuellement depuis le dashboard`,
      );
    } else {
      logger.warn(`Commande #${ref} refusée par ${nom} — aucun numéro commerçant configuré`);
    }

    logger.info(`Livraison ${delivery.id} refusée par ${nom} → FAILED`);
  }

  // -------------------------------------------------------------------------
  // 3) Confirmation de livraison (COD)
  // -------------------------------------------------------------------------

  /** Le livreur tape « LIVRÉ {orderId} » (ou sa référence courte à 8 caractères). */
  async confirmDelivery(livreurPhone: string, orderId: string): Promise<void> {
    const reference = orderId.trim().toLowerCase();
    if (!reference) {
      const active = await deliveryService.findActiveDeliveryForLivreur(livreurPhone);
      await messageSender.sendText(
        livreurPhone,
        `Indiquez la commande : *LIVRÉ ${active?.orderId.slice(0, 8) ?? '12345678'}*`,
      );
      return;
    }

    // Résolution par référence courte (le livreur ne connaît que 8 caractères)
    let delivery = await deliveryService.findDeliveryForLivreur(livreurPhone, reference);
    if (!delivery) {
      const active = await deliveryService.findActiveDeliveryForLivreur(livreurPhone);
      if (active && active.orderId.slice(0, 8) === reference) delivery = active;
    }

    if (!delivery) {
      await messageSender.sendText(
        livreurPhone,
        `Commande #${reference} introuvable pour vous.\nTapez *DISPO* pour voir votre course en cours.`,
      );
      return;
    }

    // Livraison déjà clôturée → réponse idempotente (rejeu du message)
    if (delivery.status === DeliveryStatus.DELIVERED) {
      await messageSender.sendText(
        livreurPhone,
        `Livraison #${reference} déjà enregistrée. Tapez *DISPO* pour la prochaine course.`,
      );
      return;
    }

    // 1) Livraison → DELIVERED (COD collecté à la main par le livreur)
    await deliveryService.updateDeliveryStatus(delivery.id, DeliveryStatus.DELIVERED, {
      deliveredAt: new Date(),
      codCollected: delivery.codAmount !== null && delivery.codAmount > 0,
    });

    // 2) COD → paiement SUCCESS + commande PAID (traçabilité comptable)
    if (delivery.codAmount !== null && delivery.codAmount > 0) {
      await this.settleCodPayment(delivery);
    }

    // Compteur du livreur (tableau de bord)
    if (delivery.livreurId) {
      await deliveryService.incrementLivreurDeliveries(delivery.livreurId);
    }

    const order = await orderService.getOrderById(delivery.orderId);
    const ref = delivery.orderId.slice(0, 8);
    const montant = formatPrice(delivery.codAmount ?? order?.total ?? 0);

    // 3) Message au CLIENT : confirmation + boucle de feedback
    await messageSender.sendText(
      delivery.customerPhone,
      `✅ Commande livrée ! Merci.\n\n` +
        `Tapez *REÇU* pour confirmer la réception\n` +
        `ou *PROBLÈME* si souci`,
    );

    // 4) Le commerçant sait que l'argent est rentré
    await this.notifyMerchant(`✅ Commande #${ref} livrée et ${montant} collectés`);

    await messageSender.sendText(
      livreurPhone,
      `✅ Livraison #${ref} enregistrée. Merci !\nTapez *DISPO* pour la prochaine course.`,
    );

    logger.info(`Livraison ${delivery.id} livrée (commande ${ref}, ${montant})`);
  }

  /** Enregistre le paiement COD en SUCCESS et passe la commande en PAID. */
  private async settleCodPayment(delivery: Delivery): Promise<void> {
    const order = await orderService.getOrderById(delivery.orderId);
    if (!order) return;
    await settleCODPayment(delivery.id, order.id, delivery.codAmount ?? order.total);
  }

  // -------------------------------------------------------------------------
  // 4) Feedback client après livraison (REÇU / PROBLÈME)
  // -------------------------------------------------------------------------

  /**
   * Traite « REÇU » (clôture propre) ou « PROBLÈME » (escalade agent humain).
   *
   * @returns true si le message a été consommé par ce flux (le router arrête là).
   */
  async handleCustomerDeliveryFeedback(phone: string, msg: string): Promise<boolean> {
    const normalized = msg.trim().toLowerCase();

    if (['reçu', 'recu', 'réception', 'reception', 'bien recu', 'bien reçu'].includes(normalized)) {
      const delivery = await this.findLatestDeliveryForCustomer(phone);
      logger.info(
        `Client ${phone} confirme la réception${delivery ? ` (commande ${delivery.orderId.slice(0, 8)})` : ''}`,
      );
      await messageSender.sendText(
        phone,
        '🙏 Merci pour votre confirmation ! À très bientôt.\nTapez *catalogue* pour recommander.',
      );
      await sessionManager.setState(phone, ConversationStateEnum.IDLE);
      return true;
    }

    if (['problème', 'probleme', 'pb', 'souci', 'litige'].includes(normalized)) {
      const delivery = await this.findLatestDeliveryForCustomer(phone);
      logger.warn(
        `Problème signalé par ${phone}${delivery ? ` sur la commande ${delivery.orderId.slice(0, 8)}` : ''}`,
      );
      await messageSender.sendText(
        phone,
        '😔 Désolé pour ce désagrément. Un agent va vous contacter rapidement.\n' +
          'Vous pouvez aussi taper *humain* à tout moment.',
      );

      // Escalade automatique vers un agent humain (Chatwoot)
      await this.agent.escalateToHuman(phone, EscalationReason.COMPLAINT);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // 5) Mises à jour depuis le dashboard (PATCH /api/delivery/:id/status)
  // -------------------------------------------------------------------------

  /**
   * Change le statut d'une livraison depuis le dashboard et notifie
   * automatiquement le client (et le commerçant en cas d'échec).
   */
  async updateStatusFromDashboard(deliveryId: string, status: DeliveryStatus): Promise<Delivery | null> {
    const delivery = await deliveryService.getDeliveryById(deliveryId);
    if (!delivery) return null;

    // DELIVERED passe par le flux complet (COD → PAID + notifications client)
    if (status === DeliveryStatus.DELIVERED) {
      await this.confirmDelivery(delivery.livreurPhone ?? '', delivery.orderId);
      return deliveryService.getDeliveryById(deliveryId);
    }

    const updated = await deliveryService.updateDeliveryStatus(deliveryId, status, {
      ...(status === DeliveryStatus.FAILED && {
        failureReason: 'Échec signalé depuis le dashboard',
      }),
    });
    if (!updated) return null;

    const ref = delivery.orderId.slice(0, 8);
    const label = DELIVERY_STATUS_LABELS[status];

    // Le client suit l'avancement (PENDING = état purement interne)
    if (status !== DeliveryStatus.PENDING) {
      await messageSender.sendText(delivery.customerPhone, `${label} — commande #${ref}`);
    }
    if (status === DeliveryStatus.FAILED) {
      await this.notifyMerchant(`⚠️ Livraison #${ref} en échec — intervention manuelle nécessaire.`);
    }

    return updated;
  }

  // -------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------

  /**
   * Rappelle au livreur sa course ACTIVE (statut, client, adresse, montant).
   * Appelé après « DISPO » : sans course, le livreur reçoit un message
   * d'attente — jamais de silence.
   */
  private async sendActiveCourse(livreurPhone: string): Promise<void> {
    const active = await deliveryService.findActiveDeliveryForLivreur(livreurPhone);
    if (!active) {
      await messageSender.sendText(
        livreurPhone,
        "Aucune course en cours pour le moment — vous serez prévenu dès qu'une livraison vous est proposée.\n" +
          'Tapez *AIDE* pour revoir les commandes du livreur.',
      );
      return;
    }

    const ref = active.orderId.slice(0, 8);
    const suite =
      active.status === DeliveryStatus.ASSIGNED
        ? 'Répondez *OUI* pour accepter — *NON* pour refuser.'
        : `À l'arrivée tapez *LIVRÉ ${ref}*`;

    await messageSender.sendText(
      livreurPhone,
      `📦 Course en cours — commande #${ref}\n` +
        `Statut : ${DELIVERY_STATUS_LABELS[active.status]}\n` +
        `Client : ${active.customerPhone}\n` +
        `Adresse : ${active.deliveryAddress}\n` +
        `À collecter : ${formatPrice(active.codAmount ?? 0)}\n\n` +
        suite,
    );
  }

  /** Guide des commandes du livreur (envoyé sur « AIDE »). */
  private async sendLivreurHelp(livreurPhone: string): Promise<void> {
    await messageSender.sendText(
      livreurPhone,
      [
        '🛵 *Guide du livreur*',
        '',
        '*DISPO* — je suis disponible (affiche ma course en cours)',
        '*INDISPO* — je fais une pause',
        '*OUI* — j’accepte la course proposée',
        '*NON* — je refuse la course proposée',
        '*EN ROUTE* — je pars vers le client',
        '*LIVRÉ <référence>* — colis remis et encaissé',
        '',
        'Tapez *AIDE* à tout moment pour revoir ce guide.',
      ].join('\n'),
    );
  }

  /**
   * Le livreur signale « EN ROUTE » (statut intermédiaire, avant l'arrivée).
   */
  private async markEnRoute(livreurPhone: string): Promise<void> {
    const active = await deliveryService.findActiveDeliveryForLivreur(livreurPhone);
    if (!active) {
      await messageSender.sendText(livreurPhone, 'Aucune livraison en cours.');
      return;
    }
    await deliveryService.updateDeliveryStatus(active.id, DeliveryStatus.EN_ROUTE);
    await messageSender.sendText(livreurPhone, '🧭 Statut « en route » enregistré.');
    await messageSender.sendText(
      active.customerPhone,
      `🚗 Votre commande #${active.orderId.slice(0, 8)} arrive bientôt. Préparez le paiement.`,
    );
  }

  /**
   * Notifie le commerçant (numéro dédié, sinon MERCHANT_PHONE du .env).
   *
   * Respecte l'interrupteur `notifyMerchantOrders` du dashboard : à `false`,
   * le commerçant ne reçoit plus aucune notification. Lecture défensive —
   * une config partielle ne doit jamais bloquer l'envoi.
   */
  private async notifyMerchant(text: string): Promise<void> {
    const cfg = await configService.getConfig();
    if (cfg?.notifyMerchantOrders === false) {
      logger.debug(`Notifications commerçant désactivées — message non envoyé : ${text}`);
      return;
    }
    const phone = await configService.getNotifyPhone();
    if (!phone) {
      logger.warn(`Aucun numéro commerçant configuré — notification non envoyée : ${text}`);
      return;
    }
    await messageSender.sendText(phone, text);
  }

  /** Dernière livraison connue d'un client (feedback / litige). */
  private async findLatestDeliveryForCustomer(phone: string): Promise<Delivery | null> {
    const page = await orderService.listOrders({ phoneNumber: phone, limit: 1 });
    const latest = page.orders[0];
    if (!latest) return null;
    return deliveryService.getDeliveryByOrderId(latest.id);
  }
}

/** Instance partagée (routers API + ConversationRouter). */
export const deliveryModule = new DeliveryModule();