/**
 * @file catalog.admin.routes.ts
 * @description Mutations du catalogue (Phase 5) — protégées JWT commerçant.
 *
 *   POST   /api/catalog             → création (201)
 *   PUT    /api/catalog/:id         → mise à jour partielle
 *   PATCH  /api/catalog/:id/stock   → stock seul (alerte si 0)
 *   DELETE /api/catalog/:id         → soft delete (isActive = false)
 *
 * NB : monté sur /api, les GET restent servis par catalog.routes.ts
 * (lecture publique du bot). merchantId ignoré pour l'instant : un
 * commerçant par déploiement (tenants en Phase 5b).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { logger } from '../../config/logger';
import * as catalogService from '../../modules/catalog/catalog.service';
import { authMiddleware } from '../../shared/auth.middleware';
import { serializeProduct } from './catalog.serialize';

const router = Router();

/** imageUrl : URL http(s) ou chaîne vide (pas encore de photo). */
const imageUrlSchema = z.string().url().or(z.literal(''));

const createSchema = z.object({
  name: z.string().trim().min(1, 'Le nom est obligatoire').max(100),
  description: z.string().trim().max(2000).default(''),
  price: z.number({ message: 'Le prix doit être un nombre' }).int().positive('Le prix doit être > 0'),
  stock: z.number({ message: 'Le stock doit être un nombre' }).int().min(0, 'Le stock doit être >= 0'),
  category: z.string().trim().min(1).max(50).default('general'),
  imageUrl: imageUrlSchema.optional(),
  merchantId: z.string().optional(), // ignoré (single-tenant) — Phase 5b
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).optional(),
  price: z.number().int().positive().optional(),
  stock: z.number().int().min(0).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  imageUrl: imageUrlSchema.nullable().optional(),
});

const stockSchema = z.object({
  stock: z.number({ message: 'Le stock doit être un nombre' }).int().min(0, 'Le stock doit être >= 0'),
});

/** POST /api/catalog — création d'un produit. */
router.post('/catalog', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? 'Requête invalide' });
    return;
  }
  // merchantId (single-tenant, non stocké) est simplement ignoré par le service
  const data = {
    name: parsed.data.name,
    description: parsed.data.description,
    price: parsed.data.price,
    stock: parsed.data.stock,
    category: parsed.data.category,
    imageUrl: parsed.data.imageUrl,
  };

  try {
    const product = await catalogService.createProduct(data);
    logger.info(`Produit créé : ${product.name} (${product.id})`);
    res.status(201).json({ success: true, data: serializeProduct(product) });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      res.status(409).json({ success: false, error: 'Ce nom de produit existe déjà.' });
      return;
    }
    logger.error(`[api/catalog] create : ${String(error)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

/** PUT /api/catalog/:id — mise à jour partielle. */
router.put('/catalog/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? 'Requête invalide' });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ success: false, error: 'Aucun champ à mettre à jour.' });
    return;
  }

  try {
    const product = await catalogService.updateProduct(req.params.id, parsed.data);
    if (!product) {
      res.status(404).json({ success: false, error: 'Produit introuvable.' });
      return;
    }
    res.json({ success: true, data: serializeProduct(product) });
  } catch (error) {
    logger.error(`[api/catalog] update ${req.params.id} : ${String(error)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

/** PATCH /api/catalog/:id/stock — mise à jour du stock seul. */
router.patch('/catalog/:id/stock', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const parsed = stockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? 'Requête invalide' });
    return;
  }

  try {
    const product = await catalogService.setStock(req.params.id, parsed.data.stock);
    if (!product) {
      res.status(404).json({ success: false, error: 'Produit introuvable.' });
      return;
    }
    if (parsed.data.stock === 0) {
      logger.warn(`⚠️ Stock épuisé : « ${product.name} » (${product.id}) — le bot ne le proposera plus.`);
    }
    res.json({ success: true, data: serializeProduct(product) });
  } catch (error) {
    logger.error(`[api/catalog] stock ${req.params.id} : ${String(error)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

/** DELETE /api/catalog/:id — soft delete (isActive = false, jamais physique). */
router.delete('/catalog/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const product = await catalogService.deactivateProduct(req.params.id);
    if (!product) {
      res.status(404).json({ success: false, error: 'Produit introuvable.' });
      return;
    }
    logger.info(`Produit désactivé : ${product.name} (${product.id})`);
    res.json({ success: true, message: 'Produit désactivé' });
  } catch (error) {
    logger.error(`[api/catalog] delete ${req.params.id} : ${String(error)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

export { router as catalogAdminRouter };