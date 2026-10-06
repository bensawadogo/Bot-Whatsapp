/**
 * AfriBot — ConversationRouter (machine à états).
 *
 * Aiguille chaque message entrant vers le module métier correspondant à
 * l'état de session courant (voir docs/ARCHITECTURE.md — diagramme d'états).
 * Gère aussi les mots-clés globaux disponibles dans tous les états et la
 * détection de blocage : 3 messages non compris consécutifs → escalade humain.
 */
import { logger } from '../config/logger';
import { CatalogModule } from '../modules/catalog/catalog.module';
import { OrderModule } from '../modules/orders/order.module';
import { PaymentModule } from '../modules/payments/payment.module';
import { AgentModule } from '../modules/agents/agent.module';
import { EscalationReason } from '../modules/agents/agent.types';
import { deliveryModule } from '../modules/delivery/delivery.module';
import { isRegisteredLivreur } from '../modules/delivery/delivery.service';
import * as guidedOnboarding from '../modules/onboarding/guided.onboarding';
import { configService } from './config.service';
import { messageSender } from './sender';
import { ConversationStateEnum, sessionManager } from './session';
import { isShopOpen } from './businessHours';

// ---------------------------------------------------------------------------
// Mots-clés globaux (tous états) — minuscules, sans accents
// ---------------------------------------------------------------------------

const KEYWORDS_RESET = ['menu', 'accueil', 'salut', 'bonjour', 'bonsoir', 'salam'];
const KEYWORDS_ESCALATION = ['aide', 'humain', 'agent'];

/** Intentions détectées à l'état IDLE (premier message de la conversation). */
type Intent = 'CATALOG' | 'ORDER' | 'PAYMENT' | 'UNKNOWN';

/** Nombre de messages non compris consécutifs avant escalade (docs/TODO.md Phase 3). */
const MAX_UNKNOWN_BEFORE_ESCALATION = 3;

export class ConversationRouter {
  constructor(
    private readonly catalog = new CatalogModule(),
    private readonly order = new OrderModule(),
    private readonly payment = new PaymentModule(),
    private readonly agent = new AgentModule(),
  ) {}

  /**
   * Point d'entrée unique : route le message selon l'état de session.
   * Appelé par le WebhookController après validation de la signature.
   */
  async route(phone: string, text: string, type: string): Promise<void> {
    const normalized = this.normalize(text);

    // 0. Flux LIVREUR — séparé de la machine à états client (MODULE 1.3).
    //    Les livreurs ne passent JAMAIS par les états client (catalogue,
    //    commande...) : leurs réponses OUI/NON/LIVRÉ vont au DeliveryModule.
    if (await this.isLivreur(phone)) {
      logger.debug(`Message livreur ${phone} → DeliveryModule`);
      await deliveryModule.handleLivreurResponse(phone, text);
      return;
    }

    // 0bis. Onboarding commerçant guidé par bot (MODULE 4 — chemin B).
    //       Déclenché par « ACTIVER » ; continue tant que l'état est ONBOARDING_*.
    const currentSession = await sessionManager.getSession(phone);
    if (normalized === 'activer' || guidedOnboarding.isOnboardingState(currentSession.state)) {
      await guidedOnboarding.handle(phone, text);
      return;
    }

    // 0ter. Messages du COMMERÇANT : validation manuelle des paiements MODE B
    //       (« VALIDER 1a2b3c4d » / « REFUSER 1a2b3c4d ») — MODULE 2.
    const notifyPhone = await configService.getNotifyPhone();
    if (notifyPhone && phone === notifyPhone && /valid[ae]r|refus[ae]r/i.test(text)) {
      const handled = await this.payment.handleMerchantValidation(phone, text);
      if (handled) return;
    }

    // 1. Mots-clés globaux — prioritaires sur l'état courant
    if (KEYWORDS_RESET.includes(normalized)) {
      await sessionManager.setState(phone, ConversationStateEnum.IDLE);
      await sessionManager.resetUnknownCount(phone);
      await this.sendMainMenu(phone);
      return;
    }
    if (KEYWORDS_ESCALATION.includes(normalized)) {
      await this.agent.escalateToHuman(phone, EscalationReason.USER_REQUEST);
      return;
    }

    // 2. Routage selon l'état courant
    const session = await sessionManager.getSession(phone);
    logger.debug(`Routage ${phone} [${session.state}] type=${type ?? 'text'}`);

    // 2bis. Horaires commerçant : à l'état IDLE hors heures, message « fermé ».
    // Un flow déjà engagé (commande en cours, escalade...) n'est jamais coupé.
    if (session.state === ConversationStateEnum.IDLE) {
      const merchantConfig = await configService.getConfig();
      if (!isShopOpen(new Date(), merchantConfig)) {
        await this.sendClosedMessage(phone, merchantConfig);
        return;
      }
    }

    switch (session.state) {
      case ConversationStateEnum.IDLE:
        await this.handleIdle(phone, normalized, text);
        break;
      case ConversationStateEnum.BROWSING_CATALOG:
        await sessionManager.resetUnknownCount(phone);
        await this.catalog.handle(phone, text);
        break;
      case ConversationStateEnum.ORDERING:
        await sessionManager.resetUnknownCount(phone);
        await this.order.handle(phone, text, session);
        break;
      case ConversationStateEnum.AWAITING_PAYMENT:
        await sessionManager.resetUnknownCount(phone);
        await this.payment.handle(phone, text, session);
        break;
      case ConversationStateEnum.COMPLETED:
        // Remerciement puis retour à l'accueil
        await messageSender.sendText(phone, 'Merci pour votre commande ! Tapez "menu" pour recommencer.');
        await sessionManager.setState(phone, ConversationStateEnum.IDLE);
        break;
      case ConversationStateEnum.AGENT_ESCALATION:
        await this.agent.handle(phone, text);
        break;
    }
  }

