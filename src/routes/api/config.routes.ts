/**
 * AfriBot — routes API configuration commerçant (MODULE 3.2).
 * Toutes protégées par authMiddleware. Après chaque PUT, le cache Redis de
 * configuration (1 h) est rafraîchi par configService.updateConfig().
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { logger } from '../../config/logger';
import { messageSender } from '../../shared/sender';
import { authMiddleware } from '../../shared/auth.middleware';
import { configService } from '../../shared/config.service';
import { SINGLE_TENANT_MERCHANT_ID } from '../../shared/tenant';
import * as deliveryService from '../../modules/delivery/delivery.service';

export const configRouter = Router();

configRouter.use(authMiddleware);

// --- Schémas Zod -----------------------------------------------------------

const phoneRegex = /^\+?\d{8,15}$/;

const configUpdateSchema = z.object({
  businessName: z.string().min(2).max(60).optional(),
  businessDescription: z.string().max(300).nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
  openHour: z.number().int().min(0).max(23).optional(),
  closeHour: z.number().int().min(0).max(24).optional(),
  timezone: z.string().max(60).optional(),
  closedDays: z.array(z.number().int().min(0).max(6)).optional(),
  welcomeMessage: z.string().max(500).nullable().optional(),
  closedMessage: z.string().max(500).nullable().optional(),
  thankYouMessage: z.string().max(500).nullable().optional(),
  paymentMode: z.enum(['COD', 'DIRECT', 'PAWAPAY']).optional(),
  waveNumber: z.string().regex(phoneRegex).nullable().optional(),
  orangeNumber: z.string().regex(phoneRegex).nullable().optional(),
  moovNumber: z.string().regex(phoneRegex).nullable().optional(),
  pawaPayToken: z.string().max(200).nullable().optional(),
  deliveryEnabled: z.boolean().optional(),
  deliveryZones: z.array(z.string().max(80)).optional(),
  deliveryFee: z.number().min(0).max(1_000_000).optional(),
  codEnabled: z.boolean().optional(),
  defaultLanguage: z.string().max(10).optional(),
  supportedLanguages: z.array(z.string().max(10)).optional(),
  notifyMerchantOrders: z.boolean().optional(),
  merchantNotifPhone: z.string().regex(phoneRegex).nullable().optional(),
  waPhoneNumberId: z.string().max(80).nullable().optional(),
  waAccessToken: z.string().max(500).nullable().optional(),
});

const livreurSchema = z.object({
  name: z.string().min(2).max(60),
  phone: z.string().regex(phoneRegex),
  zone: z.string().max(120).optional(),
});

// --- GET /api/config — config complète --------------------------------------

configRouter.get('/', async (_req: Request, res: Response) => {
  const cfg = await configService.getConfig(SINGLE_TENANT_MERCHANT_ID);
  res.json({ config: cfg });
});

// --- PUT /api/config — mise à jour (validation Zod stricte) ------------------

configRouter.put('/', async (req: Request, res: Response) => {
  const parsed = configUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Requête invalide', details: parsed.error.flatten() });
    return;
  }

  // updateConfig rafraîchit le cache Redis {prefix}config:{merchantId} (TTL 1 h)
  const cfg = await configService.updateConfig(parsed.data, SINGLE_TENANT_MERCHANT_ID);
  logger.info('Config mise à jour depuis le dashboard');
  res.json({ success: true, config: cfg });
});

// --- PUT /api/config/welcome-message — message d'accueil (testé avant save) --

const welcomeSchema = z.object({
  message: z.string().min(2).max(500),
  language: z.string().max(10).default('fr'),
});

configRouter.put('/welcome-message', async (req: Request, res: Response) => {
  const parsed = welcomeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Requête invalide', details: parsed.error.flatten() });
    return;
  }

  const { message, language } = parsed.data;

  // Test AVANT sauvegarde : on envoie le message au numéro de notification
  // pour que le commerçant voie le rendu WhatsApp réel.
  const notifyPhone = await configService.getNotifyPhone(SINGLE_TENANT_MERCHANT_ID);
  if (!notifyPhone) {
    res.status(400).json({ error: 'Aucun numéro de notification configuré (merchantNotifPhone)' });
    return;
  }
  await messageSender.sendText(notifyPhone, `🔍 Aperçu de votre message d'accueil :\n\n${message}`);

  const cfg = await configService.updateConfig(
    { welcomeMessage: message, defaultLanguage: language },
    SINGLE_TENANT_MERCHANT_ID,
  );
  res.json({ success: true, config: cfg });
});

// --- POST /api/config/test-message — vérifier la connexion WhatsApp ----------

const testSchema = z.object({ message: z.string().max(300).optional() });

configRouter.post('/test-message', async (req: Request, res: Response) => {
  const parsed = testSchema.safeParse(req.body ?? {});
  const message = parsed.success && parsed.data.message ? parsed.data.message : '✅ Connexion réussie ! AfriBot est bien connecté à WhatsApp.';

  const notifyPhone = await configService.getNotifyPhone(SINGLE_TENANT_MERCHANT_ID);
  if (!notifyPhone) {
    res.status(400).json({ error: 'Aucun numéro de notification configuré (merchantNotifPhone ou MERCHANT_PHONE)' });
    return;
  }
  await messageSender.sendText(notifyPhone, message);
  logger.info(`Message de test envoyé au commerçant (${notifyPhone})`);
  res.json({ success: true, sentTo: notifyPhone, message });
});

// --- POST /api/config/livreur — ajouter un livreur ---------------------------

configRouter.post('/livreur', async (req: Request, res: Response) => {
  const parsed = livreurSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Requête invalide', details: parsed.error.flatten() });
    return;
  }

  try {
    const livreur = await deliveryService.createLivreur({
      merchantId: SINGLE_TENANT_MERCHANT_ID,
      ...parsed.data,
    });

    // Message de bienvenue : le livreur apprend IMMÉDIATEMENT les mots-clés
    const businessName = await configService.getBusinessName(SINGLE_TENANT_MERCHANT_ID);
    await messageSender.sendText(
      livreur.phone,
      [
        `👋 Bonjour ${livreur.name} ! Vous êtes maintenant livreur pour ${businessName}.`,
        'Vous recevrez les commandes ici.',
        'Tapez *DISPO* si disponible, *INDISPO* si pas disponible.',
      ].join('\n'),
    );

    logger.info(`Livreur ${livreur.name} ajouté depuis le dashboard`);
    res.status(201).json({ success: true, livreur });
  } catch (err) {
    // Contrainte UNIQUE sur le numéro (livreur déjà enregistré)
    logger.warn(`Création livreur échouée : ${String(err)}`);
    res.status(409).json({ error: 'Ce numéro de livreur est déjà enregistré' });
  }
});

// --- DELETE /api/config/livreur/:id — désactivation (soft delete) ------------

configRouter.delete('/livreur/:id', async (req: Request, res: Response) => {
  const livreur = await deliveryService.deactivateLivreur(req.params.id);
  if (!livreur) {
    res.status(404).json({ error: 'Livreur introuvable' });
    return;
  }
  res.json({ success: true, livreur });
});