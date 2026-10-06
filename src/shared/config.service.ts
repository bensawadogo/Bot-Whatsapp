/**
 * AfriBot — configuration du commerçant (MODULE 3).
 *
 * Source de vérité : table `merchant_configs`. Cache Redis 1 h (clé
 * `{prefix}config:{merchantId}`) — la config est lue à CHAQUE message
 * (horaires, messages, mode de paiement), donc le cache évite un aller-retour
 * PostgreSQL par message.
 *
 * `getConfig()` ne throw JAMAIS : en l'absence de ligne en base (premier
 * accès, bot pas encore configuré), elle retourne les valeurs de repli issues
 * de `.env`. C'est ce qui permet au bot de fonctionner AVANT l'onboarding.
 */
import { prisma } from '../config/database';
import { config } from '../config/env';
import { redis } from '../config/redis';
import { logger } from '../config/logger';
import { SINGLE_TENANT_MERCHANT_ID, ensureMerchant } from './tenant';

/** Modes de paiement (stratégie progressive — MODULE 2). */
export type PaymentMode = 'COD' | 'DIRECT' | 'PAWAPAY';

/** Durée de vie du cache de configuration (1 h). */
const CONFIG_CACHE_TTL_SECONDS = 3600;

/** Vue applicative complète de la configuration du commerçant. */
export interface MerchantConfigView {
  merchantId: string;
  businessName: string;
  businessDescription: string | null;
  logoUrl: string | null;
  openHour: number;
  closeHour: number;
  timezone: string;
  /** Jours fermés : 0 = dimanche … 6 = samedi. */
  closedDays: number[];
  welcomeMessage: string | null;
  closedMessage: string | null;
  thankYouMessage: string | null;
  paymentMode: PaymentMode;
  waveNumber: string | null;
  orangeNumber: string | null;
  moovNumber: string | null;
  pawaPayToken: string | null;
  deliveryEnabled: boolean;
  deliveryZones: string[];
  deliveryFee: number;
  codEnabled: boolean;
  defaultLanguage: string;
  supportedLanguages: string[];
  notifyMerchantOrders: boolean;
  merchantNotifPhone: string | null;
  waPhoneNumberId: string | null;
  waAccessToken: string | null;
  /** false = aucune ligne en base → le dashboard déclenche l'onboarding. */
  isConfigured: boolean;
}

/** Champs modifiables via PUT /api/config (tous optionnels). */
export interface MerchantConfigUpdate {
  businessName?: string | undefined;
  businessDescription?: string | null | undefined;
  logoUrl?: string | null | undefined;
  openHour?: number | undefined;
  closeHour?: number | undefined;
  timezone?: string | undefined;
  closedDays?: number[] | undefined;
  welcomeMessage?: string | null | undefined;
  closedMessage?: string | null | undefined;
  thankYouMessage?: string | null | undefined;
  paymentMode?: PaymentMode | undefined;
  waveNumber?: string | null | undefined;
  orangeNumber?: string | null | undefined;
  moovNumber?: string | null | undefined;
  pawaPayToken?: string | null | undefined;
  deliveryEnabled?: boolean | undefined;
  deliveryZones?: string[] | undefined;
  deliveryFee?: number | undefined;
  codEnabled?: boolean | undefined;
  defaultLanguage?: string | undefined;
  supportedLanguages?: string[] | undefined;
  notifyMerchantOrders?: boolean | undefined;
  merchantNotifPhone?: string | null | undefined;
  waPhoneNumberId?: string | null | undefined;
  waAccessToken?: string | null | undefined;
}

/** Parse un tableau JSON stocké en TEXT, avec repli sûr. */
function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

