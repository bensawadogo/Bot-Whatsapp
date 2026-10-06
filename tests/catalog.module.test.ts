/**
 * Tests — CatalogModule (parcours WhatsApp de navigation du catalogue).
 * Moke les dépendances : redis (état de page courant), service catalogue,
 * sender WhatsApp et session — pattern identique à payment.module.test.ts.
 */
import { CatalogModule } from '../src/modules/catalog/catalog.module';
import * as catalogService from '../src/modules/catalog/catalog.service';
import { messageSender } from '../src/shared/sender';
import { sessionManager, ConversationStateEnum } from '../src/shared/session';
import { redis } from '../src/config/redis';
import type { Product } from '../src/modules/catalog/catalog.types';

jest.mock('../src/config/env', () => ({
  config: {
    server: { logLevel: 'error', isProduction: false },
    redis: { prefix: 'afribot:', sessionTtl: 1800 },
  },
}));
jest.mock('../src/config/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn() },
}));
jest.mock('../src/shared/sender', () => ({
  messageSender: { sendText: jest.fn(), sendList: jest.fn(), sendImage: jest.fn(), sendButtons: jest.fn() },
}));
jest.mock('../src/shared/session', () => ({
  sessionManager: { setState: jest.fn(), updateSession: jest.fn(), getSession: jest.fn() },
  ConversationStateEnum: {
    IDLE: 'IDLE',
    BROWSING_CATALOG: 'BROWSING_CATALOG',
    ORDERING: 'ORDERING',
  },
}));
jest.mock('../src/modules/catalog/catalog.service', () => ({
  listProductsPaginated: jest.fn(),
  getProductById: jest.fn(),
}));

const svc = catalogService as jest.Mocked<typeof catalogService>;
const sender = messageSender as jest.Mocked<typeof messageSender>;
const sm = sessionManager as jest.Mocked<typeof sessionManager>;
const redisGet = redis.get as jest.Mock;
const redisSet = redis.set as jest.Mock;

const PHONE = '221771234567';
const PAGE_KEY = `afribot:catalog:page:${PHONE}`;

/** Faux cache Redis — même principe que session.test.ts (Map en mémoire). */
const pageStore = new Map<string, string>();

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-1',
    name: 'Riz parfumé 5kg',
    price: 3500,
    stock: 12,
    imageUrl: 'https://img.example/riz.jpg',
    category: 'Céréales',
    description: 'Riz de qualité supérieure',
    isActive: true,
    ...overrides,
  };
}

function manyProducts(count: number): Product[] {
  return Array.from({ length: count }, (_, i) =>
    makeProduct({ id: `prod-${i + 1}`, name: `Produit ${i + 1}`, description: '' }),
  );
}

