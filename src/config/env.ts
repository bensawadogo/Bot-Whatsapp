/**
 * AfriBot — chargement et validation des variables d'environnement.
 *
 * Toutes les variables sont validées avec Zod au démarrage : si une variable
 * obligatoire manque ou est invalide, le processus s'arrête avec une erreur
 * explicite (fail-fast) plutôt que de planter plus tard au runtime.
 *
 * Voir docs/CONFIGURATION.md pour la description complète de chaque variable.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schémas de validation par thème
// ---------------------------------------------------------------------------

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_URL: z.string().url({ message: "APP_URL doit être une URL valide (ex: https://tonbot.com)" }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Dashboard commerçant — authentification JWT (Phase 5)
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET doit faire au moins 32 caractères"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  DASHBOARD_ADMIN_EMAIL: z.string().email("DASHBOARD_ADMIN_EMAIL doit être un email valide"),
  DASHBOARD_ADMIN_PASSWORD: z.string().min(8, "DASHBOARD_ADMIN_PASSWORD doit faire au moins 8 caractères"),
});

const databaseSchema = z.object({
  DATABASE_URL: z
    .string()
    .startsWith("postgresql://", { message: "DATABASE_URL doit commencer par postgresql://" }),
});

const redisSchema = z.object({
  REDIS_URL: z.string().startsWith("redis://", { message: "REDIS_URL doit commencer par redis://" }),
  REDIS_PASSWORD: z.string().min(1, "REDIS_PASSWORD est obligatoire"),
  REDIS_PREFIX: z.string().default("afribot:"),
  SESSION_TTL: z.coerce.number().int().positive().default(1800),
});

const evolutionSchema = z.object({
  EVOLUTION_API_URL: z.string().url("EVOLUTION_API_URL doit être une URL valide"),
  EVOLUTION_API_KEY: z.string().min(1, "EVOLUTION_API_KEY est obligatoire"),
  EVOLUTION_INSTANCE_NAME: z.string().min(1, "EVOLUTION_INSTANCE_NAME est obligatoire"),
  // RÈGLE ABSOLUE : uniquement la Cloud API Meta officielle, jamais Baileys
  INTEGRATION: z.literal("WHATSAPP-BUSINESS", {
    errorMap: () => ({
      message:
        "INTEGRATION doit valoir WHATSAPP-BUSINESS (Cloud API Meta officiel). " +
        "Baileys est interdit : risque de bannissement du numéro.",
    }),
  }),
  WA_BUSINESS_TOKEN_WEBHOOK: z.string().min(1, "WA_BUSINESS_TOKEN_WEBHOOK est obligatoire"),
  WA_BUSINESS_URL: z.string().url().default("https://graph.facebook.com"),
  WA_BUSINESS_VERSION: z.string().default("v20.0"),
});

const paymentSchema = z.object({
  CINETPAY_SITE_ID: z.string().optional(),
  CINETPAY_API_KEY: z.string().optional(),
  CINETPAY_NOTIFY_URL: z.string().url().optional(),
  CINETPAY_CURRENCY: z.enum(["XOF", "XAF", "CDF", "GNF"]).default("XOF"),
  FEDAPAY_SECRET_KEY: z.string().optional(),
  FEDAPAY_PUBLIC_KEY: z.string().optional(),
  FEDAPAY_ENVIRONMENT: z.enum(["sandbox", "live"]).default("sandbox"),
  // --- MODE B : virement direct Wave / Orange Money / Moov (aucun agrégateur) ---
  // Le "owner" du numéro peut être dans la config dashboard (MerchantConfig) ;
  // ces variables servent de valeurs par défaut de repli.
  MERCHANT_WAVE_NUMBER: z
    .string()
    .regex(/^\+\?\d{8,15}$/, "MERCHANT_WAVE_NUMBER invalide (ex: +22670000000 ou 22670000000")
    .optional(),
  MERCHANT_ORANGE_NUMBER: z
    .string()
    .regex(/^\+?\d{8,15}$/, "MERCHANT_ORANGE_NUMBER invalide (ex: +22674000000 ou 22674000000")
    .optional(),
  MERCHANT_MOOV_NUMBER: z
    .string()
    .regex(/^\+?\d{8,15}$/, "MERCHANT_MOOV_NUMBER invalide (ex: +22676000000 ou 22676000000")
    .optional(),
  // --- MODE C : agrégateur PawaPay (activé quand l'entreprise est créée) ---
  // Laisser PAWAPAY_API_TOKEN vide → repli automatique sur le MODE B.
  PAWAPAY_API_TOKEN: z
    .preprocess((v) => (v === "" || v === null ? undefined : v), z.string().optional()),
  PAWAPAY_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
});

const chatwootSchema = z.object({
  CHATWOOT_URL: z.string().url().optional(),
  CHATWOOT_API_KEY: z.string().optional(),
  CHATWOOT_INBOX_ID: z.coerce.number().int().positive().optional(),
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive().optional(),
});

/** Numéro WhatsApp du commerçant (notifications) + horaires d'ouverture (Phase 6). */
const merchantSchema = z.object({
  // Identifiant du tenant mono-commerçant — DOIT rester aligné sur le
  // merchantId signé dans le JWT (auth.routes.ts : 'admin').
  MERCHANT_ID: z.string().min(1).default("admin"),
  MERCHANT_NAME: z.string().min(1).default("Mon commerce"),
  MERCHANT_PHONE: z
    .string()
    .regex(/^\+\?\d{8,15}$/, "MERCHANT_PHONE doit être un numéro international (ex: +221771234567 ou 221771234567)")
    .optional(),
  MERCHANT_TIMEZONE: z.string().default("Africa/Dakar"),
  // '' (variable vide dans .env) → undefined (horaires non configurés)
  MERCHANT_OPEN_HOUR: z
    .preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(0).max(23).optional()),
  MERCHANT_CLOSE_HOUR: z
    .preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(0).max(24).optional()),
});

