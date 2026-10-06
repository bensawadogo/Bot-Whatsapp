/**
 * AfriBot — gestion des sessions conversationnelles (Redis).
 *
 * Une session par numéro de téléphone, clé : {prefix}session:{phone},
 * TTL 1800 secondes (30 minutes) — aligné sur la machine à états
 * documentée dans docs/ARCHITECTURE.md (section 3).
 */
import type { Redis } from 'ioredis';

import { config } from '../config/env';
import { redis } from '../config/redis';
import { logger } from '../config/logger';
import type { CartItem } from '../modules/orders/order.types';

// ---------------------------------------------------------------------------
// États de la conversation
// ---------------------------------------------------------------------------

export enum ConversationStateEnum {
  IDLE = 'IDLE',
  BROWSING_CATALOG = 'BROWSING_CATALOG',
  ORDERING = 'ORDERING',
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  COMPLETED = 'COMPLETED',
  AGENT_ESCALATION = 'AGENT_ESCALATION',
  // --- Onboarding commerçant guidé par bot (MODULE 4 — chemin B) ---
  ONBOARDING_NAME = 'ONBOARDING_NAME',
  ONBOARDING_HOURS_OPEN = 'ONBOARDING_HOURS_OPEN',
  ONBOARDING_HOURS_CLOSE = 'ONBOARDING_HOURS_CLOSE',
  ONBOARDING_PAYMENT = 'ONBOARDING_PAYMENT',
  ONBOARDING_WAVE = 'ONBOARDING_WAVE',
  ONBOARDING_LIVREUR = 'ONBOARDING_LIVREUR',
  ONBOARDING_LIVREUR_PHONE = 'ONBOARDING_LIVREUR_PHONE',
}

/** Données collectées pendant l'onboarding guidé (MODULE 4 — chemin B). */
export interface OnboardingDraft {
  businessName?: string | undefined;
  openHour?: number | undefined;
  closeHour?: number | undefined;
  /** 'COD' | 'DIRECT' */
  paymentMode?: 'COD' | 'DIRECT' | undefined;
  /** Cash accepté aussi (choix « les deux »). */
  codEnabled?: boolean | undefined;
  waveNumber?: string | undefined;
  orangeNumber?: string | undefined;
  /** 1 = a un livreur, 2 = livre lui-même, 3 = pas de livraison */
  livreurChoice?: number | undefined;
  livreurName?: string | undefined;
  livreurPhone?: string | undefined;
}

export interface ConversationState {
  phoneNumber: string;
  state: ConversationStateEnum;
  // exactOptionalPropertyTypes: true → les champs optionnels acceptent
  // explicitement `undefined` pour permettre leur remise à zéro.
  currentOrderId?: string | undefined;
  /** Produit sélectionné dans le catalogue, en attente de la quantité. */
  pendingProductId?: string | undefined;
  /** Sous-état du flow de commande (OrderFlowState — voir order.types.ts). */
  orderFlow?: string | undefined;
  /** Quantité saisie pendant le flow de commande. */
  orderQuantity?: number | undefined;
  /** Adresse de livraison saisie pendant le flow de commande. */
  orderAddress?: string | undefined;
  /** Panier multi-produits en cours (Phase 1). */
  cart?: CartItem[] | undefined;
  /** Conversation Chatwoot liée à l'escalade (Phase 3). */
  chatwootConversationId?: number | undefined;
  /** Contact Chatwoot lié au numéro du client (Phase 3). */
  chatwootContactId?: number | undefined;
  lastActivity: number; // timestamp ms
  /** Messages non compris consécutifs (3 → escalade agent humain). */
  unknownCount?: number | undefined;
  /** Données collectées pendant l'onboarding guidé (MODULE 4). */
  onboarding?: OnboardingDraft | undefined;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly client: Redis;
  private readonly ttl: number;
  private readonly prefix: string;

  /** Client injectable (facilite les tests unitaires avec ioredis-mock). */
  constructor(client: Redis = redis) {
    this.client = client;
    this.ttl = config.redis.sessionTtl; // 1800 s par défaut
    this.prefix = `${config.redis.prefix}session:`;
  }

  private key(phone: string): string {
    return `${this.prefix}${phone}`;
  }

  /** Récupère la session, ou en crée une neuve (IDLE) si absente/expirée. */
  async getSession(phone: string): Promise<ConversationState> {
    const raw = await this.client.get(this.key(phone));
    if (raw) {
      try {
        return JSON.parse(raw) as ConversationState;
      } catch {
        logger.warn(`Session corrompue pour ${phone} — JSON invalide dans Redis, réinitialisation`);
        await this.client.del(this.key(phone));
      }
    }
    const fresh: ConversationState = {
      phoneNumber: phone,
      state: ConversationStateEnum.IDLE,
      lastActivity: Date.now(),
    };
    await this.write(fresh);
    return fresh;
  }

  /** Change l'état de la conversation et rafraîchit le TTL (sans double lecture Redis). */
  async setState(phone: string, state: ConversationStateEnum): Promise<void> {
    await this.updateState(phone, { state });
    logger.debug(`Session ${phone} → ${state}`);
  }

  /**
   * Écriture atomique read-modify-write SANS double lecture :
   * factorise getSession + write pour setState/updateSession
   * (une seule lecture Redis par mutation).
   */
  private async updateState(phone: string, data: Partial<ConversationState>): Promise<void> {
    const session = await this.getSession(phone);
    const next: ConversationState = { ...session, ...data, phoneNumber: phone, lastActivity: Date.now() };
    await this.write(next);
  }

  /** Mise à jour partielle (ex: currentOrderId pendant ORDERING). */
  async updateSession(phone: string, data: Partial<ConversationState>): Promise<void> {
    await this.updateState(phone, data);
  }

  /**
   * Incrémente le compteur de messages non compris consécutifs et retourne
   * la nouvelle valeur. Remis à zéro dès qu'un message est compris.
   * 3 tentatives → escalade vers un agent humain (docs/TODO.md Phase 3).
   */
  async incrementUnknownCount(phone: string): Promise<number> {
    const session = await this.getSession(phone);
    const unknownCount = (session.unknownCount ?? 0) + 1;
    await this.write({ ...session, unknownCount, phoneNumber: phone, lastActivity: Date.now() });
    return unknownCount;
  }

  /** Remet le compteur de blocage à zéro (message compris). */
  async resetUnknownCount(phone: string): Promise<void> {
    await this.updateSession(phone, { unknownCount: 0 });
  }

  /** Supprime la session (fin de conversation, escalade clôturée...). */
  async deleteSession(phone: string): Promise<void> {
    await this.client.del(this.key(phone));
  }

  /** Écrit la session avec TTL — expiration auto = retour IDLE au bout de 30 min. */
  private async write(session: ConversationState): Promise<void> {
    await this.client.set(this.key(session.phoneNumber), JSON.stringify(session), 'EX', this.ttl);
  }
}

export const sessionManager = new SessionManager();
