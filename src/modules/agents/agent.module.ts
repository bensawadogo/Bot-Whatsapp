/**
 * AfriBot — module escalade agent humain via Chatwoot (REST, pas de SDK).
 *
 * Escalade : retrouve/crée le contact Chatwoot du client, crée une
 * conversation ouverte, y transfère l'historique conversationnel (Redis),
 * puis relaie les messages du client jusqu'à la reprise par le bot.
 * L'agent répond depuis l'interface Chatwoot (proxifiée par Nginx /chatwoot/).
 */
import axios, { type AxiosInstance } from 'axios';

import { logger } from '../../config/logger';
import { config } from '../../config/env';
import { history } from '../../shared/history';
import { ConversationStateEnum, sessionManager } from '../../shared/session';
import { EscalationReason } from './agent.types';

/** Client REST minimal Chatwoot (API v1 — self-hosted, retry 3 × backoff). */
class ChatwootClient {
  private readonly http: AxiosInstance;
  private static readonly MAX_RETRIES = 3;

  constructor() {
    this.http = axios.create({
      baseURL: config.chatwoot.url ?? '',
      headers: {
        'Content-Type': 'application/json',
        api_access_token: config.chatwoot.apiKey ?? '',
      },
      timeout: 10_000,
    });
  }

  private get base(): string {
    return `/api/v1/accounts/${config.chatwoot.accountId ?? 1}`;
  }

  private async retry<T>(fn: () => Promise<T>, path: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ChatwootClient.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        logger.warn(`Chatwoot ${path} — tentative ${attempt}/${ChatwootClient.MAX_RETRIES} échouée`);
        if (attempt < ChatwootClient.MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        }
      }
    }
    throw new Error(`Chatwoot ${path} : échec après ${ChatwootClient.MAX_RETRIES} tentatives (${String(lastError)})`);
  }

  /** Recherche d'un contact par numéro de téléphone (retourne l'id ou null). */
  async searchContact(phone: string): Promise<number | null> {
    return this.retry(async () => {
      const response = await this.http.get<{ payload?: { id: number }[] }>(`${this.base}/contacts/search`, {
        params: { q: phone },
      });
      const match = response.data.payload?.find((contact) => contact.id);
      return match?.id ?? null;
    }, '/contacts/search');
  }

  /** Crée un contact avec le numéro WhatsApp du client. */
  async createContact(phone: string): Promise<number> {
    return this.retry(async () => {
      const response = await this.http.post<{ payload: { contact: { id: number } } }>(`${this.base}/contacts`, {
        inbox_id: config.chatwoot.inboxId ?? 1,
        name: `Client ${phone}`,
        phone_number: phone,
      });
      return response.data.payload.contact.id;
    }, '/contacts');
  }

  /** Crée une conversation ouverte dans l'inbox. */
  async createConversation(contactId: number): Promise<number> {
    return this.retry(async () => {
      const response = await this.http.post<{ id: number }>(`${this.base}/conversations`, {
        inbox_id: config.chatwoot.inboxId ?? 1,
        contact_id: contactId,
        status: 'open',
      });
      return response.data.id;
    }, '/conversations');
  }

  /** Envoie un message (incoming = client, outgoing = bot/agent). */
  async sendMessage(conversationId: number, content: string, messageType: 'incoming' | 'outgoing'): Promise<void> {
    await this.retry(async () => {
      await this.http.post(`${this.base}/conversations/${conversationId}/messages`, {
        content,
        message_type: messageType,
      });
    }, `/conversations/${conversationId}/messages`);
  }
}

export class AgentModule {
  private readonly chatwoot = new ChatwootClient();
/** Point d'entrée du module : relaye les messages du client à l'agent. */
  async handle(phone: string, message: string): Promise<void> {
    const session = await sessionManager.getSession(phone);
    const conversationId = session.chatwootConversationId;
    if (!conversationId) {
      // Conversation absente (config incomplète au moment de l'escalade) : on re-tente
      await this.escalateToHuman(phone, EscalationReason.BOT_STUCK);
      return;
    }
    // Relais du message client vers Chatwoot (message_type incoming), sans réponse auto
    try {
      await this.chatwoot.sendMessage(conversationId, message.slice(0, 2000), 'incoming');
    } catch (err) {
      logger.error(`Relais Chatwoot ${phone} échoué : ${String(err)}`);
    }
  }