const n8nSchema = z.object({
  N8N_URL: z.string().url().optional(),
  N8N_API_KEY: z.string().optional(),
  N8N_ENCRYPTION_KEY: z.string().optional(),
});

/** Voix (Phase 6) — providers de transcription : DigiDays (primaire en WACOME) et SmilGo (fallback). */
const speechSchema = z.object({
  DIGIDAYS_API_TOKEN: z.string().optional(),
  SMILGO_ENDPOINT: z.string().url().optional(),
  SMILGO_API_TOKEN: z.string().optional(),
});

// Campagnes pub ciblées (CTWA + Broadcast) — garde-fous anti-ban Meta
const campaignSchema = z.object({
  META_AD_ACCOUNT_ID: z.string().optional(),
  /// % de blocage déclenchant la pause automatique d'une campagne
  CAMPAIGN_MAX_BLOCK_RATE: z.coerce.number().min(0).max(100).default(2),
  /// Messages/heure selon le tier Meta (Tier 0: 10 | Tier 1: 40 | Tier 2: 400)
  CAMPAIGN_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(40),
  /// true = pause automatique si le score qualité passe en YELLOW
  CAMPAIGN_PAUSE_ON_YELLOW: z
    .preprocess((v) => (v === "" || v === null ? undefined : v === "true"), z.boolean())
    .default(false),
});

// ---------------------------------------------------------------------------
// Fusion des schémas + validation
// ---------------------------------------------------------------------------

const envSchema = serverSchema
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(evolutionSchema)
  .merge(paymentSchema)
  .merge(chatwootSchema)
  .merge(merchantSchema)
  .merge(n8nSchema)
  .merge(speechSchema)
  .merge(campaignSchema);

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(racine)"} : ${issue.message}`)
    .join("\n");
  throw new Error(`Variables d'environnement invalides ou manquantes :\n${details}`);
}

// Validation métier après fusion : horaires définis ensemble (ou pas du tout).
// Fait ici plutôt qu'en .refine() car ZodEffects (refine) n'est plus
// fusionnable via .merge() avec les autres schemas.
const merchantEnv = parsed.data;
if ((merchantEnv.MERCHANT_OPEN_HOUR === undefined) !== (merchantEnv.MERCHANT_CLOSE_HOUR === undefined)) {
  throw new Error(
    "Variables d'environnement invalides :\n" +
      "  - MERCHANT_OPEN_HOUR / MERCHANT_CLOSE_HOUR : doivent être définis ensemble (ou pas du tout).",
  );
}

