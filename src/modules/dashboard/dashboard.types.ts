/**
 * AfriBot — types du module dashboard (Phase 5).
 * Les montants sont des entiers FCFA ; `revenueFormatted` est pré-formaté
 * ("1 500 FCFA") pour éviter de dupliquer le formatage côté client.
 */

/** Statistiques d'une journée (GET /api/stats/today). */
export interface DailyStats {
  /** Date au format YYYY-MM-DD (fuseau du serveur). */
  date: string;
  /** Commandes créées ce jour (hors annulées). */
  ordersCount: number;
  /** Somme des totaux des commandes PAYÉES du jour (FCFA). */
  revenue: number;
  /** Numéros de téléphone distincts ayant commandé ce jour. */
  uniqueCustomers: number;
  revenueFormatted: string;
}

/** Point du graphique "revenus 7 derniers jours" (GET /api/stats/weekly). */
export interface WeeklyRevenue {
  /** Date au format YYYY-MM-DD. */
  date: string;
  ordersCount: number;
  /** Somme des totaux des commandes PAYÉES du jour (0 si aucune). */
  revenue: number;
  revenueFormatted: string;
}

/** Produit le plus vendu (GET /api/stats/top-products). */
export interface TopProduct {
  productId: string;
  productName: string;
  /** Quantités cumulées vendues (toutes commandes non annulées). */
  totalSold: number;
  /** Chiffre d'affaires cumulé (quantité × prix figé, FCFA). */
  totalRevenue: number;
  revenueFormatted: string;
}

/** Entonnoir de conversion (GET /api/stats/conversion). */
export interface ConversionStats {
  /**
   * Sessions uniques = numéros distincts ayant commandé au moins une fois
   * (approximation : pas encore de table ConversationLog durable — les
   * sessions sont en Redis volatil. TODO Phase 6 : journaliser les sessions
   * en base pour un entonnoir complet messages → commandes).
   */
  totalSessions: number;
  totalOrders: number;
  /** Commandes au statut PAID (payées). */
  paidOrders: number;
  /** paidOrders / totalSessions × 100 (1 décimale). */
  conversionRate: number;
  /** (totalOrders − paidOrders) / totalOrders × 100 (1 décimale). */
  abandonRate: number;
}