/**
 * AfriBot — types du module livraison (MODULE 1).
 *
 * Miroir TypeScript de l'enum Prisma `DeliveryStatus` (mêmes valeurs) et des
 * modèles `Delivery` / `Livreur`. Les montants COD sont en FCFA.
 */

/** Cycle de vie d'une livraison — aligné sur l'enum Prisma `DeliveryStatus`. */
export enum DeliveryStatus {
  /** Livraison créée, aucun livreur encore affecté. */
  PENDING = 'PENDING',
  /** Message envoyé au livreur, en attente de sa réponse (OUI/NON). */
  ASSIGNED = 'ASSIGNED',
  /** Le livreur a accepté et récupéré le colis. */
  PICKED_UP = 'PICKED_UP',
  /** En route vers le client. */
  EN_ROUTE = 'EN_ROUTE',
  /** Livrée (et encaissée si COD). */
  DELIVERED = 'DELIVERED',
  /** Échec : refus du livreur, client absent, adresse introuvable... */
  FAILED = 'FAILED',
}

/** Libellés affichés (WhatsApp + dashboard). */
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  [DeliveryStatus.PENDING]: '⏳ En attente de livreur',
  [DeliveryStatus.ASSIGNED]: '📨 Proposée au livreur',
  [DeliveryStatus.PICKED_UP]: '📦 Colis récupéré',
  [DeliveryStatus.EN_ROUTE]: '🚗 En route',
  [DeliveryStatus.DELIVERED]: '✅ Livrée',
  [DeliveryStatus.FAILED]: '❌ Échec',
};

/** Livreur du commerçant (notifié via WhatsApp). */
export interface Livreur {
  id: string;
  merchantId: string;
  name: string;
  /** Numéro WhatsApp, format international sans « + ». */
  phone: string;
  zone: string | null;
  isActive: boolean;
  isAvailable: boolean;
  totalDeliveries: number;
  createdAt: Date;
}

/** Livraison d'une commande. */
export interface Delivery {
  id: string;
  orderId: string;
  livreurId: string | null;
  status: DeliveryStatus;
  livreurPhone: string | null;
  customerPhone: string;
  deliveryAddress: string;
  /** Minutes estimées annoncées au client. */
  estimatedTime: number | null;
  proofPhoto: string | null;
  failureReason: string | null;
  /** Montant à collecter (COD), en FCFA. */
  codAmount: number | null;
  codCollected: boolean;
  notes: string | null;
  assignedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Livraison enrichie pour le dashboard (GET /api/delivery/active). */
export interface DeliveryListItem extends Delivery {
  livreurName: string | null;
  orderTotal: number;
  orderStatus: string;
  customerItems: { productName: string; quantity: number }[];
}

/** Données de création d'un livreur (POST /api/config/livreur). */
export interface CreateLivreurDto {
  merchantId: string;
  name: string;
  phone: string;
  zone?: string | undefined;
}

/** Données d'assignation d'une livraison (DeliveryModule.assignDelivery). */
export interface AssignDeliveryOptions {
  /** Minutes estimées communiquées au client. */
  estimatedTime?: number | undefined;
  /** Note interne visible du seul livreur. */
  notes?: string | undefined;
}
