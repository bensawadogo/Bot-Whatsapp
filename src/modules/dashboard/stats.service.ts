/**
 * @file stats.service.ts
 * @description Statistiques du dashboard commerçant (Phase 5).
 *
 * Sources de vérité : PostgreSQL via Prisma. Les agrégations multi-jours
 * passent par du SQL brut ($queryRaw / date_trunc) car le groupBy Prisma ne
 * sait pas tronquer les dates. Tous les montants sont des entiers FCFA.
 *
 * NB : pas de table ConversationLog (voir dashboard.types.ts) → le nombre de
 * sessions est approximé par les numéros distincts ayant commandé.
 */
import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '../../config/database';
import { formatPrice } from '../../shared/format';
import type { Product } from '../catalog/catalog.types';
import type { ConversionStats, DailyStats, TopProduct, WeeklyRevenue } from './dashboard.types';

/** Ligne renvoyée par le SQL brut de la semaine (bigints Postgres). */
interface WeeklyRawRow {
  day: Date;
  ordersCount: bigint;
  revenue: bigint;
}

/** Ligne renvoyée par le SQL brut du top produits (bigints Postgres). */
interface TopProductRawRow {
  productId: string;
  productName: string;
  totalSold: bigint;
  totalRevenue: bigint;
}

export class StatsService {
  constructor(private readonly prismaClient: PrismaClient = prisma) {}

  /** Borne [00:00:00, 00:00:00+1j) locale pour une date donnée. */
  private dayBounds(date: Date): { start: Date; end: Date } {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  /** Statistiques du jour : commandes, revenus payés, clients uniques. */
  async getDailyStats(date: Date): Promise<DailyStats> {
    const { start, end } = this.dayBounds(date);
    const dayIso = start.toISOString().slice(0, 10);

    const [ordersCount, revenueAgg, customers] = await Promise.all([
      this.prismaClient.order.count({
        where: { createdAt: { gte: start, lt: end }, status: { not: 'CANCELLED' } },
      }),
      this.prismaClient.order.aggregate({
        _sum: { total: true },
        where: { createdAt: { gte: start, lt: end }, status: 'PAID' },
      }),
      this.prismaClient.order.findMany({
        where: { createdAt: { gte: start, lt: end } },
        distinct: ['phoneNumber'],
        select: { phoneNumber: true },
      }),
    ]);

    const revenue = revenueAgg._sum.total ?? 0;
    return {
      date: dayIso,
      ordersCount,
      revenue,
      uniqueCustomers: customers.length,
      revenueFormatted: formatPrice(revenue),
    };
  }

  /** Revenus des 7 derniers jours (graphique dashboard), trous à zéro. */
  async getWeeklyRevenue(): Promise<WeeklyRevenue[]> {
    const { start } = this.dayBounds(new Date());
    start.setDate(start.getDate() - 6); // 7 jours : J-6 → J

    const rows = await this.prismaClient.$queryRaw<WeeklyRawRow[]>(Prisma.sql`
      SELECT date_trunc('day', "createdAt")::date AS day,
             COUNT(*) AS "ordersCount",
             COALESCE(SUM("total") FILTER (WHERE "status" = 'PAID'), 0) AS revenue
      FROM "orders"
      WHERE "createdAt" >= ${start} AND "status" <> 'CANCELLED'
      GROUP BY 1
      ORDER BY 1
    `);

    const byDay = new Map<string, { ordersCount: number; revenue: number }>();
    for (const row of rows) {
      const iso = new Date(row.day).toISOString().slice(0, 10);
      byDay.set(iso, { ordersCount: Number(row.ordersCount), revenue: Number(row.revenue) });
    }

    // Remplit les 7 jours (les jours sans commande → 0/0)
    const result: WeeklyRevenue[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const entry = byDay.get(iso) ?? { ordersCount: 0, revenue: 0 };
      result.push({
        date: iso,
        ordersCount: entry.ordersCount,
        revenue: entry.revenue,
        revenueFormatted: formatPrice(entry.revenue),
      });
    }
    return result;
  }

  /** Top produits par chiffre d'affaires (via order_items, prix figés). */
  async getTopProducts(limit: number = 5): Promise<TopProduct[]> {
    const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
    const rows = await this.prismaClient.$queryRaw<TopProductRawRow[]>(Prisma.sql`
      SELECT oi."productId" AS "productId",
             p.name AS "productName",
             SUM(oi.quantity)::bigint AS "totalSold",
             SUM(oi.quantity * oi."unitPrice")::bigint AS "totalRevenue"
      FROM "order_items" oi
      JOIN "products" p ON p.id = oi."productId"
      GROUP BY oi."productId", p.name
      ORDER BY "totalRevenue" DESC
      LIMIT ${safeLimit}
    `);

    return rows.map((row) => {
      const totalRevenue = Number(row.totalRevenue);
      return {
        productId: row.productId,
        productName: row.productName,
        totalSold: Number(row.totalSold),
        totalRevenue,
        revenueFormatted: formatPrice(totalRevenue),
      };
    });
  }

  /**
   * Entonnoir de conversion. Sessions ≈ numéros distincts ayant commandé
   * (voir dashboard.types.ts — table ConversationLog à venir en Phase 6).
   */
  async getConversionStats(): Promise<ConversionStats> {
    const [sessions, totalOrders, paidOrders] = await Promise.all([
      this.prismaClient.order.findMany({ distinct: ['phoneNumber'], select: { phoneNumber: true } }),
      this.prismaClient.order.count(),
      this.prismaClient.order.count({ where: { status: 'PAID' } }),
    ]);

    const totalSessions = sessions.length;
    const round1 = (value: number): number => Math.round(value * 10) / 10;
    return {
      totalSessions,
      totalOrders,
      paidOrders,
      conversionRate: totalSessions > 0 ? round1((paidOrders / totalSessions) * 100) : 0,
      abandonRate: totalOrders > 0 ? round1(((totalOrders - paidOrders) / totalOrders) * 100) : 0,
    };
  }

  /** Produits actifs en stock bas (<= seuil), triés du plus critique. */
  async getLowStockProducts(threshold: number = 5): Promise<Product[]> {
    const safeThreshold = Math.min(1000, Math.max(0, Math.floor(threshold)));
    const rows = await this.prismaClient.product.findMany({
      where: { stock: { lte: safeThreshold }, isActive: true },
      orderBy: { stock: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      price: row.price,
      stock: row.stock,
      imageUrl: row.imageUrl ?? '',
      category: row.category,
      description: row.description,
      isActive: row.isActive,
    }));
  }
}