describe('CatalogModule', () => {
  let module: CatalogModule;

  beforeEach(() => {
    jest.clearAllMocks();
    pageStore.clear();
    redisGet.mockImplementation(async (key: string) => pageStore.get(key) ?? null);
    redisSet.mockImplementation(async (key: string, value: string) => {
      pageStore.set(key, String(value));
      return 'OK';
    });
    sm.setState.mockResolvedValue();
    sm.updateSession.mockResolvedValue();
    sm.getSession.mockResolvedValue({
      phoneNumber: PHONE,
      state: ConversationStateEnum.IDLE,
      lastActivity: Date.now(),
      pendingProductId: undefined,
    } as never);
    module = new CatalogModule();
  });

  it('sendCatalog — message dédié si le catalogue est vide', async () => {
    svc.listProductsPaginated.mockResolvedValue({ products: [], total: 0, page: 1, limit: 10, totalPages: 0 });
    await module.sendCatalog(PHONE);
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, 'Aucun produit disponible pour le moment.');
    expect(sender.sendList).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('sendCatalog — liste numérotée (1 page, sans hint) et sauvegarde la page 0', async () => {
    const products = manyProducts(3).map((p, i) =>
      i === 0 ? { ...p, description: 'x'.repeat(80) } : p,
    );
    svc.listProductsPaginated.mockResolvedValue({ products, total: products.length, page: 1, limit: 10, totalPages: 1 });

    await module.sendCatalog(PHONE, 0);

    expect(sender.sendList).toHaveBeenCalledWith(PHONE, 'Notre catalogue', [
      { productId: 'prod-1', title: '1. Produit 1 — 3 500 FCFA', description: 'x'.repeat(60) },
      { productId: 'prod-2', title: '2. Produit 2 — 3 500 FCFA' },
      { productId: 'prod-3', title: '3. Produit 3 — 3 500 FCFA' },
    ]);
    expect(redisSet).toHaveBeenCalledWith(
      PAGE_KEY,
      JSON.stringify({ page: 0, productIds: ['prod-1', 'prod-2', 'prod-3'] }),
      'EX',
      1800,
    );
  });

  it('sendCatalog — pagination : hint de page, numérotation continue, page clampee', async () => {
    // Setup: mock returns products based on requested page
    // Page 1 (1-indexed) -> prod-1 to prod-10
    // Page 2 (1-indexed) -> prod-11 to prod-15
    svc.listProductsPaginated.mockImplementation(async (params) => {
      const page = params?.page ?? 1;
      if (page >= 2) {
        const page2 = manyProducts(15).slice(10, 15);
        return { products: page2, total: 15, page: 2, limit: 10, totalPages: 2 };
      }
      // Page 1
      const page1 = manyProducts(15).slice(0, 10);
      return { products: page1, total: 15, page: 1, limit: 10, totalPages: 2 };
    });

    await module.sendCatalog(PHONE, 1);
    expect(sender.sendList).toHaveBeenLastCalledWith(
      PHONE,
      'Notre catalogue (page 2/2 — « suivant » / « precedent »)',
      expect.arrayContaining([
        expect.objectContaining({ title: '11. Produit 11 — 3 500 FCFA' }),
        expect.objectContaining({ title: '15. Produit 15 — 3 500 FCFA' }),
      ]),
    );
    expect(redisSet).toHaveBeenLastCalledWith(
      PAGE_KEY,
      JSON.stringify({ page: 1, productIds: ['prod-11', 'prod-12', 'prod-13', 'prod-14', 'prod-15'] }),
      'EX',
      1800,
    );

    await module.sendCatalog(PHONE, 99); // au-delà de la dernière page → clampée
    expect(redisSet).toHaveBeenLastCalledWith(
      PAGE_KEY,
      JSON.stringify({ page: 1, productIds: ['prod-11', 'prod-12', 'prod-13', 'prod-14', 'prod-15'] }),
      'EX',
      1800,
    );

    await module.sendCatalog(PHONE, -3); // page négative → 0
    expect(redisSet).toHaveBeenLastCalledWith(
      PAGE_KEY,
      JSON.stringify({ page: 0, productIds: Array.from({ length: 10 }, (_, i) => `prod-${i + 1}`) }),
      'EX',
      1800,
    );
  });

  it('handle « suivant » — avance d’une page à partir de l’état sauvegardé', async () => {
    const products = manyProducts(15);
    svc.listProductsPaginated.mockResolvedValue({ products: products.slice(10, 15), total: 15, page: 2, limit: 10, totalPages: 2 });
    pageStore.set(PAGE_KEY, JSON.stringify({ page: 0, productIds: products.map((p) => p.id).slice(0, 10) }));

    await module.handle(PHONE, 'suivant');

    expect(redisSet).toHaveBeenLastCalledWith(
      PAGE_KEY,
      JSON.stringify({ page: 1, productIds: products.slice(10).map((p) => p.id) }),
      'EX',
      1800,
    );
    expect(sender.sendList).toHaveBeenLastCalledWith(PHONE, expect.stringContaining('page 2/2'), expect.any(Array));
  });

  it('handle « precedent » / « retour » — page précédente, bornée à 0', async () => {
    const products = manyProducts(15);
    svc.listProductsPaginated.mockResolvedValue({ products: products.slice(0, 10), total: 15, page: 1, limit: 10, totalPages: 2 });

    pageStore.set(PAGE_KEY, JSON.stringify({ page: 0, productIds: products.slice(0, 10).map((p) => p.id) }));
    await module.handle(PHONE, 'precedent'); // déjà page 0 → clampée à 0
    expect(redisSet).toHaveBeenLastCalledWith(
      PAGE_KEY,
      JSON.stringify({ page: 0, productIds: products.slice(0, 10).map((p) => p.id) }),
      'EX',
      1800,
    );

    pageStore.set(PAGE_KEY, JSON.stringify({ page: 1, productIds: products.slice(10).map((p) => p.id) }));
    await module.handle(PHONE, 'retour');
    expect(redisSet).toHaveBeenLastCalledWith(
      PAGE_KEY,
      JSON.stringify({ page: 0, productIds: products.slice(0, 10).map((p) => p.id) }),
      'EX',
      1800,
    );
  });

  it('handle « fin » — retour IDLE et message de menu', async () => {
    await module.handle(PHONE, 'fin');
    expect(sm.setState).toHaveBeenCalledWith(PHONE, ConversationStateEnum.IDLE);
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, 'Retour au menu. Tapez « catalogue » pour revenir aux produits.');
  });

  it('handle numéro — détail du produit de la page courante (photo + boutons)', async () => {
    pageStore.set(PAGE_KEY, JSON.stringify({ page: 0, productIds: ['prod-1', 'prod-2'] }));
    svc.getProductById.mockResolvedValue(makeProduct({ id: 'prod-2', name: 'Sucre 1kg', price: 800, stock: 3 }));

    await module.handle(PHONE, '2');

    expect(sm.updateSession).toHaveBeenCalledWith(PHONE, { pendingProductId: 'prod-2' });
    expect(sender.sendImage).toHaveBeenCalledWith(
      PHONE,
      'https://img.example/riz.jpg',
      expect.stringContaining('Sucre 1kg'),
    );
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(sender.sendButtons).toHaveBeenCalledWith(PHONE, 'Que voulez-vous faire ?', [
      { id: 'order', label: 'Commander' },
      { id: 'back', label: 'Retour' },
    ]);
  });

  it('handle numéro — inconnu (pas de page / hors liste) → message dédié', async () => {
    await module.handle(PHONE, '1'); // aucune page sauvegardée
    expect(sender.sendText).toHaveBeenCalledWith(
      PHONE,
      'Numéro inconnu. Tapez « catalogue » pour voir la liste des produits.',
    );

    pageStore.set(PAGE_KEY, JSON.stringify({ page: 0, productIds: ['prod-1'] }));
    await module.handle(PHONE, '9'); // hors de la page (1 seul produit)
    expect(sender.sendText).toHaveBeenCalledTimes(2);
    expect(svc.getProductById).not.toHaveBeenCalled();
  });

  it('sendProductDetail — sans photo, envoie un texte simple', async () => {
    const product = makeProduct({ imageUrl: '', stock: 0 });
    await module.sendProductDetail(PHONE, product);

    expect(sm.updateSession).toHaveBeenCalledWith(PHONE, { pendingProductId: 'prod-1' });
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Rupture de stock'));
    expect(sender.sendImage).not.toHaveBeenCalled();
    expect(sender.sendButtons).toHaveBeenCalledWith(PHONE, 'Que voulez-vous faire ?', expect.any(Array));
  });

  it('handle « commander » sans produit sélectionné — invite à choisir un numéro', async () => {
    await module.handle(PHONE, 'commander');
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, 'Choisissez d’abord un produit : tapez son numéro (ex: 1).');
    expect(sm.setState).not.toHaveBeenCalled();
  });

  it('handle « commander » avec produit — bascule ORDERING et demande la quantité', async () => {
    sm.getSession.mockResolvedValue({
      phoneNumber: PHONE,
      state: ConversationStateEnum.BROWSING_CATALOG,
      lastActivity: Date.now(),
      pendingProductId: 'prod-1',
    } as never);
    svc.getProductById.mockResolvedValue(makeProduct({ stock: 5 }));

    await module.handle(PHONE, 'commander');

    expect(svc.getProductById).toHaveBeenCalledWith('prod-1');
    expect(sm.updateSession).toHaveBeenCalledWith(PHONE, { pendingProductId: 'prod-1', orderFlow: 'SELECT_QUANTITY' });
    expect(sm.setState).toHaveBeenCalledWith(PHONE, ConversationStateEnum.ORDERING);
    expect(sender.sendText).toHaveBeenCalledWith(
      PHONE,
      expect.stringMatching(/Produit : Riz parfumé 5kg[\s\S]*Prix : 3 500 FCFA[\s\S]*Combien d.exemplaires/),
    );
  });

  it('startOrder — produit indisponible → message « plus disponible »', async () => {
    svc.getProductById.mockResolvedValue(null);
    await module.startOrder(PHONE, 'prod-x');
    expect(sender.sendText).toHaveBeenCalledWith(
      PHONE,
      'Ce produit n’est plus disponible. Tapez « catalogue ».',
    );
    expect(sm.setState).not.toHaveBeenCalled();
  });

  it('startOrder — rupture de stock → message dédié', async () => {
    svc.getProductById.mockResolvedValue(makeProduct({ stock: 0 }));
    await module.startOrder(PHONE, 'prod-1');
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, 'Désolé, « Riz parfumé 5kg » est en rupture de stock.');
    expect(sm.setState).not.toHaveBeenCalled();
  });

  it('handle recherche — aucun résultat → message dédié', async () => {
    svc.listProductsPaginated.mockResolvedValue({ products: [], total: 0, page: 1, limit: 10, totalPages: 0 });
    await module.handle(PHONE, 'blabla');
    expect(svc.listProductsPaginated).toHaveBeenCalledWith({ query: 'blabla', page: 1, limit: 10 });
    expect(sender.sendText).toHaveBeenCalledWith(
      PHONE,
      'Aucun produit ne correspond. Tapez « catalogue » pour voir toute la liste.',
    );
  });

  it('handle recherche — résultats → liste numérotée + sauvegarde la page', async () => {
    const results = manyProducts(2).map((p, i) => ({ ...p, id: `r${i + 1}`, description: 'Sucre raffiné' }));
    svc.listProductsPaginated.mockResolvedValue({ products: results, total: 2, page: 1, limit: 10, totalPages: 1 });

    await module.handle(PHONE, 'sucre');

    expect(sender.sendList).toHaveBeenCalledWith(PHONE, 'Résultats pour « sucre »', [
      { productId: 'r1', title: '1. Produit 1 — 3 500 FCFA', description: 'Sucre raffiné' },
      { productId: 'r2', title: '2. Produit 2 — 3 500 FCFA', description: 'Sucre raffiné' },
    ]);
    expect(redisSet).toHaveBeenCalledWith(
      PAGE_KEY,
      JSON.stringify({ page: 0, productIds: ['r1', 'r2'] }),
      'EX',
      1800,
    );
  });
});