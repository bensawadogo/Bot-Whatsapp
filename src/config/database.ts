/**
 * AfriBot — client Prisma (PostgreSQL).
 *
 * Singleton partagé par tous les modules (catalogue, commandes, paiements).
 * Le logging des requêtes est activé uniquement hors production afin de
 * ne pas dégrader les performances ni polluer les logs en production.
 */
import { PrismaClient } from '@prisma/client';

import { config } from './env';
import { logger } from './logger';

export const prisma = new PrismaClient({
  log: config.server.isProduction
    ? [{ emit: 'event', level: 'error' }]
    : [{ emit: 'event', level: 'query' }, { emit: 'event', level: 'error' }, { emit: 'event', level: 'warn' }],
});

// Les requêtes Prisma sont routées vers winston (un seul système de logs)
prisma.$on('query' as never, (event: unknown) => {
  const e = event as { query: string; duration: number };
  logger.debug(`Prisma query (${e.duration}ms) : ${e.query}`);
});

prisma.$on('warn' as never, (event: unknown) => {
  const e = event as { message: string };
  logger.warn(`Prisma : ${e.message}`);
});

prisma.$on('error' as never, (event: unknown) => {
  const e = event as { message: string };
  logger.error(`Prisma : ${e.message}`);
});
