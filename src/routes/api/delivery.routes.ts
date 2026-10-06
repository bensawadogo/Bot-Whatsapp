/**
 * AfriBot — routes API livraison (MODULE 6).
 * Toutes protégées par authMiddleware (dashboard commerçant).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { logger } from '../../config/logger';
import { authMiddleware } from '../../shared/auth.middleware';
import { SINGLE_TENANT_MERCHANT_ID } from '../../shared/tenant';
import { deliveryModule } from '../../modules/delivery/delivery.module';
import * as deliveryService from '../../modules/delivery/delivery.service';
import { DeliveryStatus } from '../../modules/delivery/delivery.types';

export const deliveryRouter = Router();

deliveryRouter.use(authMiddleware);

// --- Schémas Zod -----------------------------------------------------------

const assignSchema = z.object({
  orderId: z.string().min(1),
  livreurId: z.string().min(1),
  estimatedTime: z.coerce.number().int().positive().optional(),
  notes: z.string().max(500).optional(),
});

const statusSchema = z.object({
  status: z.nativeEnum(DeliveryStatus),
});

// --- POST /api/delivery/assign — assigner un livreur ------------------------

deliveryRouter.post('/assign', async (req: Request, res: Response) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Requête invalide', details: parsed.error.flatten() });
    return;
  }

  const { orderId, livreurId, estimatedTime, notes } = parsed.data;
  const delivery = await deliveryModule.assignDelivery(orderId, { livreurId }, { estimatedTime, notes });
  if (!delivery) {
    res.status(404).json({ error: 'Commande ou livreur introuvable' });
    return;
  }
  logger.info(`Livraison ${delivery.id} assignée depuis le dashboard (commande ${orderId})`);
  res.status(201).json({ success: true, delivery });
});

// --- GET /api/delivery/active — livraisons en cours -------------------------

deliveryRouter.get('/active', async (_req: Request, res: Response) => {
  const deliveries = await deliveryService.listActiveDeliveries();
  res.json({ deliveries });
});

// --- GET /api/delivery/livreurs — livreurs du commerçant --------------------

deliveryRouter.get('/livreurs', async (_req: Request, res: Response) => {
  const livreurs = await deliveryService.listLivreurs(SINGLE_TENANT_MERCHANT_ID);
  res.json({ livreurs });
});

// --- PATCH /api/delivery/:id/status — maj statut (dashboard) ----------------

deliveryRouter.patch('/:id/status', async (req: Request, res: Response) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Statut invalide', details: parsed.error.flatten() });
    return;
  }

  const updated = await deliveryModule.updateStatusFromDashboard(req.params.id, parsed.data.status);
  if (!updated) {
    res.status(404).json({ error: 'Livraison introuvable' });
    return;
  }
  res.json({ success: true, delivery: updated });
});