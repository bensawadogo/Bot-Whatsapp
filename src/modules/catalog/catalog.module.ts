/**
 * AfriBot — module catalogue.
 *
 * Reçoit les messages quand la session est en BROWSING_CATALOG.
 * Comportements :
 *   - numéro tapé ("1".."10") → détail du produit de la page courante
 *   - "suivant" / "retour" → pagination (10 produits max par page)
 *   - "commander" → démarre le flow de commande (OrderModule)
 *   - recherche libre → liste filtrée
 * La page courante (numéros → productIds) est cachée dans Redis avec le
 * même TTL que les sessions (30 min).
 */
import { redis } from '../../config/redis';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { messageSender, type Button } from '../../shared/sender';
import { formatPrice } from '../../shared/format';
import { ConversationStateEnum, sessionManager } from '../../shared/session';
import * as catalogService from './catalog.service';
import type { Product } from './catalog.types';

/** Produits maximum par page (payload léger 2G/3G — docs/TODO.md Phase 1). */
const PRODUCTS_PER_PAGE = 10;

/** Sous-état courant du catalogue (page + correspondance numéros). */
interface CatalogPageState {
  page: number;
  productIds: string[];
}

export class CatalogModule {
  private readonly pagePrefix: string;

  constructor() {
    this.pagePrefix = `${config.redis.prefix}catalog:page:`;
  }

  /** Envoie la liste produits paginée (pagination SQL — scalable, message léger 2G/3G). */
  async sendCatalog(phone: string, page = 0): Promise<void> {
    const requested = Math.max(0, Math.floor(page));
    let paged = await catalogService.listProductsPaginated({
      page: requested + 1,
      limit: PRODUCTS_PER_PAGE,
    });
    if (paged.total === 0) {
      await messageSender.sendText(phone, 'Aucun produit disponible pour le moment.');
      return;
    }

    const totalPages = Math.max(1, paged.totalPages);
    const safePage = Math.min(requested, totalPages - 1);
    if (safePage !== requested) {
      paged = await catalogService.listProductsPaginated({
        page: safePage + 1,
        limit: PRODUCTS_PER_PAGE,
      });
    }
    const slice = paged.products;

    await this.savePage(phone, { page: safePage, productIds: slice.map((p) => p.id) });

    const items = slice.map((product, index) => ({
      productId: product.id,
      title: `${safePage * PRODUCTS_PER_PAGE + index + 1}. ${product.name} — ${formatPrice(product.price)}`,
      ...(product.description !== '' && { description: product.description.slice(0, 60) }),
    }));

    const pageHint = totalPages > 1 ? ` (page ${safePage + 1}/${totalPages} — « suivant » / « precedent »)` : '';
    await messageSender.sendList(phone, `Notre catalogue${pageHint}`, items);
  }

  /** Envoie le détail produit : photo compressée + prix + stock + boutons. */
  async sendProductDetail(phone: string, product: Product): Promise<void> {
    await sessionManager.updateSession(phone, { pendingProductId: product.id });

    const stockHint = product.stock > 0 ? `En stock : ${product.stock}` : 'Rupture de stock';
    const detail = `${product.name}\n\n${product.description}\n\nPrix : ${formatPrice(product.price)}\n${stockHint}`;

    if (product.imageUrl !== '') {
      await messageSender.sendImage(phone, product.imageUrl, detail);
    } else {
      await messageSender.sendText(phone, detail);
    }

    const buttons: Button[] = [{ id: 'order', label: 'Commander' }, { id: 'back', label: 'Retour' }];
    await messageSender.sendButtons(phone, 'Que voulez-vous faire ?', buttons);
  }

