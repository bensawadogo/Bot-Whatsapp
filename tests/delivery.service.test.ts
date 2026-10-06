/**
 * Tests — delivery.service (persistance livraisons / livreurs).
 * Prisma et Redis sont mockés (pas de PostgreSQL ni de Redid réel) :
 * Redis est remplacé par un faux client in-memory (jest.mock config/redis).
 */
import { redis } from '../src/config/redis';
import { prisma } from '../src/config/database';
import * as deliveryService from '../src/modules/delivery/delivery.service';
import { DeliveryStatus } from '../src/modules/delivery/delivery.types';

jest.mock('../src/config/database', () => ({
  prisma: {
    livreur: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    delivery: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('../src/config/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

const mockedPrisma = prisma as unknown as {
  livreur: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  delivery: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
  };
};

const mockedRedis = redis as unknown as { get: jest.Mock; set: jest.Mock; del: jest.Mock };

const CACHE_PREFIX = 'afribot:';
const PHONE = '221771234567';
const CACHE_KEY = `${CACHE_PREFIX}livreur:${PHONE}`;

function makeLivreurRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'liv-1',
    merchantId: 'admin',
    name: '  Moussa Diop  ',
    phone: PHONE,
    zone: 'Dakar',
    isActive: true,
    isAvailable: true,
    totalDeliveries: 3,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeDeliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    orderId: 'abcdef123456',
    livreurId: 'liv-1',
    status: 'ASSIGNED',
    livreurPhone: PHONE,
    customerPhone: '221701234567',
    deliveryAddress: 'Rue 12, Dakar',
    estimatedTime: 30,
    proofPhoto: null,
    failureReason: null,
    codAmount: 5000,
    codCollected: false,
    notes: null,
    assignedAt: new Date('2026-01-02'),
    deliveredAt: null,
    createdAt: new Date('2026-01-02'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// normalizePhone / extractOrderIdReference (fonctions pures)
// ---------------------------------------------------------------------------

describe('normalizePhone', () => {
  it('retire le « + », les espaces, les tirets et le suffixe @s.whatsapp.net', () => {
    expect(deliveryService.normalizePhone('+221 77 123 45 67@s.whatsapp.net')).toBe('221771234567');
    expect(deliveryService.normalizePhone('221-77-12-34-567')).toBe('221771234567');
  });

  it('ne conserve que les chiffres et ignore les blancs de tête/queue', () => {
    expect(deliveryService.normalizePhone('  Client 123abc ')).toBe('123');
    expect(deliveryService.normalizePhone('   ')).toBe('');
  });
});

describe('extractOrderIdReference', () => {
  it('extrait la première référence hexadécimale de 8 caractères (en minuscules)', () => {
    expect(deliveryService.extractOrderIdReference('LIVRÉ ABCD12EFz')).toBe('abcd12ef');
    expect(deliveryService.extractOrderIdReference('abc12345 suit')).toBe('abc12345');
    expect(deliveryService.extractOrderIdReference('abcdef12zzzz')).toBe('abcdef12');
  });

  it('retourne null pour du texte sans référence valide', () => {
    expect(deliveryService.extractOrderIdReference('bonjour')).toBeNull();
    expect(deliveryService.extractOrderIdReference('')).toBeNull();
    expect(deliveryService.extractOrderIdReference('grosse commande à livrer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRegisteredLivreur (cache Redis)
// ---------------------------------------------------------------------------

describe('isRegisteredLivreur', () => {
  it('cache MISS : interroge PostgreSQL puis met en cache « 1 » avec TTL 300s', async () => {
    mockedRedis.get.mockResolvedValue(null);
    mockedPrisma.livreur.findUnique.mockResolvedValue({ isActive: true });

    await expect(deliveryService.isRegisteredLivreur(`+${PHONE}`)).resolves.toBe(true);

    expect(mockedPrisma.livreur.findUnique).toHaveBeenCalledWith({
      where: { phone: PHONE },
      select: { isActive: true },
    });
    expect(mockedRedis.set).toHaveBeenCalledWith(CACHE_KEY, '1', 'EX', 300);
  });

  it('cache MISS client non livreur : met en cache « 0 » (évite le martèlement PostgreSQL)', async () => {
    mockedRedis.get.mockResolvedValue(null);
    mockedPrisma.livreur.findUnique.mockResolvedValue({ isActive: false });

    await expect(deliveryService.isRegisteredLivreur(PHONE)).resolves.toBe(false);
    expect(mockedRedis.set).toHaveBeenCalledWith(CACHE_KEY, '0', 'EX', 300);
  });

  it('cache HIT « 1 » : retourne true sans toucher PostgreSQL', async () => {
    mockedRedis.get.mockResolvedValue('1');

    await expect(deliveryService.isRegisteredLivreur(PHONE)).resolves.toBe(true);
    expect(mockedPrisma.livreur.findUnique).not.toHaveBeenCalled();
  });

  it('cache HIT « 0 » : retourne false sans toucher PostgreSQL', async () => {
    mockedRedis.get.mockResolvedValue('0');

    await expect(deliveryService.isRegisteredLivreur(PHONE)).resolves.toBe(false);
    expect(mockedPrisma.livreur.findUnique).not.toHaveBeenCalled();
  });

  it('force=true court-circuite le cache', async () => {
    mockedPrisma.livreur.findUnique.mockResolvedValue({ isActive: true });

    await expect(deliveryService.isRegisteredLivreur(PHONE, true)).resolves.toBe(true);
    expect(mockedRedis.get).not.toHaveBeenCalled();
    expect(mockedPrisma.livreur.findUnique).toHaveBeenCalledTimes(1);
  });

  it('erreur Redis → graceful false (le flux client n est pas bloqué)', async () => {
    mockedRedis.get.mockRejectedValue(new Error('connection refused'));

    await expect(deliveryService.isRegisteredLivreur(PHONE)).resolves.toBe(false);
    expect(mockedPrisma.livreur.findUnique).not.toHaveBeenCalled();
  });

  it('erreur PostgreSQL → graceful false', async () => {
    mockedRedis.get.mockResolvedValue(null);
    mockedPrisma.livreur.findUnique.mockRejectedValue(new Error('db down'));

    await expect(deliveryService.isRegisteredLivreur(PHONE)).resolves.toBe(false);
  });

  it('numéro vide → false sans appeler Redis ni PostgreSQL', async () => {
    await expect(deliveryService.isRegisteredLivreur('')).resolves.toBe(false);
    await expect(deliveryService.isRegisteredLivreur('   ')).resolves.toBe(false);
    expect(mockedRedis.get).not.toHaveBeenCalled();
    expect(mockedPrisma.livreur.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Livreurs
// ---------------------------------------------------------------------------

describe('invalidateLivreurCache', () => {
  it('supprime la clé de cache du numéro', async () => {
    mockedRedis.del.mockResolvedValue(1);
    await deliveryService.invalidateLivreurCache(`+${PHONE}`);
    expect(mockedRedis.del).toHaveBeenCalledWith(CACHE_KEY);
  });

  it('erreur Redis → avalée (l invalidation ne casse jamais le flux)', async () => {
    mockedRedis.del.mockRejectedValue(new Error('redis down'));
    await expect(deliveryService.invalidateLivreurCache(PHONE)).resolves.toBeUndefined();
  });
});

describe('listLivreurs', () => {
  it('mappe les livreurs d un commerçant (actifs d abord, puis par nom)', async () => {
    mockedPrisma.livreur.findMany.mockResolvedValue([makeLivreurRow()]);

    const rows = await deliveryService.listLivreurs('admin');

    expect(mockedPrisma.livreur.findMany).toHaveBeenCalledWith({
      where: { merchantId: 'admin' },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].merchantId).toBe('admin');
  });
});

describe('listAvailableLivreurs', () => {
  it('ne retourne que les livreurs actifs ET disponibles', async () => {
    mockedPrisma.livreur.findMany.mockResolvedValue([makeLivreurRow({ zone: null })]);

    const rows = await deliveryService.listAvailableLivreurs('admin');

    expect(mockedPrisma.livreur.findMany).toHaveBeenCalledWith({
      where: { merchantId: 'admin', isActive: true, isAvailable: true },
      orderBy: { name: 'asc' },
    });
    expect(rows[0].zone).toBeNull();
  });
});

describe('getDeliveryByOrderId / getDeliveryById', () => {
  it('retrouvent une livraison et retournent null si absente', async () => {
    mockedPrisma.delivery.findUnique.mockResolvedValue(makeDeliveryRow());

    const byOrder = await deliveryService.getDeliveryByOrderId('abcdef123456');
    const byId = await deliveryService.getDeliveryById('del-1');
    expect(byOrder?.orderId).toBe('abcdef123456');
    expect(byId?.id).toBe('del-1');

    mockedPrisma.delivery.findUnique.mockResolvedValue(null);
    await expect(deliveryService.getDeliveryByOrderId('nope')).resolves.toBeNull();
    await expect(deliveryService.getDeliveryById('nope')).resolves.toBeNull();
  });
});

describe('createLivreur', () => {
  it('normalise nom / téléphone / zone puis invalide le cache de détection', async () => {
    mockedPrisma.livreur.create.mockResolvedValue(
      makeLivreurRow({ name: 'Moussa Diop', phone: PHONE, zone: 'Dakar' }),
    );

    const livreur = await deliveryService.createLivreur({
      merchantId: 'admin',
      name: '  Moussa Diop  ',
      phone: '+221 77 123 45 67@s.whatsapp.net',
      zone: ' Dakar ',
    });

    expect(mockedPrisma.livreur.create).toHaveBeenCalledWith({
      data: {
        merchantId: 'admin',
        name: 'Moussa Diop',
        phone: PHONE,
        zone: 'Dakar',
      },
    });
    expect(mockedRedis.del).toHaveBeenCalledWith(CACHE_KEY);
    expect(livreur).toMatchObject({ id: 'liv-1', name: 'Moussa Diop', phone: PHONE, isActive: true });
  });
});

describe('deactivateLivreur', () => {
  it('livreur introuvable → null sans update ni invalidation', async () => {
    mockedPrisma.livreur.findUnique.mockResolvedValue(null);

    await expect(deliveryService.deactivateLivreur('nope')).resolves.toBeNull();
    expect(mockedPrisma.livreur.update).not.toHaveBeenCalled();
    expect(mockedRedis.del).not.toHaveBeenCalled();
  });

  it('désactive (soft delete) et invalide le cache', async () => {
    mockedPrisma.livreur.findUnique.mockResolvedValue({ id: 'liv-1' });
    mockedPrisma.livreur.update.mockResolvedValue(makeLivreurRow({ isActive: false, isAvailable: false }));

    const livreur = await deliveryService.deactivateLivreur('liv-1');

    expect(mockedPrisma.livreur.update).toHaveBeenCalledWith({
      where: { id: 'liv-1' },
      data: { isActive: false, isAvailable: false },
    });
    expect(mockedRedis.del).toHaveBeenCalledWith(CACHE_KEY);
    expect(livreur?.isActive).toBe(false);
  });
});

describe('findLivreurByPhone', () => {
  it('retourne null si aucun livreur actif pour ce numéro', async () => {
    mockedPrisma.livreur.findUnique.mockResolvedValue(null);
    await expect(deliveryService.findLivreurByPhone(PHONE)).resolves.toBeNull();

    mockedPrisma.livreur.findUnique.mockResolvedValue(makeLivreurRow({ isActive: false }));
    await expect(deliveryService.findLivreurByPhone(PHONE)).resolves.toBeNull();
  });

  it('mappe le livreur actif', async () => {
    mockedPrisma.livreur.findUnique.mockResolvedValue(makeLivreurRow());
    const livreur = await deliveryService.findLivreurByPhone(`+${PHONE}`);
    expect(livreur).toMatchObject({ id: 'liv-1', phone: PHONE, zone: 'Dakar' });
  });
});

describe('setLivreurAvailability', () => {
  it('met à jour la disponibilité (DISPO/INDISPO)', async () => {
    mockedPrisma.livreur.findUnique.mockResolvedValue(makeLivreurRow());
    mockedPrisma.livreur.update.mockResolvedValue(makeLivreurRow({ isAvailable: false }));

    await deliveryService.setLivreurAvailability(PHONE, false);
    expect(mockedPrisma.livreur.update).toHaveBeenCalledWith({
      where: { id: 'liv-1' },
      data: { isAvailable: false },
    });
  });

  it('livreur inconnu → null', async () => {
    mockedPrisma.livreur.findUnique.mockResolvedValue(null);
    await expect(deliveryService.setLivreurAvailability(PHONE, true)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Livraisons
// ---------------------------------------------------------------------------

describe('upsertAssignedDelivery', () => {
  it('crée la livraison ASSIGNED avec options (idempotent : upsert sur orderId)', async () => {
    mockedPrisma.delivery.upsert.mockResolvedValue(makeDeliveryRow());

    const input = {
      orderId: 'abcdef123456',
      customerPhone: '221701234567',
      deliveryAddress: 'Rue 12, Dakar',
      livreurId: 'liv-1',
      livreurPhone: PHONE,
      codAmount: 5000,
      options: { estimatedTime: 45, notes: 'Appeler avant' },
    };

    const first = await deliveryService.upsertAssignedDelivery(input);
    const second = await deliveryService.upsertAssignedDelivery(input);

    expect(mockedPrisma.delivery.upsert).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.delivery.upsert).toHaveBeenCalledWith({
      where: { orderId: 'abcdef123456' },
      create: expect.objectContaining({
        orderId: 'abcdef123456',
        status: 'ASSIGNED',
        estimatedTime: 45,
        notes: 'Appeler avant',
        assignedAt: expect.any(Date),
        failureReason: null,
      }),
      update: expect.objectContaining({
        livreurId: 'liv-1',
        status: 'ASSIGNED',
        estimatedTime: 45,
        codAmount: 5000,
      }),
    });
    expect(first.id).toBe('del-1');
    expect(second.id).toBe('del-1');
  });
});

describe('updateDeliveryStatus', () => {
  it('livraison introuvable → null (update non appelé)', async () => {
    mockedPrisma.delivery.findUnique.mockResolvedValue(null);

    await expect(
      deliveryService.updateDeliveryStatus('nope', DeliveryStatus.FAILED),
    ).resolves.toBeNull();
    expect(mockedPrisma.delivery.update).not.toHaveBeenCalled();
  });

  it('met à jour le statut + champs optionnels fournis uniquement', async () => {
    mockedPrisma.delivery.findUnique.mockResolvedValue({ id: 'del-1' });
    mockedPrisma.delivery.update.mockResolvedValue(
      makeDeliveryRow({ status: 'DELIVERED', codCollected: true }),
    );

    const result = await deliveryService.updateDeliveryStatus('del-1', DeliveryStatus.DELIVERED, {
      proofPhoto: 'photo.jpg',
      codCollected: true,
      deliveredAt: new Date('2026-01-03'),
    });

    const data = mockedPrisma.delivery.update.mock.calls[0][0].data;
    expect(data.status).toBe('DELIVERED');
    expect(data.proofPhoto).toBe('photo.jpg');
    expect(data.codCollected).toBe(true);
    expect(data.deliveredAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('failureReason');
    expect(result?.status).toBe('DELIVERED');
  });

  it('n ajoute pas d extras (failureReason) quand ils sont absents', async () => {
    mockedPrisma.delivery.findUnique.mockResolvedValue({ id: 'del-1' });
    mockedPrisma.delivery.update.mockResolvedValue(makeDeliveryRow());

    await deliveryService.updateDeliveryStatus('del-1', DeliveryStatus.FAILED);

    const data = mockedPrisma.delivery.update.mock.calls[0][0].data;
    expect(data.status).toBe('FAILED');
    expect(data).not.toHaveProperty('failureReason');
    expect(data).not.toHaveProperty('codCollected');
  });
});

describe('findDeliveryForLivreur (garde-fou propriété)', () => {
  it('retourne la livraison si elle appartient au livreur (numéro normalisé)', async () => {
    mockedPrisma.delivery.findUnique.mockResolvedValue(makeDeliveryRow());

    const delivery = await deliveryService.findDeliveryForLivreur(
      '+221 77 123 45 67@s.whatsapp.net',
      'abcdef123456',
    );
    expect(delivery?.id).toBe('del-1');
  });

  it('retourne null pour un AUTRE livreur', async () => {
    mockedPrisma.delivery.findUnique.mockResolvedValue(makeDeliveryRow());

    await expect(
      deliveryService.findDeliveryForLivreur('221789999999', 'abcdef123456'),
    ).resolves.toBeNull();
  });

  it('retourne null si la livraison n est assignée à personne', async () => {
    mockedPrisma.delivery.findUnique.mockResolvedValue(makeDeliveryRow({ livreurPhone: null }));

    await expect(
      deliveryService.findDeliveryForLivreur(PHONE, 'abcdef123456'),
    ).resolves.toBeNull();
  });
});

describe('findActiveDeliveryForLivreur', () => {
  it('retourne la livraison active la plus récente (ASSIGNED/PICKED_UP/EN_ROUTE)', async () => {
    mockedPrisma.delivery.findFirst.mockResolvedValue(makeDeliveryRow({ status: 'PICKED_UP' }));

    const delivery = await deliveryService.findActiveDeliveryForLivreur(`+${PHONE}`);

    expect(mockedPrisma.delivery.findFirst).toHaveBeenCalledWith({
      where: {
        livreurPhone: PHONE,
        status: { in: ['ASSIGNED', 'PICKED_UP', 'EN_ROUTE'] },
      },
      orderBy: { assignedAt: 'desc' },
    });
    expect(delivery?.status).toBe('PICKED_UP');
  });

  it('retourne null si aucune livraison active', async () => {
    mockedPrisma.delivery.findFirst.mockResolvedValue(null);
    await expect(deliveryService.findActiveDeliveryForLivreur(PHONE)).resolves.toBeNull();
  });
});

describe('listActiveDeliveries', () => {
  it('enrichit chaque livraison (livreur, total, items client)', async () => {
    mockedPrisma.delivery.findMany.mockResolvedValue([
      {
        ...makeDeliveryRow(),
        livreur: { name: 'Moussa' },
        order: {
          total: 5000,
          status: 'CONFIRMED',
          items: [{ quantity: 2, product: { name: 'Riz 5kg' } }],
        },
      },
    ]);

    const list = await deliveryService.listActiveDeliveries();

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'del-1',
      livreurName: 'Moussa',
      orderTotal: 5000,
      orderStatus: 'CONFIRMED',
      customerItems: [{ productName: 'Riz 5kg', quantity: 2 }],
    });
    expect(mockedPrisma.delivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['ASSIGNED', 'PICKED_UP', 'EN_ROUTE'] } },
        orderBy: { assignedAt: 'desc' },
      }),
    );
  });
});

describe('incrementLivreurDeliveries', () => {
  it('incrémente atomiquement le compteur via Prisma', async () => {
    mockedPrisma.livreur.update.mockResolvedValue(makeLivreurRow());

    await deliveryService.incrementLivreurDeliveries('liv-1');

    expect(mockedPrisma.livreur.update).toHaveBeenCalledWith({
      where: { id: 'liv-1' },
      data: { totalDeliveries: { increment: 1 } },
    });
  });
});