/**
 * AfriBot — API REST du dashboard : remboursements (Phase 2 + 5).
 *
 *   GET  /api/refunds/:id/refundable → vérification remboursable (pré-vol)
 *   POST /api/refunds/:id            → rembourse (payment REFUNDED,
 *                                      commande CANCELLED, restock atomique)
 *
 * Protégé par le JWT dashboard (authMiddleware) — jamais d'écriture publique.
 * Le remboursement Fournisseur (back-office CinetPay/FedaPay) reste manuel :
 * la réponse renvoie le `transactionId` à utiliser côté marchand.
 */
import { Router, type Request, type Response } from 'express';

import { logger } from '../../config/logger';
import { isRefundable, refundOrder, RefundError } from '../../modules/payments/refund.service';
import { authMiddleware, type AuthenticatedRequest } from '../../shared/auth.middleware';

const router = Router();

// IMPORTANT : ce routeur est monté sur `/api` (voir src/index.ts) — donc AVANT
// `/api/auth`. Un `router.use(authMiddleware)` global ici intercepterait TOUTES
// les routes `/api/*` (login compris) et casserait la connexion au dashboard.
// L'authentification est donc appliquée route par route, pas globalement.

/**
 * GET /api/refunds/:id/refundable — la commande peut-elle être remboursée ?
 */
router.get(
  '/refunds/:id/refundable',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ success: false, error: 'Identifiant commande manquant.' });
      return;
    }
    try {
      const refundable = await isRefundable(id);
      res.json({ success: true, refundable });
    } catch (err) {
      logger.error(`[api/refunds] refundable ${id} : ${String(err)}`);
      res.status(500).json({ success: false, error: 'Erreur interne' });
    }
  },
);

/**
 * POST /api/refunds/:id — rembourse la commande (idempotent, transactionnel).
 */
router.post(
  '/refunds/:id',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ success: false, error: 'Identifiant commande manquant.' });
      return;
    }

    try {
      const result = await refundOrder(id);
      logger.warn(`[api/refunds] commande ${id} remboursée par ${req.merchantEmail ?? 'dashboard'}`);
      res.json({
        success: true,
        refund: {
          ...result,
          amountFormatted: `${result.amount.toLocaleString('fr-FR')} FCFA`,
          /** Action manuelle restante pour le marchand (back-office fournisseur). */
          merchantAction: `Valider le remboursement ${result.provider} de la transaction ${result.transactionId} dans le back-office du fournisseur.`,
        },
      });
    } catch (err) {
      if (err instanceof RefundError) {
        res.status(409).json({ success: false, error: err.message });
        return;
      }
      logger.error(`[api/refunds] refund ${id} : ${String(err)}`);
      res.status(500).json({ success: false, error: 'Erreur interne' });
    }
  },
);

export { router as refundsRouter };
