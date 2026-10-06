/**
 * AfriBot - verification de bout en bout de l'API locale (sans dependance test).
 * Charge .env via dotenv, se connecte, puis appelle les routes reelles.
 * Usage : node scripts/e2e-check.js
 */
require('dotenv').config();

const BASE = process.env.AFRIBOT_E2E_URL || 'http://localhost:3001';
const email = process.env.DASHBOARD_ADMIN_EMAIL;
const password = process.env.DASHBOARD_ADMIN_PASSWORD;

function short(s, n = 420) {
  const c = String(s).replace(/\s+/g, ' ');
  return c.length > n ? `${c.slice(0, n)}...` : c;
}

async function call(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

(async () => {
  const out = [];
  out.push(`BASE=${BASE}`);
  out.push(`EMAIL=${email}`);
  out.push(`PW_LEN=${password ? password.length : 0}`);

  // 1) Login
  let token = null;
  {
    const r = await call('POST', '/api/auth/login', { email, password });
    out.push(`POST /api/auth/login -> ${r.status} | ${short(r.text, 200)}`);
    try {
      token = JSON.parse(r.text).token;
    } catch {
      /* ignore */
    }
  }
  if (!token) {
    console.log(out.join('\n'));
    process.exitCode = 1;
    return;
  }
  out.push(`TOKEN_LEN=${token.length}`);

  // 2) Lectures protegees
  for (const p of [
    '/health',
    '/api/config',
    '/api/delivery/active',
    '/api/delivery/livreurs',
    '/api/campaigns',
    '/api/campaigns/quality',
  ]) {
    const r = await call('GET', p, undefined, token);
    out.push(`GET ${p} -> ${r.status} | ${short(r.text)}`);
  }

  // 3) Creation campagne valide (segment DORMANT)
  let cid = null;
  {
    const r = await call(
      'POST',
      '/api/campaigns',
      {
        name: 'Test DORMANT (e2e)',
        type: 'REACTIVATION',
        targetSegment: 'DORMANT',
        templateKey: 'ORDER_CONFIRMATION',
      },
      token,
    );
    out.push(`POST /api/campaigns -> ${r.status} | ${short(r.text, 300)}`);
    try {
      cid = JSON.parse(r.text).campaign?.id ?? null;
    } catch {
      /* ignore */
    }
  }
  out.push(`CAMPAIGN_ID=${cid}`);

  // 4) Stats / send / pause
  if (cid) {
    for (const p of [
      ['GET', `/api/campaigns/${cid}/stats`],
      ['POST', `/api/campaigns/${cid}/send`],
      ['POST', `/api/campaigns/${cid}/pause`],
    ]) {
      const r = await call(p[0], p[1], undefined, token);
      out.push(`${p[0]} ${p[1]} -> ${r.status} | ${short(r.text, 300)}`);
    }
  }

  // 5) Validation Zod (template inexistant -> 400 attendu)
  {
    const r = await call(
      'POST',
      '/api/campaigns',
      {
        name: 'Test invalide',
        type: 'CTWA',
        targetSegment: 'ACTIVE_30',
        templateKey: 'PAS_UN_TEMPLATE',
      },
      token,
    );
    out.push(`POST /api/campaigns (invalide) -> ${r.status} | ${short(r.text, 250)}`);
  }

  // 6) Nettoyage : le script ne laisse AUCUNE donnee de test en base.
  if (cid && process.env.AFRIBOT_E2E_KEEP !== '1') {
    try {
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      await prisma.campaignContact.deleteMany({ where: { campaignId: cid } });
      await prisma.campaign.delete({ where: { id: cid } });
      await prisma.$disconnect();
      out.push(`CLEANUP campagne ${cid} supprimee`);
    } catch (err) {
      out.push(`CLEANUP ERREUR: ${String(err)}`);
    }
  } else if (cid) {
    out.push(`CLEANUP ignore (AFRIBOT_E2E_KEEP=1) — campagne ${cid} conservee`);
  }

  console.log(out.join('\n'));
})().catch((err) => {
  console.error(`ERREUR E2E : ${String(err)}`);
  process.exitCode = 1;
});