  /** Point d'entrée du module pour un message en état BROWSING_CATALOG. */
  async handle(phone: string, message: string): Promise<void> {
    const normalized = message.trim().toLowerCase();

    // Pagination
    if (normalized === 'suivant') {
      const page = (await this.loadPage(phone))?.page ?? 0;
      await this.sendCatalog(phone, page + 1);
      return;
    }
    if (normalized === 'precedent' || normalized === 'retour') {
      const page = (await this.loadPage(phone))?.page ?? 0;
      await this.sendCatalog(phone, Math.max(0, page - 1));
      return;
    }
    if (normalized === 'fin') {
      await sessionManager.setState(phone, ConversationStateEnum.IDLE);
      await messageSender.sendText(phone, 'Retour au menu. Tapez « catalogue » pour revenir aux produits.');
      return;
    }

    // Sélection par numéro tapé (habitude SMS — les listes ne sont pas toujours cliquées)
    const selection = normalized.match(/^(\d{1,2})$/);
    if (selection) {
      const product = await this.resolveSelection(phone, Number(selection[1]));
      if (!product) {
        await messageSender.sendText(phone, 'Numéro inconnu. Tapez « catalogue » pour voir la liste des produits.');
        return;
      }
      await this.sendProductDetail(phone, product);
      return;
    }

    // Démarrage de commande (bouton "Commander" ou texte)
    if (normalized === 'commander') {
      const session = await sessionManager.getSession(phone);
      if (!session.pendingProductId) {
        await messageSender.sendText(phone, 'Choisissez d\u2019abord un produit : tapez son numéro (ex: 1).');
        return;
      }
      await this.startOrder(phone, session.pendingProductId);
      return;
    }

    // Recherche libre par mot-clé
    await this.handleSearch(phone, normalized);
  }

  /** Démarre le flow de commande : session → ORDERING + sous-état quantité. */
  async startOrder(phone: string, productId: string): Promise<void> {
    const product = await catalogService.getProductById(productId);
    if (!product) {
      await messageSender.sendText(phone, 'Ce produit n\u2019est plus disponible. Tapez « catalogue ».');
      return;
    }
    if (product.stock <= 0) {
      await messageSender.sendText(phone, `Désolé, « ${product.name} » est en rupture de stock.`);
      return;
    }

    await sessionManager.updateSession(phone, {
      pendingProductId: productId,
      orderFlow: 'SELECT_QUANTITY',
    });
    await sessionManager.setState(phone, ConversationStateEnum.ORDERING);

    await messageSender.sendText(
      phone,
      `Produit : ${product.name}\nPrix : ${formatPrice(product.price)}\n\nCombien d'exemplaires ? (tapez un nombre, ou « annuler »)`,
    );
  }

  /** Charge l'état de page courant (numéros → productIds) depuis Redis. */
  private async loadPage(phone: string): Promise<CatalogPageState | null> {
    const raw = await redis.get(this.pagePrefix + phone);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CatalogPageState;
    } catch {
      return null;
    }
  }

  /** Persiste l'état de page courant dans Redis (TTL sessions). */
  private async savePage(phone: string, state: CatalogPageState): Promise<void> {
    await redis.set(this.pagePrefix + phone, JSON.stringify(state), 'EX', config.redis.sessionTtl);
  }

  /** Résout le numéro tapé vers le produit de la page courante. */
  private async resolveSelection(phone: string, selection: number): Promise<Product | null> {
    const page = await this.loadPage(phone);
    if (!page) return null;
    const productId = page.productIds[selection - 1];
    if (!productId) return null;
    return catalogService.getProductById(productId);
  }

  /** Recherche libre : liste filtrée (pagination SQL) ou message "aucun résultat". */
  private async handleSearch(phone: string, query: string): Promise<void> {
    logger.debug(`Recherche catalogue pour ${phone} : "${query}"`);
    const paged = await catalogService.listProductsPaginated({
      query,
      page: 1,
      limit: PRODUCTS_PER_PAGE,
    });
    const results = paged.products;
    if (results.length === 0) {
      await messageSender.sendText(
        phone,
        'Aucun produit ne correspond. Tapez « catalogue » pour voir toute la liste.',
      );
      return;
    }

    await this.savePage(phone, { page: 0, productIds: results.map((p) => p.id) });
    const items = results.map((product, index) => ({
      productId: product.id,
      title: `${index + 1}. ${product.name} — ${formatPrice(product.price)}`,
      ...(product.description !== '' && { description: product.description.slice(0, 60) }),
    }));
    await messageSender.sendList(phone, `Résultats pour « ${query} »`, items);
  }
}