/** Configuration de repli (aucune ligne en base) — issue de `.env`. */
function fallbackConfig(merchantId: string): MerchantConfigView {
  return {
    merchantId,
    businessName: config.merchant.name,
    businessDescription: null,
    logoUrl: null,
    // Valeurs non configurées = 24/7, comme dans businessHours.ts et .env.example.
    openHour: config.merchant.openHour ?? 0,
    closeHour: config.merchant.closeHour ?? 24,
    timezone: config.merchant.timezone,
    closedDays: [],
    welcomeMessage: null,
    closedMessage: null,
    thankYouMessage: null,
    paymentMode: 'COD', // MODE A par défaut : toujours actif, aucun prérequis
    waveNumber: config.payment.direct.waveNumber ?? null,
    orangeNumber: config.payment.direct.orangeNumber ?? null,
    moovNumber: config.payment.direct.moovNumber ?? null,
    pawaPayToken: config.payment.pawapay.apiToken ?? null,
    deliveryEnabled: false,
    deliveryZones: [],
    deliveryFee: 0,
    codEnabled: true,
    defaultLanguage: 'fr',
    supportedLanguages: ['fr'],
    notifyMerchantOrders: true,
    merchantNotifPhone: config.merchant.phone ?? null,
    waPhoneNumberId: null,
    waAccessToken: null,
    isConfigured: false,
  };
}
/** Mappe une ligne Prisma vers la vue applicative. */
function toView(row: {
  merchantId: string;
  businessName: string;
  businessDescription: string | null;
  logoUrl: string | null;
  openHour: number;
  closeHour: number;
  timezone: string;
  closedDays: string;
  welcomeMessage: string | null;
  closedMessage: string | null;
  thankYouMessage: string | null;
  paymentMode: string;
  waveNumber: string | null;
  orangeNumber: string | null;
  moovNumber: string | null;
  pawaPayToken: string | null;
  deliveryEnabled: boolean;
  deliveryZones: string;
  deliveryFee: number;
  codEnabled: boolean;
  defaultLanguage: string;
  supportedLanguages: string;
  notifyMerchantOrders: boolean;
  merchantNotifPhone: string | null;
  waPhoneNumberId: string | null;
  waAccessToken: string | null;
}): MerchantConfigView {
  return {
    merchantId: row.merchantId,
    businessName: row.businessName,
    businessDescription: row.businessDescription,
    logoUrl: row.logoUrl,
    openHour: row.openHour,
    closeHour: row.closeHour,
    timezone: row.timezone,
    closedDays: parseJsonArray<number>(row.closedDays, []),
    welcomeMessage: row.welcomeMessage,
    closedMessage: row.closedMessage,
    thankYouMessage: row.thankYouMessage,
    paymentMode: row.paymentMode as PaymentMode,
    waveNumber: row.waveNumber,
    orangeNumber: row.orangeNumber,
    moovNumber: row.moovNumber,
    pawaPayToken: row.pawaPayToken,
    deliveryEnabled: row.deliveryEnabled,
    deliveryZones: parseJsonArray<string>(row.deliveryZones, []),
    deliveryFee: row.deliveryFee,
    codEnabled: row.codEnabled,
    defaultLanguage: row.defaultLanguage,
    supportedLanguages: parseJsonArray<string>(row.supportedLanguages, ['fr']),
    notifyMerchantOrders: row.notifyMerchantOrders,
    merchantNotifPhone: row.merchantNotifPhone,
    waPhoneNumberId: row.waPhoneNumberId,
    waAccessToken: row.waAccessToken,
    isConfigured: true,
  };
}
export class ConfigService {
  private key(merchantId: string): string {
    return `${config.redis.prefix}config:${merchantId}`;
  }

  /**
   * Configuration du commerçant (cache Redis 1 h). Ne throw jamais :
   * une erreur PostgreSQL/Redis retombe sur la config `.env`.
   */
  async getConfig(merchantId: string = SINGLE_TENANT_MERCHANT_ID): Promise<MerchantConfigView> {
    const key = this.key(merchantId);
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as MerchantConfigView;

      const row = await prisma.merchantConfig.findUnique({ where: { merchantId } });
      const view = row ? toView(row) : fallbackConfig(merchantId);
      await redis.set(key, JSON.stringify(view), 'EX', CONFIG_CACHE_TTL_SECONDS);
      return view;
    } catch (err) {
      logger.warn(`Lecture config ${merchantId} échouée (repli .env) : ${String(err)}`);
      return fallbackConfig(merchantId);
    }
  }

  /** Invalide le cache (appelé après PUT /api/config). */
  async invalidate(merchantId: string = SINGLE_TENANT_MERCHANT_ID): Promise<void> {
    try {
      await redis.del(this.key(merchantId));
    } catch (err) {
      logger.debug(`Invalidation config ${merchantId} échouée : ${String(err)}`);
    }
  }

  /** Le commerçant a-t-il terminé l'onboarding (ligne en base) ? */
  async isConfigured(merchantId: string = SINGLE_TENANT_MERCHANT_ID): Promise<boolean> {
    try {
      const row = await prisma.merchantConfig.findUnique({
        where: { merchantId },
        select: { merchantId: true },
      });
      return row !== null;
    } catch (err) {
      logger.warn(`Test de configuration ${merchantId} échoué : ${String(err)}`);
      return false;
    }
  }
