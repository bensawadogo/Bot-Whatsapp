/**
 * Tests — routes d'authentification dashboard (Phase 5).
 * Les variables admin sont posées par tests/setup.ts (env.ts fail-fast).
 */
import express from 'express';
import request from 'supertest';

import { authRouter } from '../src/routes/api/auth.routes';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

const ADMIN_EMAIL = 'admin@afribot.test'; // tests/setup.ts
const ADMIN_PASSWORD = 'motdepassefort123'; // tests/setup.ts

describe('POST /api/auth/login', () => {
  it('retourne un token avec les bons identifiants (200)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.split('.')).toHaveLength(3); // JWT header.payload.signature
    expect(res.body.merchantEmail).toBe(ADMIN_EMAIL);
    expect(res.body.expiresIn).toBe('1h'); // JWT_EXPIRES_IN de tests/setup.ts
  });

  it('rejette un mauvais mot de passe (401)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'mauvais-mot-de-passe' })
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Identifiants invalides');
  });

  it('rejette un email manquant (400)', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: ADMIN_PASSWORD }).expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });
});

describe('GET /api/auth/me (protégé)', () => {
  it('rejette une requête sans token (401)', async () => {
    const res = await request(app).get('/api/auth/me').expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Token manquant');
  });

  it('retourne le profil avec un token valide (200)', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.merchantId).toBe('admin');
    expect(res.body.email).toBe(ADMIN_EMAIL);
    expect(typeof res.body.serverTime).toBe('string');
  });
});