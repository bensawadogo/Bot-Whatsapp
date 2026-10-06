/**
 * AfriBot — types du module escalade agent humain (Chatwoot).
 */

/** Conversation Chatwoot créée lors d'une escalade. */
export interface ChatwootConversation {
  id: number;
  status: string; // open | pending | resolved
  phone: string;
  inboxId: number;
  assigneeId?: number;
}

/** Raison de l'escalade vers un agent humain. */
export enum EscalationReason {
  /** Le client a explicitement demandé un humain ("humain", "aide"). */
  USER_REQUEST = 'USER_REQUEST',
  /** Le bot n'a pas compris après N tentatives (ESCALATION_MAX_ATTEMPTS). */
  BOT_STUCK = 'BOT_STUCK',
  /** Problème de paiement signalé ou détecté. */
  PAYMENT_ISSUE = 'PAYMENT_ISSUE',
  /** Réclamation client. */
  COMPLAINT = 'COMPLAINT',
}
