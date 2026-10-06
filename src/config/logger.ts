/**
 * AfriBot — configuration du logger Winston.
 *
 * - Console : colorisé en développement, JSON structuré en production
 *   (facile à agréger dans un stack Docker/ELK).
 * - Fichiers avec rotation quotidienne (winston-daily-rotate-file) :
 *     - logs/error.log    : erreurs uniquement (30 jours de rétention)
 *     - logs/combined.log : tous les niveaux (14 jours de rétention)
 */
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

import { config } from './env';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Format console lisible (développement)
const consoleFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack }) => {
    return `${ts} [${level}]: ${stack ?? message}`;
  }),
);

// Format JSON structuré (production)
const jsonFormat = combine(timestamp(), errors({ stack: true }), json());

// Rotation des fichiers — erreurs uniquement
const errorFileTransport = new DailyRotateFile({
  dirname: 'logs',
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxFiles: '30d',
  zippedArchive: true,
});

// Rotation des fichiers — tous les niveaux
const combinedFileTransport = new DailyRotateFile({
  dirname: 'logs',
  filename: 'combined-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  zippedArchive: true,
});

// Rotation des fichiers — audit paiements (PCI-like : transactions uniquement)
const paymentsFileTransport = new DailyRotateFile({
  dirname: 'logs',
  filename: 'payments-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  level: 'info',
  maxFiles: '90d',
  zippedArchive: true,
});

export const logger = winston.createLogger({
  level: config.server.logLevel,
  defaultMeta: { service: 'afribot' },
  transports: [
    new winston.transports.Console({
      format: config.server.isProduction ? jsonFormat : consoleFormat,
    }),
    errorFileTransport,
    combinedFileTransport,
    paymentsFileTransport,
  ],
  // Ne jamais faire crasher l'app sur une erreur de logging
  exitOnError: false,
});

/** Logger dédié à l'audit des transactions (fichier payments-*.log, rétention 90 j). */
export const paymentsLogger = logger.child({ audit: 'payments' });
