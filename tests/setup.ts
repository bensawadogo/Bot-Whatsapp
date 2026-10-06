/**
 * AfriBot — variables d'environnement minimales pour les tests unitaires.
 * Chargées via jest.config.js (setupFiles) AVANT tout import de module,
 * car src/config/env.ts fait un fail-fast si une variable requise manque.
 */
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://afribot.test';
process.env.DATABASE_URL = 'postgresql://afribot:test@localhost:5432/afribot_test';
process.env.REDIS_URL = 'redis://:test-password@localhost:6379/0';
process.env.REDIS_PASSWORD = 'test-password';
process.env.EVOLUTION_API_URL = 'http://localhost:8080';
process.env.EVOLUTION_API_KEY = 'test-evolution-key';
process.env.EVOLUTION_INSTANCE_NAME = 'afribot-test';
process.env.INTEGRATION = 'WHATSAPP-BUSINESS';
process.env.WA_BUSINESS_TOKEN_WEBHOOK = 'test-webhook-token';
process.env.LOG_LEVEL = 'error'; // silencieux pendant les tests
// Paiements (Phase 2 — tests unitaires sans appels réseau réels)
process.env.CINETPAY_SITE_ID = 'test-site-id';
process.env.CINETPAY_API_KEY = 'test-api-key';
process.env.CINETPAY_NOTIFY_URL = 'http://localhost:3000/webhook/payment';
process.env.FEDAPAY_SECRET_KEY = 'test-fedapay-secret';
process.env.FEDAPAY_ENVIRONMENT = 'sandbox';
// Dashboard commerçant (auth JWT — Phase 5)
process.env.JWT_SECRET = 'test-secret-32-caracteres-minimum-ok-1234';
process.env.JWT_EXPIRES_IN = '1h';
process.env.DASHBOARD_ADMIN_EMAIL = 'admin@afribot.test';
process.env.DASHBOARD_ADMIN_PASSWORD = 'motdepassefort123';