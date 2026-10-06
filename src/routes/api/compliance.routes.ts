/**
 * AfriBot — rendre la conformité Meta OBSERVABLE (SCÉNARIO 4).
 *
 * Les blocages d'envoi (hors fenêtre 24 h, contenu non conforme) sont déjà
 * journalisés par sender.ts dans logs/combined.log. Ce router expose le même
 * diagnostic en HTTP pour que le dashboard puisse répondre à la question
 * « pourquoi mon message n'est-il pas parti ? » sans accès au serveur.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { logger } from '../../config/logger';
import { authMiddleware } from '../../shared/auth.middleware';
import {
  checkMessageCompliance,
  checkWindowCompliance,
  enforceOptIn,
  normalize,
} from '../../shared/meta.compliance';

export const complianceRouter = Router();

complianceRouter.use(authMiddleware);

const checkSchema = z.object({
  phone: z.string().min(6),
  message: z.string().min(1).max(4096),
  type: z.string().default('service'),
});

/**
 * POST /api/compliance/check
 * Vérifie un message avant envoi : contenu + opt-in + fenêtre 24 h.
 * Utilisé par le dashboard (« Tester mon bot ») et les tests manuels.
 */
complianceRouter.post('/check', async (req: Request, res: Response) => {
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Requête invalide', details: parsed.error.flatten() });
    return;
  }

  const { phone, message, type } = parsed.data;
  const content = checkMessageCompliance(message, type);
  const [optIn, window] = await Promise.all([
    enforceOptIn(phone),
    checkWindowCompliance(phone),
  ]);

  const canSend = type === 'template' || (optIn && window.status === 'IN_WINDOW');
  logger.debug(`Contrôle conformité ${normalize(phone)} : canSend=${String(canSend)}`);

  res.json({
    phone: normalize(phone),
    canSend: canSend && content.valid,
    content,
    optIn,
    window,
  });
});