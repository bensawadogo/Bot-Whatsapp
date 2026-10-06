/**
 * @file stats.routes.ts
 * @description Statistiques du dashboard commerçant (Phase 5) — protégées JWT.
 *
 *   GET /api/stats/today                → stats du jour
 *   GET /api/stats/weekly               → revenus 7 derniers jours
 *   GET /api/stats/top-products?limit=5 → top produits
 *   GET /api/stats/conversion           → entonnoir de conversion
 *   GET /api/stats/low-stock?threshold=5→ produits en stock bas
 */
import { Router, type Request, type Response } from 'express';

import { logger } from '../../config/logger';
import { StatsService } from '../../modules/dashboard/stats.service';
import { authMiddleware } from '../../shared/auth.middleware';

const router = Router();
const statsService = new StatsService();

/** Lit et borne un entier de query (?limit=5, ?threshold=5). */
function parseIntParam(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback;
  const parsed = Math.floor(Number(value));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/** GET /api/stats/today — stats du jour. */
router.get('/today', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await statsService.getDailyStats(new Date()) });
  } catch (err) {
    logger.error(`[api/stats] today : ${String(err)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

/** GET /api/stats/weekly — revenus des 7 derniers jours. */
router.get('/weekly', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await statsService.getWeeklyRevenue() });
  } catch (err) {
    logger.error(`[api/stats] weekly : ${String(err)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

/** GET /api/stats/top-products?limit=5 — produits les plus vendus. */
router.get('/top-products', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const limit = parseIntParam(req.query.limit, 5, 1, 50);
  if (limit === null) {
    res.status(400).json({ success: false, error: 'limit doit être un entier entre 1 et 50.' });
    return;
  }
  try {
    res.json({ success: true, data: await statsService.getTopProducts(limit) });
  } catch (err) {
    logger.error(`[api/stats] top-products : ${String(err)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

/** GET /api/stats/conversion — entonnoir sessions → commandes → payées. */
router.get('/conversion', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await statsService.getConversionStats() });
  } catch (err) {
    logger.error(`[api/stats] conversion : ${String(err)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

/** GET /api/stats/low-stock?threshold=5 — produits à réapprovisionner. */
router.get('/low-stock', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const threshold = parseIntParam(req.query.threshold, 5, 0, 1000);
  if (threshold === null) {
    res.status(400).json({ success: false, error: 'threshold doit être un entier entre 0 et 1000.' });
    return;
  }
  try {
    res.json({ success: true, data: await statsService.getLowStockProducts(threshold) });
  } catch (err) {
    logger.error(`[api/stats] low-stock : ${String(err)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

export { router as statsRouter };