  /**
   * Escalade vers un agent humain : passe la session en AGENT_ESCALATION,
   * retrouve/crée le contact, crée la conversation et y transfère l'historique.
   */
  async escalateToHuman(phone: string, reason: EscalationReason): Promise<void> {
    await sessionManager.setState(phone, ConversationStateEnum.AGENT_ESCALATION);

    const cw = config.chatwoot;
    if (!cw.url || !cw.apiKey || !cw.accountId || !cw.inboxId) {
      logger.warn(`Escalade ${phone} (${reason}) : configuration Chatwoot incomplète — session conservée`);
      return;
    }

    const session = await sessionManager.getSession(phone);
    const conversationId = session.chatwootConversationId;
    if (conversationId) {
      // Conversation déjà ouverte : on renvoie l'historique à jour + alerte
      await this.sendHistoryToConversation(phone, conversationId);
      await this.notifyAgent(conversationId);
      return;
    }

    try {
      // 1. Retrouver ou créer le contact Chatwoot
      let contactId = await this.chatwoot.searchContact(phone);
      if (!contactId) {
        contactId = await this.chatwoot.createContact(phone);
      }

      // 2. Créer la conversation ouverte
      const createdId = await this.chatwoot.createConversation(contactId);
      await sessionManager.updateSession(phone, {
        chatwootContactId: contactId,
        chatwootConversationId: createdId,
      });

      // 3. Message d'ouverture avec la raison
      await this.chatwoot.sendMessage(
        createdId,
        `Conversation escaladée vers un agent humain.\nRaison : ${reason}\nClient WhatsApp : ${phone}`,
        'outgoing',
      );

      // 4. Transférer l'historique conversationnel au thread Chatwoot
      await this.sendHistoryToConversation(phone, createdId);

      // 5. Alerter l'agent (n8n ou log)
      await this.notifyAgent(createdId);
    } catch (err) {
      logger.error(`Escalade Chatwoot pour ${phone} échouée : ${String(err)}`);
    }
  }

  /** Transfère l'historique Redis du client dans la conversation Chatwoot. */
  private async sendHistoryToConversation(phone: string, conversationId: number): Promise<void> {
    const entries = await history.get(phone);
    if (entries.length === 0) {
      await this.chatwoot.sendMessage(conversationId, '(Aucun historique disponible)', 'outgoing');
      return;
    }
    // Les entrées sont les plus récentes en premier → inversion pour l'ordre chronologique
    const chronological = [...entries].reverse();
    for (const entry of chronological) {
      const prefix = entry.fromMe ? 'Bot 🤖' : 'Client 👤';
      await this.chatwoot.sendMessage(conversationId, `${prefix} : ${entry.text.slice(0, 1000)}`, 'outgoing');
    }
  }

  /** Notifie l'agent qu'une nouvelle conversation attend une réponse. */
  async notifyAgent(conversationId: number): Promise<void> {
    const { url, apiKey } = config.n8n;
    if (url && apiKey) {
      try {
        await axios.post(
          `${url}/webhook/afribot-escalade`,
          { conversationId, source: 'afribot', at: new Date().toISOString() },
          { headers: { 'X-N8N-API-KEY': String(apiKey) }, timeout: 5000 },
        );
        return;
      } catch (err) {
        logger.warn(`Alerte agent via n8n échouée : ${String(err)}`);
      }
    }
    logger.warn(`Nouvelle escalade — conversation Chatwoot #${conversationId} (configurer n8n pour l'alerte)`);
  }

  /** Reprise de main : retour au bot + nettoyage des liens Chatwoot. */
  async resolveEscalation(phone: string): Promise<void> {
    await sessionManager.updateSession(phone, {
      chatwootConversationId: undefined,
      chatwootContactId: undefined,
    });
    await sessionManager.setState(phone, ConversationStateEnum.IDLE);
    logger.info(`Escalade clôturée pour ${phone} — retour au bot`);
  }
}

