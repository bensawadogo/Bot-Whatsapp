/**
 * AfriBot � routes API campagnes (MODULE CAMPAGNES).
 * Toutes prot�g�es par authMiddleware (dashboard commer�ant).
 *
 * R�GLE META 1 : N'envoyer QU'� des contacts qui ont �crit en premier.
 * R�GLE META 2 : Utiliser uniquement des templates approuv�s.
 * R�GLE META 3 : Respecter le rate limiting du tier actuel.
 * R�GLE META 4 : Surveiller le blockRate � si > 2 % ? pause automatique.
 * R�GLE META 5 : Ne JAMAIS acheter ou scraper des listes.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { logger } from '../../config/logger';
import { authMiddleware } from '../../shared/auth.middleware';
import { TEMPLATES } from '../../shared/templates';
import * as campaignService from '../../modules/campaigns/campaign.service';

export const campaignsRouter = Router();

campaignsRouter.use(authMiddleware);

// --- Schemas Zod -----------------------------------------------------------

const SEGMENTS = ['ALL', 'ACTIVE_30', 'ACTIVE_90', 'DORMANT', 'NEW'] as const;
const TYPES = ['CTWA', 'BROADCAST', 'REACTIVATION'] as const;

const createSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(TYPES),
  templateKey: z.string().min(1),
  templateParams: z.string().max(2000).optional(),
  targetSegment: z.enum(SEGMENTS),
  scheduledAt: z.coerce.date().optional(),
});

// --- GET /api/campaigns � historique + m�triques ----------------------------

campaignsRouter.get('/', async (_req: Request, res: Response) => {
  const campaigns = await campaignService.listCampaigns(campaignService.defaultMerchantId());
  res.json({ campaigns });
});

// --- GET /api/campaigns/quality � score qualit� (AVANT /:id pour �viter le shadowing) ---

campaignsRouter.get('/quality', async (_req: Request, res: Response) => {
  const quality = await campaignService.getQualitySnapshot(campaignService.defaultMerchantId());
  res.json(quality);
});

// --- POST /api/campaigns � cr�ation -----------------------------------------

campaignsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Requ�te invalide', details: parsed.error.flatten() });
    return;
  }

  // Validation m�tier : le template doit exister (R�GLE META 2).
  if (!(parsed.data.templateKey in TEMPLATES)) {
    res.status(400).json({
      error: 'Template � ' + parsed.data.templateKey + ' � inconnu � choisissez un template approuv�',
    });
    return;
  }

  const campaign = await campaignService.createCampaign(campaignService.defaultMerchantId(), parsed.data);
  if (!campaign) {
    res.status(400).json({ error: 'Cr�ation impossible (template invalide)' });
    return;
  }
  logger.info('Campagne � ' + campaign.name + ' � cr��e depuis le dashboard');
  res.status(201).json({ success: true, campaign });
});

// --- POST /api/campaigns/:id/send � lancement (imm�diat) --------------------

campaignsRouter.post('/:id/send', async (req: Request, res: Response) => {
  const campaign = await campaignService.getCampaignById(req.params.id);
  if (!campaign) {
    res.status(404).json({ error: 'Campagne introuvable' });
    return;
  }
  if (campaign.status !== 'DRAFT') {
    res.status(400).json({ error: 'Campagne non envoyable (statut: ' + campaign.status + ')' });
    return;
  }
  // Lancement asynchrone
  setImmediate(() => {
    campaignService.sendCampaign(req.params.id).catch(err => 
      logger.error('Envoi campagne ' + req.params.id + ' �chou�: ' + String(err))
    );
  });
  res.status(202).json({ success: true, message: 'Envoi en cours', campaignId: req.params.id });
});

// --- POST /api/campaigns/:id/pause � pause manuelle -------------------------

campaignsRouter.post('/:id/pause', async (req: Request, res: Response) => {
  const paused = await campaignService.pauseCampaign(req.params.id, 'pause manuelle (dashboard)');
  if (!paused) {
    res.status(404).json({ error: 'Campagne introuvable' });
    return;
  }
  res.json({ success: true, campaign: paused });
});

// --- GET /api/campaigns/:id/stats � m�triques d�taill�es --------------------

campaignsRouter.get('/:id/stats', async (req: Request, res: Response) => {
  const stats = await campaignService.getCampaignStats(req.params.id);
  if (!stats) {
    res.status(404).json({ error: 'Campagne introuvable' });
    return;
  }
  res.json(stats);
});
