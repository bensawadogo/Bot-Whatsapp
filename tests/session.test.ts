import type { Redis } from 'ioredis';

import { SessionManager, ConversationStateEnum } from '../src/shared/session';
import { config } from '../src/config/env';

/**
 * Faux client Redis (Map en mémoire) injectable dans SessionManager.
 * Le constructeur accepte un client injectable justement pour les tests.
 */
class FakeRedisClient {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    this.store.set(key, value);
    if (mode === 'EX' && ttl !== undefined) {
      // Simule l'expiration en stockant le TTL (non utilisé dans ces tests)
      void ttl;
    }
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      count += this.store.delete(key) ? 1 : 0;
    }
    return count;
  }
}

describe('SessionManager', () => {
  let client: FakeRedisClient;
  let manager: SessionManager;

  beforeEach(() => {
    client = new FakeRedisClient();
    manager = new SessionManager(client as unknown as Redis);
  });

  it('crée une session IDLE si aucune n existe', async () => {
    const session = await manager.getSession('221771234567');
    expect(session.phoneNumber).toBe('221771234567');
    expect(session.state).toBe(ConversationStateEnum.IDLE);
  });

  it('retourne une session neuve si le JSON stocké est corrompu', async () => {
    const key = `${config.redis.prefix}session:221771234567`;
    await client.set(key, '{ceci nest pas du json', 'EX', 1800);
    const session = await manager.getSession('221771234567');
    expect(session.phoneNumber).toBe('221771234567');
    expect(session.state).toBe(ConversationStateEnum.IDLE);
    const raw = await client.get(key);
    expect(raw).not.toBe('{ceci nest pas du json');
    expect(raw).toBeDefined();
  });

  it('change l état et le persiste', async () => {
    await manager.setState('221771234567', ConversationStateEnum.BROWSING_CATALOG);
    const session = await manager.getSession('221771234567');
    expect(session.state).toBe(ConversationStateEnum.BROWSING_CATALOG);
  });

  it('met à jour partiellement la session', async () => {
    await manager.updateSession('221771234567', { pendingProductId: 'abc-123' });
    const session = await manager.getSession('221771234567');
    expect(session.pendingProductId).toBe('abc-123');
    expect(session.state).toBe(ConversationStateEnum.IDLE);
  });

  it('incrémente le compteur de messages non compris (3 → escalade)', async () => {
    expect(await manager.incrementUnknownCount('221771234567')).toBe(1);
    expect(await manager.incrementUnknownCount('221771234567')).toBe(2);
    expect(await manager.incrementUnknownCount('221771234567')).toBe(3);
  });

  it('remet le compteur à zéro quand le message est compris', async () => {
    await manager.incrementUnknownCount('221771234567');
    await manager.resetUnknownCount('221771234567');
    const session = await manager.getSession('221771234567');
    expect(session.unknownCount).toBe(0);
  });

  it('supprime la session', async () => {
    await manager.setState('221771234567', ConversationStateEnum.ORDERING);
    await manager.deleteSession('221771234567');
    const session = await manager.getSession('221771234567');
    expect(session.state).toBe(ConversationStateEnum.IDLE); // recréée neuve
  });
});