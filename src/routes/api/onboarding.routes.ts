/**
 * AfriBot — onboarding commerçant LETTRÉ (MODULE 4 — chemin A).
 *
 * POST /api/onboarding/meta      : teste la connexion Meta puis sauvegarde
 * POST /api/onboarding/test-connection : message WhatsApp de contrôle
 *
 * Le test Meta appelle `GET graph.facebook.com/v20.0/{phoneNumberId}` avec le
 * token fourni — c'est la vérification la plus fiable avant de sauvegarder.
 */
import { Router, type Request, type Response } from 'express';
import axios from 'axios';
import { z } from 'zod';

import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { messageSender } from '../../shared/sender';
import { authMiddleware } from '../../shared/auth.middleware';
import { configService, type MerchantConfigUpdate } from '../../shared/config.service';
import { SINGLE_TENANT_MERCHANT_ID } from '../../shared/tenant';

export const onboardingRouter = Router();

onboardingRouter.use(authMiddleware);

const metaSchema = z.object({
  phoneNumberId: z.string().min(5).max(80),
  accessToken: z.string().min(20).max(500),
  webhookToken: z.string().min(10).max(200).optional(),
});

interface MetaPhoneInfo {
  display_phone_number?: string;
  verified_name?: string;
  name?: string;
  quality_rating?: string;
}

/** POST /api/onboarding/meta — test + sauvegarde des identifiants Meta. */
onboardingRouter.post('/meta', async (req: Request, res: Response) => {
  const parsed = metaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Requête invalide', details: parsed.error.flatten() });
    return;
  }

  const { phoneNumberId, accessToken, webhookToken } = parsed.data;
  const url = `${config.evolution.waBusinessUrl}/${config.evolution.waBusinessVersion}/${phoneNumberId}`;

  try {
    // 1. Test de connexion Meta API
    const response = await axios.get<MetaPhoneInfo>(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });

    // 2. Sauvegarde dans MerchantConfig (cache rafraîchi par updateConfig)
    const input: MerchantConfigUpdate = {
      waPhoneNumberId: phoneNumberId,
      waAccessToken: accessToken,
    };
    await configService.updateConfig(input, SINGLE_TENANT_MERCHANT_ID);

    // 3. Le webhook Evolution API est déjà configuré globalement (WA_BUSINESS_TOKEN_WEBHOOK) ;
    //    le token webhook fourni ici est journalisé pour la traçabilité du setup.
    if (webhookToken) {
      logger.info('Webhook token fourni pendant l\u2019onboarding Meta (déjà configuré au niveau serveur).');
    }

    logger.info(`Connexion Meta validée pour le Phone Number ID ${phoneNumberId}`);
    res.json({
      success: true,
      phoneNumber: response.data.display_phone_number ?? null,
      displayName: response.data.verified_name ?? response.data.name ?? null,
      qualityRating: response.data.quality_rating ?? null,
    });
  } catch (err) {
    logger.warn(`Test Meta échoué (${phoneNumberId}) : ${String(err)}`);
    res.status(400).json({
      success: false,
      error: 'Connexion Meta impossible : vérifiez le Phone Number ID et le token d\u2019accès.',
    });
  }
});

/** POST /api/onboarding/test-connection — message de contrôle WhatsApp. */
onboardingRouter.post('/test-connection', async (_req: Request, res: Response) => {
  const notifyPhone = await configService.getNotifyPhone(SINGLE_TENANT_MERCHANT_ID);
  if (!notifyPhone) {
    res.status(400).json({ error: 'Configurez d\u2019abord merchantNotifPhone ou MERCHANT_PHONE.' });
    return;
  }

  await messageSender.sendText(
    notifyPhone,
    '🎉 Connexion réussie ! AfriBot envoie bien des messages sur ce numéro.',
  );
  res.json({ success: true, sentTo: notifyPhone });
});