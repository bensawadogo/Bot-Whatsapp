/**
 * Tests — service commandes (Phase 2).
 * Prisma est mocké (pas de PostgreSQL requis), pattern identique aux
 * autres tests du projet (tests/setup.ts fournit les env vars).
 */
import { prisma } from '../src/config/database';
import {
  createOrder,
  getOrderById,
  updateOrderStatus,
  listOrders,
  InsufficientStockError,
  OrderNotFoundError,
} from '../src/modules/orders/order.service';
import { OrderStatus, PaymentMethod } from '../src/modules/orders/order.types';

jest.mock('../src/config/database', () => ({
  prisma: {
    order: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
    product: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}));

const mockedPrisma = prisma as jest.Mocked<typeof prisma>;

const PHONE = '221771234567';
const ADDRESS = 'Médina, Dakar';
const CREATED_AT = new Date('2026-09-11T10:00:00Z');

function makeProduct() {
  return { id: 'prod-1', name: 'Produit A', stock: 10, price: 1500 };
}

function makeOrderRow() {
  return {
    id: 'order-1',
    phoneNumber: PHONE,
    total: 3000,
    status: 'PENDING',
    paymentMethod: 'COD',
    address: ADDRESS,
    createdAt: CREATED_AT,
    items: [{ productId: 'prod-1', quantity: 2, unitPrice: 1500 }],
  };
}

function makeTx() {
  return {
    product: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    order: { create: jest.fn() },
  };
}

const ORDER_ITEMS = [{ productId: 'prod-1', quantity: 2, unitPrice: 1500 }];

describe('createOrder', () => {
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    tx = makeTx();
    (mockedPrisma.$transaction as jest.Mock).mockImplementation((callback: (t: typeof tx) => unknown) => callback(tx));
  });

  it('crée la commande et décrémente le stock via un update conditionnel', async () => {
    (tx.product.findMany as jest.Mock).mockResolvedValue([makeProduct()]);
    (tx.order.create as jest.Mock).mockResolvedValue(makeOrderRow());
    (tx.product.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const result = await createOrder({
      phoneNumber: PHONE,
      items: ORDER_ITEMS,
      paymentMethod: PaymentMethod.COD,
      address: ADDRESS,
    });

    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phoneNumber: PHONE,
          total: 3000,
          status: 'PENDING',
          paymentMethod: 'COD',
          address: ADDRESS,
          items: { create: ORDER_ITEMS },
        }),
        include: { items: true },
      }),
    );
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'prod-1', stock: { gte: 2 } },
      data: { stock: { decrement: 2 } },
    });
    expect(result).toEqual({
      id: 'order-1',
      phoneNumber: PHONE,
      items: ORDER_ITEMS,
      total: 3000,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.COD,
      address: ADDRESS,
      createdAt: CREATED_AT,
    });
  });

  it('rejette si le stock est insuffisant (update conditionnel à count 0)', async () => {
    (tx.product.findMany as jest.Mock).mockResolvedValue([{ ...makeProduct(), stock: 1 }]);
    (tx.order.create as jest.Mock).mockResolvedValue(makeOrderRow());
    (tx.product.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (tx.product.findUnique as jest.Mock).mockResolvedValue({ stock: 1 });

    const attempt = createOrder({
      phoneNumber: PHONE,
      items: ORDER_ITEMS,
      paymentMethod: PaymentMethod.COD,
      address: ADDRESS,
    });
    await expect(attempt).rejects.toThrow(InsufficientStockError);
    await expect(attempt).rejects.toThrow('Stock insuffisant pour "Produit A"');
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejette si le produit est introuvable avant de créer la commande', async () => {
    (tx.product.findMany as jest.Mock).mockResolvedValue([]);

    await expect(
      createOrder({
        phoneNumber: PHONE,
        items: [{ productId: 'prod-inexistant', quantity: 1, unitPrice: 100 }],
        paymentMethod: PaymentMethod.MOBILE_MONEY,
        address: ADDRESS,
      }),
    ).rejects.toThrow('Produit introuvable : prod-inexistant');
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
});

describe('getOrderById', () => {
  it('retourne la commande (avec lignes)', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(makeOrderRow());

    const result = await getOrderById('order-1');

    expect(mockedPrisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'order-1' }, include: { items: true } });
    expect(result).toEqual({
      id: 'order-1',
      phoneNumber: PHONE,
      items: ORDER_ITEMS,
      total: 3000,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.COD,
      address: ADDRESS,
      createdAt: CREATED_AT,
    });
  });

  it('retourne null si introuvable', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(getOrderById('nope')).resolves.toBeNull();
  });
});

describe('updateOrderStatus', () => {
  it('met à jour le statut quand la commande existe', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue({ id: 'order-1' });
    (mockedPrisma.order.update as jest.Mock).mockResolvedValue({});

    await updateOrderStatus('order-1', OrderStatus.CONFIRMED);

    expect(mockedPrisma.order.update).toHaveBeenCalledWith({ where: { id: 'order-1' }, data: { status: 'CONFIRMED' } });
  });

  it('rejette une commande introuvable (OrderNotFoundError)', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(updateOrderStatus('nope', OrderStatus.CONFIRMED)).rejects.toThrow(OrderNotFoundError);
    expect(mockedPrisma.order.update).not.toHaveBeenCalled();
  });
});

describe('listOrders', () => {
  it('applique les filtres et la pagination', async () => {
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue([{ ...makeOrderRow(), status: 'CONFIRMED' }]);
    (mockedPrisma.order.count as jest.Mock).mockResolvedValue(1);

    const result = await listOrders({ status: OrderStatus.CONFIRMED, phoneNumber: PHONE, page: 2, limit: 10 });

    expect(mockedPrisma.order.findMany).toHaveBeenCalledWith({
      where: { status: 'CONFIRMED', phoneNumber: PHONE },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
      include: { items: true },
    });
    expect(result).toEqual({
      orders: [
        {
          id: 'order-1',
          phoneNumber: PHONE,
          items: ORDER_ITEMS,
          total: 3000,
          status: OrderStatus.CONFIRMED,
          paymentMethod: PaymentMethod.COD,
          address: ADDRESS,
          createdAt: CREATED_AT,
        },
      ],
      total: 1,
      page: 2,
      limit: 10,
      totalPages: 1,
    });
  });

  it('omet les filtres absents et borne la pagination', async () => {
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue([]);
    (mockedPrisma.order.count as jest.Mock).mockResolvedValue(0);

    const result = await listOrders({ page: 0, limit: 500 });

    expect(mockedPrisma.order.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 100,
      include: { items: true },
    });
    expect(result).toEqual({ orders: [], total: 0, page: 1, limit: 100, totalPages: 0 });
  });

  it('utilise page=1 limit=20 par défaut', async () => {
    (mockedPrisma.order.findMany as jest.Mock).mockResolvedValue([]);
    (mockedPrisma.order.count as jest.Mock).mockResolvedValue(0);

    const result = await listOrders({});

    expect(mockedPrisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });
});