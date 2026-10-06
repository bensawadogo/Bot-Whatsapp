import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';

import { webhookRouter } from '../src/shared/webhook.controller';

// Reproduit le montage d'index.ts : express.raw() devant le router webhook
const app = express();
app.use('/webhook/messages', express.raw({ type: 'application/json' }));
app.use('/webhook', webhookRouter);

const TOKEN = 'test-webhook-token';

function sign(body: string): string {
  return createHmac('sha256', TOKEN).update(body).digest('hex');
}

describe('WebhookController — GET /webhook (hub.challenge)', () => {
  it('répond le challenge si le token est correct', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': TOKEN,
      'hub.challenge': '12345',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('12345');
  });

  it('refuse si le token est incorrect', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'mauvais-token',
      'hub.challenge': '12345',
    });
    expect(res.status).toBe(403);
  });
});

describe('WebhookController — POST /webhook/messages', () => {
  const validPayload = {
    event: 'messages.upsert',
    instance: 'afribot-test',
    data: {
      key: { remoteJid: '221771234567@s.whatsapp.net', fromMe: true, id: 'msg-1' },
      messageType: 'text',
      content: 'bonjour',
    },
  };

  it('refuse si la signature est invalide', async () => {
    const res = await request(app)
      .post('/webhook/messages')
      .set('Content-Type', 'application/json')
      .set('x-evolution-signature', 'signature-fausse')
      .send(JSON.stringify(validPayload));
    expect(res.status).toBe(401);
  });

  it('ignore les événements qui ne sont pas messages.upsert', async () => {
    const body = JSON.stringify({ ...validPayload, event: 'connection.update' });
    const res = await request(app)
      .post('/webhook/messages')
      .set('Content-Type', 'application/json')
      .set('x-evolution-signature', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
  });

  it('ignore les messages envoyés par le bot (fromMe:true) sans traitement', async () => {
    const body = JSON.stringify(validPayload);
    const res = await request(app)
      .post('/webhook/messages')
      .set('Content-Type', 'application/json')
      .set('x-evolution-signature', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
  });

  it('répond 200 JSON invalide → 400', async () => {
    const res = await request(app)
      .post('/webhook/messages')
      .set('Content-Type', 'application/json')
      .set('x-evolution-signature', sign('{pas du json'))
      .send('{pas du json');
    expect(res.status).toBe(400);
  });
});