/**
   * Crée ou met à jour la configuration (upsert partiel). Le commerçant est
   * créé au besoin. Retourne la config à jour et rafraîchit le cache.
   */
  async updateConfig(
    input: MerchantConfigUpdate,
    merchantId: string = SINGLE_TENANT_MERCHANT_ID,
  ): Promise<MerchantConfigView> {
    await ensureMerchant();
    const current = await this.getConfig(merchantId);

    const data = {
      ...(input.businessName !== undefined && { businessName: input.businessName.trim() }),
      ...(input.businessDescription !== undefined && { businessDescription: input.businessDescription }),
      ...(input.logoUrl !== undefined && { logoUrl: input.logoUrl }),
      ...(input.openHour !== undefined && { openHour: input.openHour }),
      ...(input.closeHour !== undefined && { closeHour: input.closeHour }),
      ...(input.timezone !== undefined && { timezone: input.timezone }),
      ...(input.closedDays !== undefined && { closedDays: JSON.stringify(input.closedDays) }),
      ...(input.welcomeMessage !== undefined && { welcomeMessage: input.welcomeMessage }),
      ...(input.closedMessage !== undefined && { closedMessage: input.closedMessage }),
      ...(input.thankYouMessage !== undefined && { thankYouMessage: input.thankYouMessage }),
      ...(input.paymentMode !== undefined && { paymentMode: input.paymentMode }),
      ...(input.waveNumber !== undefined && { waveNumber: input.waveNumber }),
      ...(input.orangeNumber !== undefined && { orangeNumber: input.orangeNumber }),
      ...(input.moovNumber !== undefined && { moovNumber: input.moovNumber }),
      ...(input.pawaPayToken !== undefined && { pawaPayToken: input.pawaPayToken }),
      ...(input.deliveryEnabled !== undefined && { deliveryEnabled: input.deliveryEnabled }),
      ...(input.deliveryZones !== undefined && { deliveryZones: JSON.stringify(input.deliveryZones) }),
      ...(input.deliveryFee !== undefined && { deliveryFee: input.deliveryFee }),
      ...(input.codEnabled !== undefined && { codEnabled: input.codEnabled }),
      ...(input.defaultLanguage !== undefined && { defaultLanguage: input.defaultLanguage }),
      ...(input.supportedLanguages !== undefined && {
        supportedLanguages: JSON.stringify(input.supportedLanguages),
      }),
      ...(input.notifyMerchantOrders !== undefined && { notifyMerchantOrders: input.notifyMerchantOrders }),
      ...(input.merchantNotifPhone !== undefined && { merchantNotifPhone: input.merchantNotifPhone }),
      ...(input.waPhoneNumberId !== undefined && { waPhoneNumberId: input.waPhoneNumberId }),
      ...(input.waAccessToken !== undefined && { waAccessToken: input.waAccessToken }),
    };

    const row = await prisma.merchantConfig.upsert({
      where: { merchantId },
      create: {
        merchantId,
        businessName: input.businessName?.trim() ?? current.businessName,
        ...data,
      },
      update: data,
    });

    const view = toView(row);
    // Écriture directe dans le cache : la config vient d'être modifiée, elle
    // doit être visible immédiatement par le prochain message traité.
    await redis.set(this.key(merchantId), JSON.stringify(view), 'EX', CONFIG_CACHE_TTL_SECONDS);
    logger.info(`Configuration commerçant ${merchantId} mise à jour`);
    return view;
  }

  /** Nom affiché du commerce (header du dashboard, messages WhatsApp). */
  async getBusinessName(merchantId: string = SINGLE_TENANT_MERCHANT_ID): Promise<string> {
    return (await this.getConfig(merchantId)).businessName;
  }

  /**
   * Numéro à alerter pour les commandes/livraisons : le numéro de notification
   * dédié s'il est configuré, sinon le numéro WhatsApp du commerçant.
   */
  async getNotifyPhone(merchantId: string = SINGLE_TENANT_MERCHANT_ID): Promise<string | null> {
    const cfg = await this.getConfig(merchantId);
    return cfg.merchantNotifPhone ?? config.merchant.phone ?? null;
  }
}

export const configService = new ConfigService();