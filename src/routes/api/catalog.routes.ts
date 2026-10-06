/**
 * AfriBot — API REST du dashboard : consultation du catalogue (Phase 1).
 *
 *   GET /api/catalog       → liste paginée (?page=&limit=&q=)
 *   GET /api/catalog/:id   → détail d'un produit
 *
 * Lecture seule pour l'instant : le Create/Update/Delete arrivera avec
 * l'authentification JWT du dashboard (Phase 5) — jamais d'écriture publique.
 */
import { Router, type Request, type Response } from 'express';

import { logger } from '../../config/logger';
import * as catalogService from '../../modules/catalog/catalog.service';
import { parsePagination } from '../../shared/pagination';
import { serializeProduct } from './catalog.serialize';

const router = Router();

/**
 * GET /api/catalog — liste paginée des produits actifs.
 * ?page=1&limit=20&q=riz (recherche sur nom, description, catégorie).
 */
router.get('/catalog', async (req: Request, res: Response): Promise<void> => {
  const pagination = parsePagination(req.query);
  if (!pagination) {
    res.status(400).json({ error: 'Paramètres invalides : page >= 1, limit entre 1 et 100.' });
    return;
  }
  const query = typeof req.query.q === 'string' ? req.query.q : undefined;

  try {
    const result = await catalogService.listProductsPaginated({
      page: pagination.page,
      limit: pagination.limit,
      query,
    });
    res.json({
      products: result.products.map(serializeProduct),
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    logger.error(`[api/catalog] list : ${String(err)}`);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/**
 * GET /api/catalog/:id — détail d'un produit actif par identifiant.
 */
router.get('/catalog/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    res.status(400).json({ error: 'Identifiant produit manquant.' });
    return;
  }

  try {
    const product = await catalogService.getProductById(id);
    if (!product) {
      res.status(404).json({ error: 'Produit introuvable.' });
      return;
    }
    res.json({ product: serializeProduct(product) });
  } catch (err) {
    logger.error(`[api/catalog] getById ${id} : ${String(err)}`);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

export { router as catalogRouter };