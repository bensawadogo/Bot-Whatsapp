/**
 * AfriBot — API REST du dashboard : suivi des commandes (lecture).
 *
 *   GET /api/orders        → liste paginée (?page=&limit=&status=&phone=)
 *   GET /api/orders/:id    → détail d'une commande (avec lignes)
 *
 * Lecture seule : les mutations de statut passent par le bot (COD à la
 * livraison, webhooks paiement) — l'écriture dashboard viendra avec le JWT
 * (Phase 5).
 */
import { Router, type Request, type Response } from 'express';

import { logger } from '../../config/logger';
import * as orderService from '../../modules/orders/order.service';
import { OrderStatus, type Order } from '../../modules/orders/order.types';
import { formatPrice } from '../../shared/format';
import { parsePagination } from '../../shared/pagination';

const router = Router();

/** Statuts acceptés pour ?status= (enum métier). */
const VALID_STATUSES = new Set<string>(Object.values(OrderStatus));

/** Sérialise une commande pour le dashboard (totaux formatés XOF). */
function serializeOrder(o: Order): {
  id: string;
  phoneNumber: string;
  items: { productId: string; quantity: number; unitPrice: number; lineTotal: number; lineTotalFormatted: string }[];
  total: number;
  totalFormatted: string;
  status: OrderStatus;
  paymentMethod: string;
  address: string;
  createdAt: string;
} {
  return {
    id: o.id,
    phoneNumber: o.phoneNumber,
    items: o.items.map((i) => {
      const lineTotal = i.quantity * i.unitPrice;
      return {
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal,
        lineTotalFormatted: formatPrice(lineTotal),
      };
    }),
    total: o.total,
    totalFormatted: formatPrice(o.total),
    status: o.status,
    paymentMethod: o.paymentMethod,
    address: o.address,
    createdAt: o.createdAt.toISOString(),
  };
}

/**
 * GET /api/orders — liste paginée des commandes, plus récentes d'abord.
 * ?page=1&limit=20&status=CONFIRMED&phone=22177xxxxxxx
 */
router.get('/orders', async (req: Request, res: Response): Promise<void> => {
  const pagination = parsePagination(req.query);
  if (!pagination) {
    res.status(400).json({ error: 'Paramètres invalides : page >= 1, limit entre 1 et 100.' });
    return;
  }

  const statusParam = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
  if (statusParam !== undefined && !VALID_STATUSES.has(statusParam)) {
    res.status(400).json({ error: `Statut invalide. Valeurs acceptées : ${[...VALID_STATUSES].join(', ')}.` });
    return;
  }
  const phone =
    typeof req.query.phone === 'string' && req.query.phone.trim().length > 0 ? req.query.phone.trim() : undefined;

  try {
    const result = await orderService.listOrders({
      status: statusParam as OrderStatus | undefined,
      phoneNumber: phone,
      page: pagination.page,
      limit: pagination.limit,
    });
    res.json({
      orders: result.orders.map(serializeOrder),
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    logger.error(`[api/orders] list : ${String(err)}`);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/**
 * GET /api/orders/:id — détail d'une commande par identifiant.
 */
router.get('/orders/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    res.status(400).json({ error: 'Identifiant commande manquant.' });
    return;
  }

  try {
    const order = await orderService.getOrderById(id);
    if (!order) {
      res.status(404).json({ error: 'Commande introuvable.' });
      return;
    }
    res.json({ order: serializeOrder(order) });
  } catch (err) {
    logger.error(`[api/orders] getById ${id} : ${String(err)}`);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

export { router as ordersRouter };