/**
 * AfriBot — point d'entrée de l'application.
 *
 * Structure du démarrage :
 *  1. Chargement et validation des variables d'environnement (config/env.ts)
 *  2. Configuration du logger (config/logger.ts)
 *  3. Serveur Express avec middlewares de sécurité
 *  4. Routes webhook Evolution API
 *  5. Healthcheck + graceful shutdown (SIGTERM / SIGINT)
 *
 * Rappel : les messages entrants proviennent exclusivement de la Cloud API
 * Meta officielle, relayés par Evolution API (jamais Baileys).
 */
import 'dotenv/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('express-async-errors');
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import { config } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/database';
import { redisHealthCheck } from './config/redis';
import { webhookRouter } from './shared/webhook.controller';
import { catalogRouter } from './routes/api/catalog.routes';
import { ordersRouter } from './routes/api/orders.routes';
import { authRouter } from './routes/api/auth.routes';
import { statsRouter } from './routes/api/stats.routes';
import { catalogAdminRouter } from './routes/api/catalog.admin.routes';
import { refundsRouter } from './routes/api/refunds.routes';
import { deliveryRouter } from './routes/api/delivery.routes';
import { configRouter } from './routes/api/config.routes';
import { onboardingRouter } from './routes/api/onboarding.routes';
import { templatesRouter } from './routes/api/templates.routes';
import { complianceRouter } from './routes/api/compliance.routes';
import { campaignsRouter } from './routes/api/campaigns.routes';

const app: Express = express();

// ---------------------------------------------------------------------------
// Middlewares globaux
// ---------------------------------------------------------------------------
app.use(helmet()); // En-têtes de sécurité HTTP
app.use(cors({ origin: [config.server.appUrl] })); // CORS (dashboard commerçant)
app.use(compression()); // Compression gzip — connexions lentes 2G/3G

// Rate limiting — anti-abuse (limite distincte par surface)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/webhook', webhookLimiter);
app.use('/api', apiLimiter);

// Corps brut UNIQUEMENT pour /webhook/messages (HMAC sur le raw body + images)
app.use('/webhook/messages', express.raw({ type: 'application/json', limit: '10mb' }));
// JSON pour toutes les autres routes (/api + /webhook/payment)
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Healthcheck (utilisé par le HEALTHCHECK du Dockerfile)
// ---------------------------------------------------------------------------
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const redisOk = await redisHealthCheck();
    let dbOk = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }
    if (redisOk && dbOk) {
      res.status(200).json({ status: 'ok', timestamp: new Date() });
    } else {
      res.status(503).json({ status: 'degraded', redis: redisOk, db: dbOk, timestamp: new Date() });
    }
  } catch {
    res.status(503).json({ status: 'degraded', redis: false, db: false, timestamp: new Date() });
  }
});

// ---------------------------------------------------------------------------
// Webhooks Evolution API (messages entrants Cloud API Meta)
// ---------------------------------------------------------------------------
app.use('/webhook', webhookRouter);

// ---------------------------------------------------------------------------
// API REST du dashboard (catalogue — Phase 1)
// ---------------------------------------------------------------------------
app.use('/api', catalogRouter);
app.use('/api', ordersRouter);
app.use('/api', catalogAdminRouter);
app.use('/api', refundsRouter);
app.use('/api/auth', authRouter);
app.use('/api/stats', statsRouter);
// MODULES 1, 3, 4 & 5 — livraison, configuration, onboarding, conformité
app.use('/api/delivery', deliveryRouter);
app.use('/api/config', configRouter);
app.use('/api/onboarding', onboardingRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/compliance', complianceRouter);
// MODULE CAMPAGNES — pub ciblées CTWA + broadcast (anti-ban)
app.use('/api/campaigns', campaignsRouter);

// ---------------------------------------------------------------------------
// Dashboard commerçant — interface web statique (Phase 5)
// __dirname = src/ (dev) ou dist/ (prod) → ../public/dashboard dans les deux cas
// ---------------------------------------------------------------------------
app.use('/dashboard', express.static(path.join(__dirname, '../public/dashboard')));

// ---------------------------------------------------------------------------
// Gestion des erreurs
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route introuvable' });
});

app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  logger.error(`Erreur non gérée : ${err.message}`, { stack: err.stack });
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ---------------------------------------------------------------------------
// Démarrage du serveur — vérification Redis/Prisma avant d'accepter du trafic
// ---------------------------------------------------------------------------
async function checkDependencies(): Promise<{ redisOk: boolean; dbOk: boolean }> {
  const redisOk = await redisHealthCheck();
  let dbOk = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbOk = false;
  }
  return { redisOk, dbOk };
}

async function start(): Promise<void> {
  // En test on ne bloque jamais le démarrage (mocks ioredis / prisma)
  if (config.server.nodeEnv !== 'test') {
    const { redisOk, dbOk } = await checkDependencies();
    if (!redisOk || !dbOk) {
      logger.error(`Dépendances indisponibles au démarrage — redis=${redisOk} db=${dbOk}`);
      throw new Error('Startup healthcheck failed: Redis ou PostgreSQL injoignable');
    }
  }
  server.on('error', (err: Error) => {
    logger.error(`Échec démarrage HTTP : ${err.message}`);
    process.exit(1);
  });
}

const server = app.listen(config.server.port, () => {
  logger.info(`AfriBot démarré sur ${config.server.appUrl}:${config.server.port}`);
  void start().catch((err: Error) => {
    logger.error(`Arrêt — démarrage impossible : ${err.message}`);
    server.close(() => process.exit(1));
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — arrêt propre sans perte de messages en cours
// ---------------------------------------------------------------------------
function shutdown(signal: string): void {
  logger.warn(`Signal ${signal} reçu — arrêt en cours...`);
  server.close(() => {
    logger.info('Serveur HTTP fermé. Processus terminé.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Rejection non gérée', { reason: String(reason) });
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Exception non interceptée', { message: err.message, stack: err.stack });
  process.exit(1);
});

// API d'écriture catalogue : /api/catalog (admin JWT) — catalog.admin.routes.ts
// Connexions Redis/Prisma vérifiées au démarrage (checkDependencies ci-dessus).
