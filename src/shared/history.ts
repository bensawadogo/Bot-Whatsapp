/**
 * AfriBot — historique conversationnel (Redis).
 *
 * Stocke les derniers messages échangés avec un client (entrants + sortants)
 * dans une liste Redis. Utilisé par l'escalade Chatwoot (Phase 3 : envoyer
 * l'historique à l'agent) et consultable pour les rapports (Phase 4).
 *
 * Clé : {prefix}history:{phone}  (liste, la plus récente en TÊTE)
 * TTL : aligné sur les sessions (30 min).
 */
import { redis } from '../config/redis';
import { config } from '../config/env';

export interface HistoryEntry {
  /** true = message envoyé par le bot, false = message reçu du client. */
  fromMe: boolean;
  text: string;
  type: string;
  at: number; // timestamp ms
}

/** Nombre maximal de messages conservés par client. */
const HISTORY_MAX = 100;
/** Nombre de messages envoyés à l'agent lors d'une escalade. */
const HISTORY_SENT_TO_AGENT = 30;

class ConversationHistory {
  private key(phone: string): string {
    return `${config.redis.prefix}history:${phone}`;
  }

  /** Ajoute un message à l'historique et raccourcit la liste. */
  async append(phone: string, entry: Omit<HistoryEntry, 'at'>): Promise<void> {
    const record: HistoryEntry = { ...entry, at: Date.now() };
    const key = this.key(phone);
    await redis
      .multi()
      .lpush(key, JSON.stringify(record))
      .ltrim(key, 0, HISTORY_MAX - 1)
      .expire(key, config.redis.sessionTtl)
      .exec();
  }

  /** Retourne les derniers messages (les plus récents en premier). */
  async get(phone: string, limit = HISTORY_SENT_TO_AGENT): Promise<HistoryEntry[]> {
    const raw = await redis.lrange(this.key(phone), 0, limit - 1);
    return raw
      .map((item) => {
        try {
          return JSON.parse(item) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is HistoryEntry => entry !== null);
  }

  /** Efface l'historique d'un client (fin d'escalade, clôture). */
  async clear(phone: string): Promise<void> {
    await redis.del(this.key(phone));
  }
}

export const history = new ConversationHistory();