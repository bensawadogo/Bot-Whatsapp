/**
 * AfriBot — client Redis (ioredis).
 *
 * Usage : sessions conversationnelles (TTL 30 min) + cache catalogue.
 * Base Redis 0 pour AfriBot ; les bases 1 (Evolution) et 2 (Chatwoot)
 * sont réservées par les autres services du docker-compose.
 */
import Redis, { type RedisOptions } from 'ioredis';

import { config } from './env';
import { logger } from './logger';

const isTestMode = process.env.NODE_ENV === 'test';

const redisOptions: RedisOptions = {
  maxRetriesPerRequest: 3,
  lazyConnect: isTestMode,
  ...(isTestMode
    ? {
        retryStrategy: null,
        enableOfflineQueue: false,
      }
    : {
        retryStrategy: (times: number): number => Math.min(times * 50, 2000),
      }),
};

export const redis = new Redis(config.redis.url, redisOptions);

let lastErrorLog = 0;
const ERROR_THROTTLE_MS = 30_000;

let lastReconnectLog = 0;

redis.on('connect', () => {
  logger.info('Redis connecté');
  lastErrorLog = 0;
  lastReconnectLog = 0;
});

redis.on('error', (err: Error) => {
  const now = Date.now();
  if (now - lastErrorLog > ERROR_THROTTLE_MS) {
    lastErrorLog = now;
    logger.error(`Erreur Redis : ${err.message}`);
  }
});

redis.on('reconnecting', () => {
  const now = Date.now();
  if (now - lastReconnectLog > ERROR_THROTTLE_MS) {
    lastReconnectLog = now;
    logger.warn('Redis — reconnexion en cours...');
  }
});

export async function redisHealthCheck(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}
