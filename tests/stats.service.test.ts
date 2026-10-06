/**
 * Tests — service statistiques du dashboard (Phase 5).
 * Prisma est mocké (pas de PostgreSQL requis), pattern identique aux autres
 * tests du projet : jest.mock('../src/config/database') + client en mémoire.
 *
 * NB : le service compile du SQL via Prisma.sql ($queryRaw). On ne l'exécute
 * pas — on asserte les valeurs interpolées du Sql object (rows bigint etc.).
 */
import type { PrismaClient } from '@prisma/client';

import { prisma } from '../src/config/database';
import { StatsService } from '../src/modules/dashboard/stats.service';
import { formatPrice } from '../src/shared/format';

jest.mock('../src/config/database', () => ({
  prisma: {
    order: {
      count: jest.fn(),
      aggregate: jest.fn(),
      findMany: jest.fn(),
    },
    product: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

const mockedPrisma = prisma as jest.Mocked<typeof prisma>;

/** Convertit un Date local en chaîne YYYY-MM-DD (fuseau du serveur). */
function localIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Les 7 dates locales [J … J-6] attendues par getWeeklyRevenue (plus récent d'abord). */
function weeklyWindow(): string[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const dates: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(localIso(d));
  }
  return dates;
}

/** Dernier argument passé à $queryRaw = le Sql object Prisma (text + values). */
function lastSqlArg(): { text: string; values: unknown[] } {
  const calls = (mockedPrisma.$queryRaw as jest.Mock).mock.calls;
  const call = calls[calls.length - 1][0] as {
    text: string;
    values: unknown[];
  };
  return call;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('StatsService.getDailyStats', () => {
  const date = new Date('2026-09-15T10:00:00.000Z');

  it('compte les commandes, somme les revenus PAID et compte les clients uniques', async () => {
    (mockedPrisma.order.count as jest.Mock).mockResolvedValue(4);
    (mockedPrisma.order.aggregate as jest.Mock).mockResolvedValue({ _sum: { total: 12500 } });
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue([
      { phoneNumber: '22177000001' },
      { phoneNumber: '22177000002' },
      { phoneNumber: '22177000003' },
    ]);

    const result = await new StatsService().getDailyStats(date);

    expect(result).toEqual({
      date: localIso(
        (() => {
          const d = new Date(date);
          d.setHours(0, 0, 0, 0);
          return d;
        })(),
      ),
      ordersCount: 4,
      revenue: 12500,
      uniqueCustomers: 3,
      revenueFormatted: '12 500 FCFA',
    });

    expect(mockedPrisma.order.count).toHaveBeenCalledWith({
      where: {
        createdAt: {
          gte: expect.any(Date),
          lt: expect.any(Date),
        },
        status: { not: 'CANCELLED' },
      },
    });
    expect(mockedPrisma.order.aggregate).toHaveBeenCalledWith({
      _sum: { total: true },
      where: {
        createdAt: {
          gte: expect.any(Date),
          lt: expect.any(Date),
        },
        status: 'PAID',
      },
    });
    expect(mockedPrisma.order.findMany).toHaveBeenCalledWith({
      where: {
        createdAt: {
          gte: expect.any(Date),
          lt: expect.any(Date),
        },
      },
      distinct: ['phoneNumber'],
      select: { phoneNumber: true },
    });
  });

  it('retourne un revenu à zéro quand aucune commande payée (agrégat null)', async () => {
    (mockedPrisma.order.count as jest.Mock).mockResolvedValue(0);
    (mockedPrisma.order.aggregate as jest.Mock).mockResolvedValue({ _sum: { total: null } });
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue([]);

    const result = await new StatsService().getDailyStats(date);

    expect(result.revenue).toBe(0);
    expect(result.revenueFormatted).toBe('0 FCFA');
    expect(result.uniqueCustomers).toBe(0);
  });

  it('propage l erreur Prisma au lieu de la masquer', async () => {
    (mockedPrisma.order.count as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(new StatsService().getDailyStats(date)).rejects.toThrow('db down');
  });
});

describe('StatsService.getWeeklyRevenue', () => {
  it('retourne 7 jours consécutifs, avec zéros pour les jours sans commande', async () => {
    const dates = weeklyWindow();
    (mockedPrisma.$queryRaw as jest.Mock).mockResolvedValue([
      { day: new Date(`${dates[1]}T00:00:00.000Z`), ordersCount: 3n, revenue: 4500n },
      { day: new Date(`${dates[5]}T00:00:00.000Z`), ordersCount: 1n, revenue: 2000n },
    ]);

    const result = await new StatsService().getWeeklyRevenue();

    expect(result).toHaveLength(7);
    expect(result.map((r) => r.date)).toEqual(dates);
    // NB : le service renvoie les jours du plus récent (J) au plus ancien (J-6).
    for (let i = 1; i < result.length; i++) {
      const diff = Math.abs(Date.parse(result[i].date) - Date.parse(result[i - 1].date));
      expect(diff).toBe(86_400_000);
    }

    expect(result[1]).toMatchObject({ ordersCount: 3, revenue: 4500 });
    expect(result[1].revenueFormatted).toBe(formatPrice(4500));
    expect(result[5]).toMatchObject({ ordersCount: 1, revenue: 2000 });
    expect(result[5].revenueFormatted).toBe(formatPrice(2000));
    expect(result[0]).toMatchObject({ ordersCount: 0, revenue: 0 });
    expect(result[0].revenueFormatted).toBe('0 FCFA');
    expect(result[6]).toMatchObject({ ordersCount: 0, revenue: 0 });
  });

  it('retourne 7 jours à zéro quand aucune requête ne renvoie de lignes', async () => {
    (mockedPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    const result = await new StatsService().getWeeklyRevenue();

    expect(result).toHaveLength(7);
    expect(result.every((r) => r.ordersCount === 0 && r.revenue === 0 && r.revenueFormatted === '0 FCFA')).toBe(true);
  });

  it('borne la requête à minuit local J-6 (date interpolée dans le SQL)', async () => {
    (mockedPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    await new StatsService().getWeeklyRevenue();

    const { text, values } = lastSqlArg();
    expect(text).toContain('date_trunc');
    expect(text).toContain('FILTER (WHERE "status" = \'PAID\')');
    expect(values).toHaveLength(1);
    const boundStart = values[0] as Date;
    const expected = new Date();
    expected.setHours(0, 0, 0, 0);
    expected.setDate(expected.getDate() - 6);
    expect(boundStart.getTime()).toBe(expected.getTime());
  });

  it('propage l erreur Prisma au lieu de la masquer', async () => {
    (mockedPrisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('raw down'));
    await expect(new StatsService().getWeeklyRevenue()).rejects.toThrow('raw down');
  });
});

describe('StatsService.getTopProducts', () => {
  it('mappe les lignes (bigints → number) et borne le LIMIT par défaut à 5', async () => {
    (mockedPrisma.$queryRaw as jest.Mock).mockResolvedValue([
      { productId: 'p1', productName: 'Manuel', totalSold: 12n, totalRevenue: 60000n },
      { productId: 'p2', productName: 'Cahier', totalSold: 5n, totalRevenue: 2500n },
    ]);

    const result = await new StatsService().getTopProducts();

    expect(result).toEqual([
      { productId: 'p1', productName: 'Manuel', totalSold: 12, totalRevenue: 60000, revenueFormatted: '60 000 FCFA' },
      { productId: 'p2', productName: 'Cahier', totalSold: 5, totalRevenue: 2500, revenueFormatted: '2 500 FCFA' },
    ]);
    expect(lastSqlArg().text).toContain('LIMIT');
    expect(lastSqlArg().values).toEqual([5]);
  });

  it('respecte le limit transmis', async () => {
    (mockedPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    await new StatsService().getTopProducts(2);
    expect(lastSqlArg().values).toEqual([2]);
  });

  it('borne le limit à [1, 50] (et arrondit à l entier inférieur)', async () => {
    const cases: Array<[number, number]> = [
      [100, 50],
      [50, 50],
      [0, 1],
      [-3, 1],
      [2.9, 2],
      [1, 1],
    ];
    for (const [input, expected] of cases) {
      (mockedPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      await new StatsService().getTopProducts(input);
      expect(lastSqlArg().values).toEqual([expected]);
    }
  });

  it('retourne un tableau vide sans lignes', async () => {
    (mockedPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    await expect(new StatsService().getTopProducts()).resolves.toEqual([]);
  });

  it('propage l erreur Prisma au lieu de la masquer', async () => {
    (mockedPrisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('aggregate down'));
    await expect(new StatsService().getTopProducts()).rejects.toThrow('aggregate down');
  });
});

describe('StatsService.getConversionStats', () => {
  it('calcule conversion (payées/sessions) et abandon (non payées/commandes) à 1 décimale', async () => {
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue([
      { phoneNumber: 'a' },
      { phoneNumber: 'b' },
      { phoneNumber: 'c' },
      { phoneNumber: 'd' },
    ]);
    (mockedPrisma.order.count as jest.Mock).mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const result = await new StatsService().getConversionStats();

    expect(result.totalSessions).toBe(4);
    expect(result.totalOrders).toBe(3);
    expect(result.paidOrders).toBe(2);
    expect(result.conversionRate).toBe(50);
    expect(result.abandonRate).toBe(33.3);
    expect(mockedPrisma.order.count).toHaveBeenCalledTimes(2);
    expect((mockedPrisma.order.count as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      undefined,
      { where: { status: 'PAID' } },
    ]);
  });

  it('arrondit bien à 1 décimale', async () => {
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ phoneNumber: `n${i}` })));
    (mockedPrisma.order.count as jest.Mock).mockResolvedValueOnce(6).mockResolvedValueOnce(1);

    const result = await new StatsService().getConversionStats();

    expect(result.conversionRate).toBe(16.7);
    expect(result.abandonRate).toBe(83.3);
  });

  it('retourne 0 % sans NaN quand aucune session ni commande', async () => {
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue([]);
    (mockedPrisma.order.count as jest.Mock).mockResolvedValue(0);

    const result = await new StatsService().getConversionStats();

    expect(result.totalSessions).toBe(0);
    expect(result.totalOrders).toBe(0);
    expect(result.paidOrders).toBe(0);
    expect(result.conversionRate).toBe(0);
    expect(result.abandonRate).toBe(0);
    expect(Number.isNaN(result.conversionRate)).toBe(false);
    expect(Number.isNaN(result.abandonRate)).toBe(false);
  });

  it('retourne 0 % de conversion quand aucune session mais des commandes non payées', async () => {
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue([]);
    (mockedPrisma.order.count as jest.Mock).mockResolvedValueOnce(5).mockResolvedValueOnce(0);

    const result = await new StatsService().getConversionStats();

    expect(result.conversionRate).toBe(0);
    expect(result.abandonRate).toBe(100);
  });

  it('propage l erreur Prisma au lieu de la masquer', async () => {
    (mockedPrisma.order.findMany as jest.Mock).mockRejectedValue(new Error('sessions down'));
    await expect(new StatsService().getConversionStats()).rejects.toThrow('sessions down');
  });
});

describe('StatsService.getLowStockProducts', () => {
  it('filtre stock ≤ seuil + actifs, trie par stock asc et remplace imageUrl null par ""', async () => {
    (mockedPrisma.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'p1',
        name: 'Riz 5kg',
        price: 5000,
        stock: 2,
        imageUrl: null,
        category: 'aliment',
        description: 'sac 5 kg',
        isActive: true,
      },
      {
        id: 'p2',
        name: 'Lait',
        price: 1000,
        stock: 1,
        imageUrl: 'https://img/lait.png',
        category: 'boisson',
        description: '',
        isActive: true,
      },
    ]);

    const result = await new StatsService().getLowStockProducts(5);

    expect(result).toEqual([
      {
        id: 'p1',
        name: 'Riz 5kg',
        price: 5000,
        stock: 2,
        imageUrl: '',
        category: 'aliment',
        description: 'sac 5 kg',
        isActive: true,
      },
      {
        id: 'p2',
        name: 'Lait',
        price: 1000,
        stock: 1,
        imageUrl: 'https://img/lait.png',
        category: 'boisson',
        description: '',
        isActive: true,
      },
    ]);
    expect(mockedPrisma.product.findMany).toHaveBeenCalledWith({
      where: { stock: { lte: 5 }, isActive: true },
      orderBy: { stock: 'asc' },
    });
  });

  it('borne le seuil à [0, 1000] (et arrondit à l entier inférieur)', async () => {
    const cases: Array<[number, number]> = [
      [2000, 1000],
      [1000, 1000],
      [-5, 0],
      [2.9, 2],
      [0, 0],
    ];
    for (const [input, expected] of cases) {
      (mockedPrisma.product.findMany as jest.Mock).mockResolvedValue([]);
      await new StatsService().getLowStockProducts(input);
      expect(mockedPrisma.product.findMany).toHaveBeenLastCalledWith({
        where: { stock: { lte: expected }, isActive: true },
        orderBy: { stock: 'asc' },
      });
    }
  });

  it('retourne un tableau vide sans produit', async () => {
    (mockedPrisma.product.findMany as jest.Mock).mockResolvedValue([]);
    await expect(new StatsService().getLowStockProducts()).resolves.toEqual([]);
  });

  it('propage l erreur Prisma au lieu de la masquer', async () => {
    (mockedPrisma.product.findMany as jest.Mock).mockRejectedValue(new Error('stock down'));
    await expect(new StatsService().getLowStockProducts()).rejects.toThrow('stock down');
  });
});

describe('StatsService (injection de dépendances)', () => {
  it('utilise le client Prisma injecté au lieu du singleton', async () => {
    const injected = {
      order: { count: jest.fn(), aggregate: jest.fn(), findMany: jest.fn() },
      product: { findMany: jest.fn() },
      $queryRaw: jest.fn(),
    };
    (injected.$queryRaw as jest.Mock).mockResolvedValue([]);

    const result = await new StatsService(injected as unknown as PrismaClient).getTopProducts(3);

    expect(result).toEqual([]);
    expect(injected.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});