/**
 * AfriBot — soumission des templates Meta (MODULE 5.2).
 *
 * POST /api/templates/submit → soumet TOUS les templates de src/shared/templates.ts
 * à l'API Meta Graph. À appeler UNE FOIS lors de la mise en production ; Meta
 * les valide ensuite (quelques secondes à quelques minutes).
 *
 * Protégé par authMiddleware (dashboard commerçant).
 */
import { Router, type Request, type Response } from 'express';
import axios from 'axios';

import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { authMiddleware } from '../../shared/auth.middleware';
import { TEMPLATES, type MessageTemplate } from '../../shared/templates';
import { configService } from '../../shared/config.service';
import { SINGLE_TENANT_MERCHANT_ID } from '../../shared/tenant';

export const templatesRouter = Router();

templatesRouter.use(authMiddleware);

/** Soumet un template unique à l'API Meta Graph. */
async function submitTemplate(template: MessageTemplate): Promise<{ name: string; ok: boolean; detail: string }> {
  // Token prioritaire : celui stocké en base (dashboard), sinon le .env
  const cfg = await configService.getConfig(SINGLE_TENANT_MERCHANT_ID);
  const token = cfg.waAccessToken ?? config.evolution.waBusinessTokenWebhook;
  const phoneNumberId = cfg.waPhoneNumberId;

  if (!token || !phoneNumberId) {
    return {
      name: template.name,
      ok: false,
      detail: 'Identifiants Meta absents (waPhoneNumberId / token) — terminez l\u2019onboarding.',
    };
  }

  const url = `${config.evolution.waBusinessUrl}/${config.evolution.waBusinessVersion}/${phoneNumberId}/message_templates`;
  try {
    await axios.post(
      url,
      { name: template.name, language: template.language, category: template.category, components: template.components },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15_000 },
    );
    logger.info(`Template ${template.name} soumis à Meta`);
    return { name: template.name, ok: true, detail: 'Soumis à Meta — en attente de validation.' };
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? `${err.response?.status ?? 'réseau'} : ${JSON.stringify(err.response?.data ?? String(err.message))}`
      : String(err);
    logger.warn(`Soumission template ${template.name} échouée : ${detail}`);
    return { name: template.name, ok: false, detail };
  }
}

/** POST /api/templates/submit — soumet tous les templates d'un coup. */
templatesRouter.post('/submit', async (_req: Request, res: Response) => {
  const results = [];
  for (const template of Object.values(TEMPLATES)) {
    results.push(await submitTemplate(template));
  }

  const allOk = results.every((r) => r.ok);
  res.status(allOk ? 200 : 207).json({
    success: allOk,
    submitted: results.filter((r) => r.ok).length,
    results,
  });
});

/** GET /api/templates — liste locale des templates (aperçu avant soumission). */
templatesRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ templates: Object.values(TEMPLATES) });
});