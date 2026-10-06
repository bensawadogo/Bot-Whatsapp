/**
 * @file auth.routes.ts
 * @description Routes d'authentification dashboard commerçant (Phase 5).
 *
 *   POST /api/auth/login    → JWT (email + mot de passe admin, env vars)
 *   POST /api/auth/refresh  → nouveau token (ancien expiré depuis < 1h)
 *   GET  /api/auth/me       → profil du commerçant connecté (protégé)
 *
 * Multi-clients (SaaS) : merchantId = 'admin' pour l'instant — un commerçant
 * par déploiement. Le système de tenants viendra en Phase 5b (docs/TODO.md).
 */
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { authMiddleware, type AuthenticatedRequest } from '../../shared/auth.middleware';

const router = Router();

/**
 * Limiteur anti-brute-force dédié au login :
 * 10 tentatives / 15 min / IP (429 au-delà).
 * Complète le apiLimiter global (100 req/min).
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const loginSchema = z.object({
  email: z.string().email('Email invalide'),
  password: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères'),
});

/** Signe un JWT { merchantId, email } avec la durée configurée. */
function signToken(merchantId: string, email: string): string {
  return jwt.sign({ merchantId, email }, config.server.jwtSecret, {
    // string env ('7d') → type StringValue de @types/jsonwebtoken (ms)
    expiresIn: config.server.jwtExpiresIn as unknown as NonNullable<jwt.SignOptions['expiresIn']>,
  });
}

/**
 * Hash bcrypt de référence, dérivé UNE SEULE FOIS au chargement du module :
 * si la variable d'environnement contient déjà un hash ($2a$/$2b$/$2y$),
 * on l'utilise tel quel ; sinon on hashe le mot de passe en clair (stateless,
 * rien n'est persisté en base).
 */
const ADMIN_PASSWORD_HASH: string = ((): string => {
  const configured = config.server.dashboardAdminPassword;
  if (configured.startsWith('$2a$') || configured.startsWith('$2b$') || configured.startsWith('$2y$')) {
    return configured;
  }
  return bcrypt.hashSync(configured, 10);
})();

/** Compare le mot de passe soumis au hash bcrypt (jamais de comparaison en clair). */
async function passwordMatches(plain: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, ADMIN_PASSWORD_HASH);
  } catch (err) {
    logger.error(`Vérification bcrypt impossible : ${String(err)}`);
    return false;
  }
}

/**
 * POST /api/auth/login — échange identifiants admin contre un JWT.
 */
router.post('/login', loginLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? 'Requête invalide' });
      return;
    }
    const { email, password } = parsed.data;
    const adminEmail = config.server.dashboardAdminEmail.toLowerCase();

    const passwordOk = await passwordMatches(password);
    if (email.toLowerCase() !== adminEmail || !passwordOk) {
      logger.warn(`Tentative de connexion échouée pour ${email}`);
      res.status(401).json({ success: false, error: 'Identifiants invalides' });
      return;
    }

    logger.info(`Connexion dashboard réussie pour ${email}`);
    res.json({
      success: true,
      token: signToken('admin', adminEmail),
      expiresIn: config.server.jwtExpiresIn,
      merchantEmail: adminEmail,
    });
  } catch (error) {
    logger.error(`Erreur inattendue sur /login : ${String(error)}`);
    res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

/**
 * POST /api/auth/refresh — renouvelle un token expiré depuis moins d'1h.
 */
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Token manquant — Authorization: Bearer <token> requis' });
    return;
  }

  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], config.server.jwtSecret, {
      ignoreExpiration: true,
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') {
      throw new Error('Payload JWT inattendu');
    }
    // Grâce d'1h après expiration (sinon reconnexion obligatoire)
    if (typeof decoded.exp !== 'number' || decoded.exp + 3600 < Math.floor(Date.now() / 1000)) {
      throw new Error('Token expiré depuis trop longtemps');
    }
    res.json({
      success: true,
      token: signToken(decoded.merchantId, decoded.email),
      expiresIn: config.server.jwtExpiresIn,
    });
  } catch (error) {
    logger.warn(`Refresh refusé : ${String(error)}`);
    res.status(401).json({ success: false, error: 'Token invalide ou expiré — reconnecte-toi' });
  }
});

/**
 * GET /api/auth/me — profil du commerçant connecté (protégé).
 */
router.get('/me', authMiddleware, (req: AuthenticatedRequest, res: Response): void => {
  res.json({
    success: true,
    merchantId: req.merchantId,
    email: req.merchantEmail,
    serverTime: new Date().toISOString(),
  });
});

export { router as authRouter };