/**
 * AfriBot — module commandes (flow conversationnel + panier multi-produits).
 *
 * Sous-états internes (persistés en session Redis — survivent aux
 * redémarrages) :
 *   SELECT_QUANTITY → CART_REVIEW → CONFIRM_ADDRESS → CONFIRM_ORDER
 *   → COD (confirmation immédiate) ou Mobile Money (paiement Phase 2).
 * « annuler » est disponible à chaque sous-état.
 *
 * Le panier (`session.cart`) est la source de vérité : chaque produit
 * sélectionné y est ajouté (quantité fusionnée si déjà présent). Les prix
 * sont figés à l'ajout (anti-surprise si le commerçant change un tarif).
 */
import { logger } from '../../config/logger';
import { messageSender } from '../../shared/sender';
import { configService } from '../../shared/config.service';
import { ConversationStateEnum, sessionManager, type ConversationState } from '../../shared/session';
import * as catalogService from '../catalog/catalog.service';
import { formatPrice } from '../../shared/format';
import { PaymentModule } from '../payments/payment.module';
import * as orderService from './order.service';
import { trackCampaignConversion } from '../campaigns/campaign.service';
import { OrderFlowState, OrderStatus, PaymentMethod, type CartItem } from './order.types';

const PROCESSING_ORDER = 'PROCESSING_ORDER';

const orderProcessing = new Map<string, Promise<void>>();

export class OrderModule {
  private readonly payment = new PaymentModule();

  /** Point d'entrée du module pour un message en état ORDERING. */
  async handle(phone: string, message: string, session: ConversationState): Promise<void> {
    const normalized = message.trim().toLowerCase();

    // « annuler » disponible à tout sous-état
    if (normalized === 'annuler' || normalized === 'cancel') {
      await this.cancelOrder(phone);
      return;
    }

    switch (session.orderFlow) {
      case OrderFlowState.SELECT_QUANTITY:
        await this.handleQuantity(phone, normalized);
        break;
      case OrderFlowState.CART_REVIEW:
        await this.handleCartReview(phone, normalized);
        break;
      case OrderFlowState.CONFIRM_ADDRESS:
        await this.handleAddress(phone, message);
        break;
      case OrderFlowState.CONFIRM_ORDER:
        await this.handleConfirmation(phone, normalized);
        break;
      case PROCESSING_ORDER:
        await messageSender.sendText(phone, 'Une commande est en cours de traitement, patientez quelques secondes.');
        break;
      default:
        await this.resetFlow(phone, 'Recommençons : tapez « catalogue » et choisissez un produit.');
        break;
    }
  }

  /** Sous-état SELECT_QUANTITY : lecture de la quantité puis ajout au panier. */
  private async handleQuantity(phone: string, normalized: string): Promise<void> {
    const quantity = parseInt(normalized, 10);
    if (Number.isNaN(quantity) || quantity <= 0 || quantity > 99) {
      await messageSender.sendText(phone, 'Tapez un nombre entre 1 et 99 (ou « annuler »).');
      return;
    }

    const session = await sessionManager.getSession(phone);
    if (!session.pendingProductId) {
      await this.resetFlow(phone, 'Session expirée. Tapez « catalogue » pour recommencer.');
      return;
    }

    const product = await catalogService.getProductById(session.pendingProductId);
    if (!product || product.stock < quantity) {
      await this.resetFlow(
        phone,
        `Désolé, « ${product?.name ?? 'ce produit'} » n'est plus disponible en cette quantité. Tapez « catalogue ».`,
      );
      return;
    }

    await this.addToCart(phone, {
      productId: product.id,
      name: product.name,
      quantity,
      unitPrice: product.price,
    });
    await sessionManager.updateSession(phone, { orderFlow: OrderFlowState.CART_REVIEW });
    await this.showCart(phone);
  }

