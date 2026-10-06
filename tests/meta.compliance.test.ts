/**
 * Tests — conformité Meta WhatsApp Business (MODULE 5.1).
 * Prisma et Redis sont mockés (pas de PostgreSQL ni de Redis requis),
 * pattern identique aux autres tests du projet (tests/setup.ts fournit les env).
 */
import { config } from '../src/config/env';
import { prisma } from '../src/config/database';
import { redis } from '../src/config/redis';
import {
  MAX_BODY_LENGTH,
  SERVICE_WINDOW_MS,
  checkMessageCompliance,
  checkWindowCompliance,
  enforceOptIn,
  isInternalRecipient,
  logConversation,
  normalize,
} from '../src/shared/meta.compliance';

jest.mock('../src/config/database', () => ({
  prisma: {
    conversationLog: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

jest.mock('../src/config/redis', () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    on: jest.fn(),
  },
}));

const WINDOW_KEY = `afribot:compliance:window:221771234567`;
const WINDOW_TTL_SECONDS = SERVICE_WINDOW_MS / 1000;

// Faux Redis en mémoire avec TTL (pattern session.test.ts).
const windowStore = new Map<string, { value: string; expiresAt: number }>();

beforeEach(() => {
  jest.clearAllMocks();
  windowStore.clear();
  (redis.get as jest.Mock).mockImplementation(async (key: string) => {
    const entry = windowStore.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= Date.now()) {
      windowStore.delete(key);
      return null;
    }
    return entry.value;
  });
  (redis.set as jest.Mock).mockImplementation(
    async (key: string, value: string, mode?: string, ttlSeconds?: number) => {
      const ttlMs = mode === 'EX' && typeof ttlSeconds === 'number' ? ttlSeconds * 1000 : SERVICE_WINDOW_MS;
      windowStore.set(key, { value, expiresAt: Date.now() + ttlMs });
      return 'OK';
    },
  );
  (redis.del as jest.Mock).mockResolvedValue(1);
});

describe('checkMessageCompliance (contenu)', () => {
  it('rejette un message vide', () => {
    const result = checkMessageCompliance('   ', 'service');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Message vide');
  });

  it('rejette un message trop long (> 1028 caractères)', () => {
    const result = checkMessageCompliance('a'.repeat(MAX_BODY_LENGTH + 1), 'service');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('trop long');
    expect(result.suggestion?.endsWith('...')).toBe(true);
  });

  it('rejette une URL raccourcie', () => {
    const result = checkMessageCompliance('Suivez ce lien http://bit.ly/afribot', 'service');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('URL raccourcie');
  });

  it('rejette un contenu sensible', () => {
    const result = checkMessageCompliance('Prochaine élection municipale, votez !', 'service');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Contenu sensible');
  });

  it('bloque la promotion dans un message de service', () => {
    const result = checkMessageCompliance('Nouveauté exclusive -50% cette semaine !', 'service');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Terme promotionnel');
  });

  it('autorise la promotion dans un template approuvé', () => {
    const result = checkMessageCompliance('Nouveauté exclusive -50% cette semaine !', 'template');
    expect(result).toEqual({ valid: true });
  });

  it('accepte un message de service propre', () => {
    const result = checkMessageCompliance('Votre colis est arrivé, passez le chercher en boutique.', 'service');
    expect(result).toEqual({ valid: true });
  });
});

describe('normalize', () => {
  it('retire le +, les espaces et le suffixe @s.whatsapp.net', () => {
    expect(normalize('+221 77 123 45 67@s.whatsapp.net')).toBe('221771234567');
    expect(normalize('22170000000')).toBe('22170000000');
  });

  it('ne garde que les chiffres', () => {
    expect(normalize('(221) 771234-567')).toBe('221771234567');
  });
});

describe('isInternalRecipient', () => {
  it('retourne false quand le numéro commerçant n est pas configuré', () => {
    expect(isInternalRecipient('221771234567')).toBe(false);
  });

  it('détecte le numéro du commerçant (normalisé)', () => {
    const mutableConfig = config as unknown as { merchant: { phone?: string } };
    const original = mutableConfig.merchant.phone;
    mutableConfig.merchant.phone = '221771234567';
    try {
      expect(isInternalRecipient('221771234567')).toBe(true);
      expect(isInternalRecipient('+221 77 123 45 67')).toBe(true);
      expect(isInternalRecipient('221771234568')).toBe(false);
    } finally {
      if (original === undefined) {
        delete mutableConfig.merchant.phone;
      } else {
        mutableConfig.merchant.phone = original;
      }
    }
  });
});

describe('enforceOptIn', () => {
  it('bloque si aucun message entrant (pas d opt-in)', async () => {
    (prisma.conversationLog.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(enforceOptIn('221771234567')).resolves.toBe(false);
  });

  it('autorise si un message entrant existe dans la fenêtre', async () => {
    (prisma.conversationLog.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 60_000),
    });
    await expect(enforceOptIn('221771234567')).resolves.toBe(true);
    expect(windowStore.has(WINDOW_KEY)).toBe(true);
  });

  it('autorise un opt-in ancien (hors fenêtre) sans ouvrir la fenêtre', async () => {
    (prisma.conversationLog.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - (SERVICE_WINDOW_MS + 3600_000)),
    });
    await expect(enforceOptIn('221771234567')).resolves.toBe(true);
    expect(windowStore.has(WINDOW_KEY)).toBe(false);
  });

  it('bloque si la lecture Redis échoue (fail-safe)', async () => {
    (redis.get as jest.Mock).mockRejectedValue(new Error('redis down'));
    await expect(enforceOptIn('221771234567')).resolves.toBe(false);
    expect(prisma.conversationLog.findFirst as jest.Mock).not.toHaveBeenCalled();
  });

  it('bloque si la requête en base échoue (fail-safe)', async () => {
    (prisma.conversationLog.findFirst as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(enforceOptIn('221771234567')).resolves.toBe(false);
  });
});

