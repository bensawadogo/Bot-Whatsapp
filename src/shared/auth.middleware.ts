/**
 * @file auth.middleware.ts
 * @description Middleware JWT pour les routes dashboard protégées (Phase 5).
 *
 * Vérifie le header `Authorization: Bearer <token>`, décode le payload
 * (merchantId + email) et l'expose sur la requête typée pour les handlers.
 */
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import { config } from '../config/env';
import { logger } from '../config/logger';

/**
 * Requête enrichie après authentification réussie.
 * (Le payload JWT est vérifié via jwt.verify + narrowing typeof — pas de
 * type local nécessaire.)
 */

/** Requête Express enrichie du profil commerçant après vérification du JWT. */
export interface AuthenticatedRequest extends Request {
  merchantId?: string;
  merchantEmail?: string;
}

/**
 * Vérifie le token JWT dans le header Authorization: Bearer <token>.
 * Rejette avec 401 si absent, invalide ou expiré.
 */
export const authMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'Token manquant — Authorization: Bearer <token> requis',
    });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.server.jwtSecret, { algorithms: ['HS256'] });
    if (typeof decoded === 'string') {
      throw new Error('Payload JWT inattendu');
    }
    if (typeof decoded.merchantId !== 'string' || decoded.merchantId.length === 0) {
      throw new Error('Payload JWT sans merchantId valide');
    }
    req.merchantId = decoded.merchantId;
    req.merchantEmail = decoded.email;
    next();
  } catch (error) {
    logger.warn(`Token JWT invalide ou expiré : ${String(error)}`);
    res.status(401).json({
      success: false,
      error: 'Token invalide ou expiré — reconnecte-toi',
    });
  }
};