  /** Ajoute une ligne au panier (fusion de quantité si le produit y est déjà). */
  private async addToCart(phone: string, item: CartItem): Promise<void> {
    const session = await sessionManager.getSession(phone);
    const cart: CartItem[] = session.cart ?? [];
    const existing = cart.find((c) => c.productId === item.productId);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      cart.push(item);
    }
    await sessionManager.updateSession(phone, { cart });
  }

  /** Total du panier en FCFA (somme des lignes à prix figé). */
  private cartTotal(cart: CartItem[]): number {
    return cart.reduce((sum, c) => sum + c.quantity * c.unitPrice, 0);
  }

  /** Sous-état CART_REVIEW : « commander », « ajouter », « retirer N », « vider ». */
  private async handleCartReview(phone: string, normalized: string): Promise<void> {
    const session = await sessionManager.getSession(phone);
    const cart = session.cart ?? [];

    if (normalized === 'commander' || normalized === '1') {
      if (cart.length === 0) {
        await messageSender.sendText(phone, 'Votre panier est vide. Tapez « catalogue » pour choisir un produit.');
        return;
      }
      await sessionManager.updateSession(phone, { orderFlow: OrderFlowState.CONFIRM_ADDRESS });
      await messageSender.sendText(
        phone,
        'Quelle est l\u2019adresse de livraison ? (quartier, ville, point de repère)',
      );
      return;
    }

    if (normalized === 'ajouter' || normalized === 'catalogue') {
      // Retour au catalogue sans perdre le panier en cours.
      await sessionManager.setState(phone, ConversationStateEnum.BROWSING_CATALOG);
      await messageSender.sendText(
        phone,
        'Tapez « catalogue » puis le numéro d\u2019un produit pour l\u2019ajouter au panier.',
      );
      return;
    }

    if (normalized === 'vider') {
      await sessionManager.updateSession(phone, { cart: [] });
      await messageSender.sendText(phone, 'Panier vidé. Tapez « catalogue » pour recommencer.');
      return;
    }

    // « modifier 2 3 » (ou « modifier 2 x3 ») → quantité de la ligne 2 = 3
    const editMatch = normalized.match(/^modifier\s+(\d{1,2})\s+(?:x)?(\d{1,2})$/);
    if (editMatch) {
      const index = parseInt(editMatch[1], 10) - 1;
      const quantity = parseInt(editMatch[2], 10);
      if (index < 0 || index >= cart.length || quantity < 1 || quantity > 99) {
        await messageSender.sendText(phone, 'Format : « modifier N Q » (ex : « modifier 2 3 »), Q entre 1 et 99.');
        return;
      }
      // Re-vérifie le stock au moment de la modification (il peut avoir changé)
      const product = await catalogService.getProductById(cart[index].productId);
      if (!product || product.stock < quantity) {
        await messageSender.sendText(
          phone,
          `Désolé, « ${product?.name ?? 'ce produit'} » n'est pas disponible en ${quantity} exemplaire(s).`,
        );
        return;
      }
      cart[index].quantity = quantity;
      await sessionManager.updateSession(phone, { cart });
      await this.showCart(phone);
      return;
    }

    // « retirer 2 » → supprime la 2e ligne affichée
    const removeMatch = normalized.match(/^retirer\s+(\d{1,2})$/);
    if (removeMatch) {
      const index = parseInt(removeMatch[1], 10) - 1;
      if (index < 0 || index >= cart.length) {
        await this.showCart(phone);
        return;
      }
      cart.splice(index, 1);
      await sessionManager.updateSession(phone, { cart });
      await this.showCart(phone);
      return;
    }

    await this.showCart(phone);
  }

  /** Affiche le panier avec numéros de lignes, quantités et total. */
  private async showCart(phone: string): Promise<void> {
    const session = await sessionManager.getSession(phone);
    const cart = session.cart ?? [];

    if (cart.length === 0) {
      await messageSender.sendText(phone, 'Votre panier est vide. Tapez « catalogue » pour choisir un produit.');
      return;
    }

    const lines = cart.map((c, i) => `${i + 1}. ${c.name} x${c.quantity} — ${formatPrice(c.unitPrice * c.quantity)}`);
    const text = [
      '\uD83D\uDED2 Votre panier :',
      ...lines,
      `Total : ${formatPrice(this.cartTotal(cart))}`,
      '',
      '« commander » pour valider, « ajouter » pour un autre produit,',
      '« modifier N Q » pour changer une quantité, « retirer N » pour enlever',
      'une ligne, « vider » pour tout effacer.',
    ].join('\n');
    await messageSender.sendText(phone, text);
  }

  /** Sous-état CONFIRM_ADDRESS : enregistre l'adresse puis affiche le récapitulatif. */
  private async handleAddress(phone: string, message: string): Promise<void> {
    const address = message.trim();
    if (address.length < 5) {
      await messageSender.sendText(
        phone,
        'Adresse trop courte : précisez quartier et ville (ex : « Médina, Dakar, près du marché »).',
      );
      return;
    }
    await sessionManager.updateSession(phone, { orderAddress: address, orderFlow: OrderFlowState.CONFIRM_ORDER });
    await this.askPaymentMethod(phone);
  }

  /** Récapitulatif complet + choix du mode de paiement (COD ou Mobile Money). */
  private async askPaymentMethod(phone: string): Promise<void> {
    const session = await sessionManager.getSession(phone);
    const cart = session.cart ?? [];
    const lines = cart.map((c) => `• ${c.name} x${c.quantity} — ${formatPrice(c.unitPrice * c.quantity)}`);
    const text = [
      '\uD83D\uDCCB Récapitulatif de la commande :',
      ...lines,
      `Livraison : ${session.orderAddress ?? ''}`,
      `Total : ${formatPrice(this.cartTotal(cart))}`,
      '',
      'Paiement :',
      '1. À la livraison (espèces)',
      '2. Mobile Money (Wave, Orange, MTN, Moov)',
      '',
      'Répondez 1 ou 2 (ou « annuler »).',
    ].join('\n');
    await messageSender.sendText(phone, text);
  }

  /** Sous-état CONFIRM_ORDER : COD (1) ou Mobile Money (2). */
  private async handleConfirmation(phone: string, normalized: string): Promise<void> {
    if (
      normalized === '1' ||
      normalized === 'cod' ||
      normalized === 'especes' ||
      normalized === 'espèces' ||
      normalized === 'livraison'
    ) {
      await this.finalizeOrder(phone, PaymentMethod.COD);
      return;
    }
    if (normalized === '2' || normalized === 'mobile money' || normalized === 'momo' || normalized === 'wave') {
      await this.finalizeOrder(phone, PaymentMethod.MOBILE_MONEY);
      return;
    }
    await messageSender.sendText(phone, 'Répondez « 1 » (à la livraison) ou « 2 » (Mobile Money), ou « annuler ».');
  }

  /** Crée la commande en base puis route vers COD (confirmée) ou paiement. */
  private async finalizeOrder(phone: string, paymentMethod: PaymentMethod): Promise<void> {
    const key = phone.trim();
    const previous = orderProcessing.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.processOrder(key, paymentMethod));
    orderProcessing.set(key, current);
    try {
      await current;
    } finally {
      if (orderProcessing.get(key) === current) {
        orderProcessing.delete(key);
      }
    }
  }

  private async processOrder(phone: string, paymentMethod: PaymentMethod): Promise<void> {
    const session = await sessionManager.getSession(phone);
    if (session.orderFlow === PROCESSING_ORDER) {
      await messageSender.sendText(phone, 'Une commande est en cours de traitement, patientez quelques secondes.');
      return;
    }

    const cart = session.cart ?? [];
    if (cart.length === 0 || !session.orderAddress) {
      await this.resetFlow(phone, 'Session expirée. Tapez « catalogue » pour recommencer.');
      return;
    }
    await sessionManager.updateSession(phone, { orderFlow: PROCESSING_ORDER });

    const summary = cart.map((c) => `${c.name} x${c.quantity}`).join(', ');
    try {
      const order = await orderService.createOrder({
        phoneNumber: phone,
        items: cart.map((c) => ({ productId: c.productId, quantity: c.quantity, unitPrice: c.unitPrice })),
        paymentMethod,
        address: session.orderAddress,
      });

      // Nettoyage complet du flow (le panier est désormais dans la commande)
      await sessionManager.updateSession(phone, {
        currentOrderId: order.id,
        cart: [],
        orderFlow: undefined,
        orderQuantity: undefined,
        pendingProductId: undefined,
        orderAddress: undefined,
      });

      // Attribution ROI (MODULE CAMPAGNES) : si le client vient d'une pub
      // CTWA ou d'un broadcast récent, la commande alimente les métriques.
      void trackCampaignConversion(phone, order.id).catch((err: unknown) => {
        logger.warn(`Attribution campagne échouée pour ${order.id} : ${String(err)}`);
      });

      if (paymentMethod === PaymentMethod.COD) {
        await orderService.updateOrderStatus(order.id, OrderStatus.CONFIRMED);
        await this.notifyMerchant(
          `\uD83D\uDED2 Nouvelle commande COD #${order.id.slice(0, 8)} — ${summary} = ${formatPrice(order.total)} — ${phone}`,
        );
        await sessionManager.setState(phone, ConversationStateEnum.COMPLETED);
        await messageSender.sendText(
          phone,
          `\u2705 Commande confirmée !\n\nRéférence : ${order.id.slice(0, 8)}\nTotal à payer à la livraison : ${formatPrice(order.total)}\n\nMerci de votre confiance !`,
        );
        return;
      }

      // Mobile Money : commande PENDING → initiation du paiement (Phase 2)
      await this.notifyMerchant(
        `\uD83D\uDED2 Nouvelle commande #${order.id.slice(0, 8)} — ${summary} = ${formatPrice(order.total)} — ${phone} (Mobile Money)`,
      );
      await sessionManager.setState(phone, ConversationStateEnum.AWAITING_PAYMENT);
      await this.payment.initiatePayment(phone, order.id);
    } catch (err) {
      if (err instanceof orderService.InsufficientStockError) {
        await sessionManager.updateSession(phone, { orderFlow: undefined });
        await sessionManager.setState(phone, ConversationStateEnum.IDLE);
        await messageSender.sendText(phone, `Désolé : ${String(err)} Tapez « catalogue » pour recommencer.`);
        return;
      }
      logger.error(`Création commande pour ${phone} échouée : ${String(err)}`);
      await sessionManager.updateSession(phone, { orderFlow: undefined });
      await sessionManager.setState(phone, ConversationStateEnum.IDLE);
      await messageSender.sendText(phone, 'Une erreur est survenue. Tapez « catalogue » pour recommencer.');
    }
  }

  /** Annulation : statut CANCELLED si commande existante, nettoyage, retour IDLE. */
  private async cancelOrder(phone: string): Promise<void> {
    const session = await sessionManager.getSession(phone);
    if (session.currentOrderId) {
      try {
        await orderService.updateOrderStatus(session.currentOrderId, OrderStatus.CANCELLED);
      } catch (err) {
        logger.warn(`Annulation ${session.currentOrderId} : ${String(err)}`);
      }
    }
    await sessionManager.updateSession(phone, { cart: [] });
    await this.resetFlow(phone, 'Commande annulée. Tapez « catalogue » pour recommencer.');
  }

  /** Remet le flow de commande à zéro (champs de flow, panier conservé) puis message. */
  private async resetFlow(phone: string, message: string): Promise<void> {
    await sessionManager.updateSession(phone, {
      currentOrderId: undefined,
      pendingProductId: undefined,
      orderFlow: undefined,
      orderQuantity: undefined,
      orderAddress: undefined,
    });
    await sessionManager.setState(phone, ConversationStateEnum.IDLE);
    await messageSender.sendText(phone, message);
  }

  /**
   * Notifie le commerçant (numéro dédié, sinon MERCHANT_PHONE du .env — log
   * seul si absent). Respecte l'interrupteur `notifyMerchantOrders` du
   * dashboard : à `false`, aucune notification n'est envoyée.
   */
  private async notifyMerchant(text: string): Promise<void> {
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
}