  /**
   * État IDLE : détection d'intention sur le premier message.
   * CATALOG → BROWSING_CATALOG ; ORDER/PAYMENT → guidance ;
   * UNKNOWN → menu d'accueil + compteur de blocage (3 → escalade).
   */
  private async handleIdle(phone: string, normalized: string, text: string): Promise<void> {
    const intent = this.detectIntent(normalized);

    switch (intent) {
      case 'CATALOG': {
        await sessionManager.setState(phone, ConversationStateEnum.BROWSING_CATALOG);
        await sessionManager.resetUnknownCount(phone);
        await this.catalog.handle(phone, normalized);
        return;
      }
      case 'ORDER':
      case 'PAYMENT': {
        await sessionManager.resetUnknownCount(phone);
        await messageSender.sendText(
          phone,
          'Pour commander, tapez d\u2019abord \u00ab catalogue \u00bb pour voir nos produits, puis r\u00e9pondez avec le num\u00e9ro du produit qui vous int\u00e9resse.',
        );
        return;
      }
      case 'UNKNOWN':
      default:
        break;
    }

    // Feedback de livraison (« REÇU » / « PROBLÈME ») après une livraison —
    // consommé silencieusement (MODULE 1, boucle de clôture).
    const feedbackConsumed = await deliveryModule.handleCustomerDeliveryFeedback(phone, text);
    if (feedbackConsumed) {
      await sessionManager.resetUnknownCount(phone);
      return;
    }

    // Message non compris : menu d'accueil + compteur de blocage
    await this.sendMainMenu(phone);
    const unknownCount = await sessionManager.incrementUnknownCount(phone);
    if (unknownCount >= MAX_UNKNOWN_BEFORE_ESCALATION) {
      await messageSender.sendText(phone, 'Je n\u2019ai pas bien compris. Je vous transf\u00e8re \u00e0 un agent humain.');
      await this.agent.escalateToHuman(phone, EscalationReason.BOT_STUCK);
    }
  }

  /**
   * Ce numéro est-il un livreur enregistré ? (MODULE 1.3)
   * Délègue au service, qui met en cache Redis 5 min (clé `{prefix}livreur:{phone}`).
   */
  async isLivreur(phone: string): Promise<boolean> {
    return isRegisteredLivreur(phone);
  }

  /** Menu principal — texte simple numéroté (lisible en 2G, sans boutons lourds). */
  private async sendMainMenu(phone: string): Promise<void> {
    await messageSender.sendText(
      phone,
      [
        'Bienvenue chez notre boutique ! \ud83d\udc4b',
        '',
        '1. \u00ab catalogue \u00bb \u2014 voir les produits et prix',
        '2. \u00ab commander \u00bb \u2014 passer une commande',
        '3. \u00ab aide \u00bb \u2014 parler \u00e0 un agent humain',
        '',
        '\u00c0 tout moment : \u00ab menu \u00bb pour revenir ici.',
      ].join('\n'),
    );
  }

  /** Message boutique fermée (horaires Phase 6) — informatif, urgence possible. */
  private async sendClosedMessage(phone: string, merchantConfig: Awaited<ReturnType<typeof configService.getConfig>>): Promise<void> {
    const { openHour, closeHour, closedMessage } = merchantConfig;
    const hours =
      openHour !== undefined && closeHour !== undefined
        ? `Nos horaires : ${String(openHour).padStart(2, '0')}h — ${String(closeHour).padStart(2, '0')}h.`
        : '';
    const message =
      closedMessage?.trim() ||
      [
        '🛍 La boutique est fermée pour le moment.',
        hours,
        'Vous pourrez commander dès l’ouverture — tapez « menu ».',
        'Urgence ? Tapez « aide » pour parler à un agent.',
      ]
        .filter(Boolean)
        .join('\n');
    await messageSender.sendText(phone, message);
  }

  /**
   * Détection d'intention à l'état IDLE.
   * Mots-clés français courants + variantes sans accents (SMS / fautes
   * fréquentes) — les langues locales (wolof, dioula...) seront ajoutées en
   * Phase 6 (docs/TODO.md).
   */
  private detectIntent(normalized: string): Intent {
    const words = normalized.split(/\s+/);

    // Catalogue : "catalogue", "produits", prix/dispo ("c'est combien ?"...)
    const catalogKeywords = [
      'catalogue', 'produits', 'produit', 'prix', 'stock', 'dispo',
      'combien', 'cout', 'coute', 'voir', 'list', 'liste',
    ];
    if (catalogKeywords.some((kw) => words.includes(kw) || normalized.includes(kw))) {
      return 'CATALOG';
    }

    // Commande : "commander", "acheter", "je veux"...
    const orderKeywords = ['commander', 'commande', 'acheter', 'achate', 'veut', 'veux'];
    if (orderKeywords.some((kw) => words.includes(kw))) {
      return 'ORDER';
    }

    // Paiement : "payer", "wave", "orange money", "mtn", "moov"...
    const paymentKeywords = ['payer', 'paiement', 'payment', 'mobile', 'money', 'wave', 'mtn', 'moov', 'orange'];
    if (paymentKeywords.some((kw) => words.includes(kw) || normalized.includes(kw))) {
      return 'PAYMENT';
    }

    return 'UNKNOWN';
  }

  /** Normalisation : minuscules, trim, accents retirés, "?" retiré (tolérant SMS/2G). */
  private normalize(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\?/g, '');
  }
}

// Instance partagée — un seul router pour toute l'application
export const conversationRouter = new ConversationRouter();