describe('checkWindowCompliance (fenêtre 24 h)', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');

  it('jamais écrit → OUT_WINDOW', async () => {
    (prisma.conversationLog.findFirst as jest.Mock).mockResolvedValue(null);
    const result = await checkWindowCompliance('221771234567', now);
    expect(result.status).toBe('OUT_WINDOW');
    expect(result.remainingMs).toBe(0);
    expect(result.lastInboundAt).toBeNull();
  });

  it('message entrant récent → IN_WINDOW avec remainingMs', async () => {
    const lastInboundAt = new Date(now.getTime() - 60_000);
    (prisma.conversationLog.findFirst as jest.Mock).mockResolvedValue({ createdAt: lastInboundAt });
    const result = await checkWindowCompliance('221771234567', now);
    expect(result.status).toBe('IN_WINDOW');
    expect(result.remainingMs).toBe(SERVICE_WINDOW_MS - 60_000);
    expect(result.lastInboundAt?.getTime()).toBe(lastInboundAt.getTime());
    expect(windowStore.has(WINDOW_KEY)).toBe(true);
  });

  it('message entrant vieux de plus de 24 h → OUT_WINDOW', async () => {
    const staleAt = new Date(now.getTime() - (SERVICE_WINDOW_MS + 1000));
    (prisma.conversationLog.findFirst as jest.Mock).mockResolvedValue({ createdAt: staleAt });
    const result = await checkWindowCompliance('221771234567', now);
    expect(result.status).toBe('OUT_WINDOW');
    expect(result.remainingMs).toBe(0);
    expect(result.lastInboundAt?.getTime()).toBe(staleAt.getTime());
    expect(windowStore.has(WINDOW_KEY)).toBe(false);
  });

  it('sert le cache Redis sur les appels suivants (aucune requête DB)', async () => {
    (prisma.conversationLog.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(now.getTime() - 60_000),
    });
    const first = await checkWindowCompliance('221771234567', now);
    expect(first.status).toBe('IN_WINDOW');

    (prisma.conversationLog.findFirst as jest.Mock).mockRejectedValue(new Error('db down'));
    const second = await checkWindowCompliance('221771234567', now);
    expect(second.status).toBe('IN_WINDOW');
    expect(prisma.conversationLog.findFirst as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('échec Redis → OUT_WINDOW (fail-safe, pas de requête DB)', async () => {
    (redis.get as jest.Mock).mockRejectedValue(new Error('redis down'));
    const result = await checkWindowCompliance('221771234567', now);
    expect(result.status).toBe('OUT_WINDOW');
    expect(result.remainingMs).toBe(0);
    expect(prisma.conversationLog.findFirst as jest.Mock).not.toHaveBeenCalled();
  });

  it('un échec d écriture du cache ne bloque pas un envoi en fenêtre', async () => {
    (prisma.conversationLog.findFirst as jest.Mock).mockResolvedValue({
      createdAt: new Date(now.getTime() - 60_000),
    });
    (redis.set as jest.Mock).mockRejectedValue(new Error('redis set down'));
    const result = await checkWindowCompliance('221771234567', now);
    expect(result.status).toBe('IN_WINDOW');
  });
});

describe('logConversation (journal + cache fenêtre)', () => {
  it('message entrant → journalise et alimente le cache fenêtre', async () => {
    (prisma.conversationLog.create as jest.Mock).mockResolvedValue({ id: 'conv-1' });
    await logConversation({ phone: '221771234567', fromMe: false, text: 'Bonjour', type: 'text' });

    expect(prisma.conversationLog.create).toHaveBeenCalledTimes(1);
    expect(redis.set as jest.Mock).toHaveBeenCalledWith(WINDOW_KEY, expect.any(String), 'EX', WINDOW_TTL_SECONDS);
  });

  it('message sortant → journalise sans toucher le cache fenêtre', async () => {
    (prisma.conversationLog.create as jest.Mock).mockResolvedValue({ id: 'conv-2' });
    await logConversation({ phone: '221771234567', fromMe: true, text: 'Bien reçu', type: 'text' });

    expect(prisma.conversationLog.create).toHaveBeenCalledTimes(1);
    expect(redis.set as jest.Mock).not.toHaveBeenCalled();
  });

  it('échec en base → pas de cache (fail-safe, journal non bloquant)', async () => {
    (prisma.conversationLog.create as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(
      logConversation({ phone: '221771234567', fromMe: false, text: 'Bonjour', type: 'text' }),
    ).resolves.toBeUndefined();
    expect(redis.set as jest.Mock).not.toHaveBeenCalled();
  });

  it('ignore un numéro vide', async () => {
    await logConversation({ phone: '   ', fromMe: false, text: 'x', type: 'text' });
    expect(prisma.conversationLog.create).not.toHaveBeenCalled();
  });
});