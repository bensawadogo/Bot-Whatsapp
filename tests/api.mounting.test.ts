/**
 * Tests — ORDRE DE MONTAGE des routeurs sur `/api` (non-régression).
 *
 * Contexte (bug réel corrigé) : `refundsRouter` appliquait `router.use(authMiddleware)`
 * de façon GLOBALE alors qu'il est monté sur `/api` (AVANT `/api/auth` dans
 * src/index.ts). Express exécute un `router.use()` sans chemin pour TOUT préfixe
 * correspondant, même si aucune route ne matche → `/api/auth/login` recevait
 * « 401 Token manquant » et la connexion au dashboard était impossible.
 *
 * `tests/auth.routes.test.ts` ne pouvait pas détecter ce bug : il monte
 * `authRouter` SEUL dans une app minimale. Ce fichier reproduit donc l'ordre de
 * montage RÉEL de src/index.ts.
 */
import express from 'express';
import request from 'supertest';

import { catalogRouter } from '../src/routes/api/catalog.routes';
import { ordersRouter } from '../src/routes/api/orders.routes';
import { catalogAdminRouter } from '../src/routes/api/catalog.admin.routes';
import { refundsRouter } from '../src/routes/api/refunds.routes';
import { authRouter } from '../src/routes/api/auth.routes';

const ADMIN_EMAIL = 'admin@afribot.test'; // tests/setup.ts
const ADMIN_PASSWORD = 'motdepassefort123'; // tests/setup.ts

/**
 * Réplique de l'ordre de montage de src/index.ts (lignes 104-108) :
 * les routeurs `/api` (catalogue, commandes, remboursements) sont montés
 * AVANT `/api/auth`.
 */
const app = express();
app.use(express.json());
app.use('/api', catalogRouter);
app.use('/api', ordersRouter);
app.use('/api', catalogAdminRouter);
app.use('/api', refundsRouter);
app.use('/api/auth', authRouter);

describe('Montage des routeurs /api — /api/auth reste accessible', () => {
  it('/api/auth/login ne doit PAS être intercepté par les routeurs montés avant (200)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe('string');
  });

  it('/api/auth/me sans token → 401 Token manquant (auth bien appliquée)', async () => {
    const res = await request(app).get('/api/auth/me').expect(401);

    expect(res.body.error).toContain('Token manquant');
  });

  it('/api/refunds/:id/refundable sans token → 401 (auth par route toujours active)', async () => {
    const res = await request(app).get('/api/refunds/cmd-1/refundable').expect(401);

    expect(res.body.error).toContain('Token manquant');
  });

  it('/api/refunds/:id sans token → 401 (auth par route toujours active)', async () => {
    await request(app).post('/api/refunds/cmd-1').expect(401);
  });
});