// Validation timezone IANA (fail-fast)
function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" }).format(new Date());
  } catch {
    throw new Error(
      `Variables d'environnement invalides :\n  - MERCHANT_TIMEZONE : "${tz}" n'est pas un fuseau horaire IANA valide.`
    );
  }
}

// Appel après la validation merchantEnv
validateTimezone(merchantEnv.MERCHANT_TIMEZONE);

// ---------------------------------------------------------------------------
// Objet config typé, regroupé par thème
// ---------------------------------------------------------------------------

const env = parsed.data;

export const config = {
  server: {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    port: env.PORT,
    appUrl: env.APP_URL,
    logLevel: env.LOG_LEVEL,
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    dashboardAdminEmail: env.DASHBOARD_ADMIN_EMAIL,
    dashboardAdminPassword: env.DASHBOARD_ADMIN_PASSWORD,
  },
  database: { url: env.DATABASE_URL },
  redis: {
    url: env.REDIS_URL,
    password: env.REDIS_PASSWORD,
    prefix: env.REDIS_PREFIX,
    sessionTtl: env.SESSION_TTL,
  },
  evolution: {
    apiUrl: env.EVOLUTION_API_URL,
    apiKey: env.EVOLUTION_API_KEY,
    instanceName: env.EVOLUTION_INSTANCE_NAME,
    integration: env.INTEGRATION,
    waBusinessTokenWebhook: env.WA_BUSINESS_TOKEN_WEBHOOK,
    waBusinessUrl: env.WA_BUSINESS_URL,
    waBusinessVersion: env.WA_BUSINESS_VERSION,
  },
  payment: {
    cinetpay: {
      siteId: env.CINETPAY_SITE_ID,
      apiKey: env.CINETPAY_API_KEY,
      notifyUrl: env.CINETPAY_NOTIFY_URL,
      currency: env.CINETPAY_CURRENCY,
      baseUrl: "https://api-checkout.cinetpay.com/v2",
    },
    fedapay: {
      secretKey: env.FEDAPAY_SECRET_KEY,
      publicKey: env.FEDAPAY_PUBLIC_KEY,
      environment: env.FEDAPAY_ENVIRONMENT,
    },
    direct: {
      waveNumber: env.MERCHANT_WAVE_NUMBER,
      orangeNumber: env.MERCHANT_ORANGE_NUMBER,
      moovNumber: env.MERCHANT_MOOV_NUMBER,
    },
    pawapay: {
      apiToken: env.PAWAPAY_API_TOKEN,
      environment: env.PAWAPAY_ENVIRONMENT,
      baseUrl: env.PAWAPAY_ENVIRONMENT === "production" ? "https://api.pawapay.io" : "https://api.sandbox.pawapay.io",
    },
  },
  chatwoot: {
    url: env.CHATWOOT_URL,
    apiKey: env.CHATWOOT_API_KEY,
    inboxId: env.CHATWOOT_INBOX_ID,
    accountId: env.CHATWOOT_ACCOUNT_ID,
  },
  merchant: {
    id: env.MERCHANT_ID,
    name: env.MERCHANT_NAME,
    phone: env.MERCHANT_PHONE,
    timezone: env.MERCHANT_TIMEZONE,
    openHour: env.MERCHANT_OPEN_HOUR,
    closeHour: env.MERCHANT_CLOSE_HOUR,
  },
  n8n: {
    url: env.N8N_URL,
    apiKey: env.N8N_API_KEY,
    encryptionKey: env.N8N_ENCRYPTION_KEY,
  },
  speech: {
    digiDays: { token: env.DIGIDAYS_API_TOKEN },
    smigo: { endpoint: env.SMILGO_ENDPOINT, token: env.SMILGO_API_TOKEN },
  },
  campaigns: {
    metaAdAccountId: env.META_AD_ACCOUNT_ID,
    maxBlockRate: env.CAMPAIGN_MAX_BLOCK_RATE,
    rateLimitPerHour: env.CAMPAIGN_RATE_LIMIT_PER_HOUR,
    pauseOnYellow: env.CAMPAIGN_PAUSE_ON_YELLOW,
  },
} as const;

export type Config = typeof config;
