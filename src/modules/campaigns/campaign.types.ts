/**
 * AfriBot — types du module campagnes (pub ciblées CTWA + Broadcast).
 *
 * RÈGLE META 1 : N'envoyer QU'à des contacts qui ont écrit en premier
 *   (fromMe = false dans ConversationLog) — jamais de cold-messaging.
 * RÈGLE META 2 : Utiliser uniquement des templates approuvés hors de la
 *   fenêtre de 24 h après le dernier message client.
 * RÈGLE META 3 : Respecter le rate limiting du tier actuel
 *   (Tier 0: 250/j | Tier 1: 1000/j | Tier 2: 10k/j).
 * RÈGLE META 4 : Surveiller le blockRate — si > 2 % → pause automatique.
 * RÈGLE META 5 : Ne JAMAIS acheter ou scraper des listes. Seuls les contacts
 *   organiques opt-in sont autorisés.
 */

/** Types de campagnes supportées. */
export type CampaignType = 'CTWA' | 'BROADCAST' | 'REACTIVATION';

/** Cycle de vie d'une campagne. */
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';

/** Score qualité du numéro WhatsApp Business (Meta). */
export type QualityRating = 'GREEN' | 'YELLOW' | 'RED';

/** Segments de ciblage (dérivés de ConversationLog + Order). */
export type TargetSegment = 'ALL' | 'ACTIVE_30' | 'ACTIVE_90' | 'DORMANT' | 'NEW';

/** Statut d'envoi d'un contact au sein d'une campagne. */
export type CampaignContactStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'REPLIED' | 'BLOCKED';

/** Tiers Meta de messagerie — déterminent les limites d'envoi. */
export type MessagingTier = 'TIER_0' | 'TIER_1' | 'TIER_2';

/** Vue applicative d'une campagne (miroir du modèle Prisma). */
export interface Campaign {
  id: string;
  merchantId: string;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  templateKey: string;
  templateParams: string;
  targetSegment: TargetSegment;
  scheduledAt: Date | null;
  sentAt: Date | null;
  totalTargeted: number;
  totalSent: number;
  totalDelivered: number;
  totalRead: number;
  totalReplied: number;
  totalOrders: number;
  revenueGenerated: number;
  qualityScore: QualityRating;
  blockRate: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Résultat d'une vérification de qualité Meta avant envoi. */
export interface QualityCheck {
  rating: QualityRating;
  /** Envoi autorisé ? (RED → non ; YELLOW → limité selon config) */
  allowed: boolean;
  /** Raison du blocage / de la limitation (affichée au commerçant). */
  reason: string | null;
  /** Limite d'envois/heure conseillée selon le tier. */
  tier: MessagingTier;
  dailyLimit: number;
  hourlyLimit: number;
}

/** Résultat d'un lancement d'envoi (POST /api/campaigns/:id/send). */
export interface SendResult {
  sent: number;
  blocked: number;
  paused: boolean;
  reason: string | null;
}

/** Payload du webhook CTWA (arrivée d'un client depuis une pub Meta). */
export interface CTWAWebhook {
  phoneNumber: string;
  ctwaClid?: string | undefined;
  adId?: string | undefined;
  sourceId?: string | undefined;
}

/** Webhook Meta de statut de message (sent / delivered / read). */
export interface MessageStatusWebhook {
  phoneNumber: string;
  campaignId: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'BLOCKED';
}

/** DTO de création d'une campagne (POST /api/campaigns). */
export interface CreateCampaignDto {
  name: string;
  type: CampaignType;
  templateKey: string;
  templateParams?: string | undefined;
  targetSegment: TargetSegment;
  scheduledAt?: Date | undefined;
}

/** Ligne de l'historique des campagnes (dashboard). */
export interface CampaignListItem extends Campaign {
  /** Taux de lecture en % (totalRead / totalSent). */
  readRate: number;
  /** Taux de réponse en % (totalReplied / totalSent). */
  replyRate: number;
  /** ROI en FCFA : revenu généré par message envoyé. */
  roiPerSent: number;
}
