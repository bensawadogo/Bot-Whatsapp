/**
 * Tests — service remboursements (Phase 2).
 * Prisma est mocké (pas de PostgreSQL requis), pattern identique aux
 * autres tests du projet (tests/setup.ts fournit les env vars).
 */
import { prisma } from '../src/config/database';
import { RefundError, refundOrder, isRefundable } from '../src/modules/payments/refund.service';
import { PaymentStatus } from '../src/modules/payments/payment.types';

jest.mock('../src/config/database', () => ({
  prisma: {
    order: { findUnique: jest.fn(), update: jest.fn() },
    payment: { update: jest.fn() },
    product: { update: jest.fn() },
    $transaction: jest.fn(),
  },
}));

const mockedPrisma = prisma as jest.Mocked<typeof prisma>;

function makeOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'order-r1',
    status: 'PAID',
    items: [
      { productId: 'prod-1', quantity: 2, unitPrice: 1500 },
      { productId: 'prod-2', quantity: 1, unitPrice: 500 },
    ],
    payments: [
      {
        id: 'pay-1',
        provider: 'CINETPAY',
        transactionId: 'tx-cp-9',
        amount: 3500,
        status: PaymentStatus.SUCCESS,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Les vrais appels Prisma retournent des PrismaPromise (objets) : on fait
  // écho des arguments pour que le tableau $transaction soit inspectable.
  (mockedPrisma.payment.update as jest.Mock).mockImplementation((args: unknown) => args);
  (mockedPrisma.order.update as jest.Mock).mockImplementation((args: unknown) => args);
  (mockedPrisma.product.update as jest.Mock).mockImplementation((args: unknown) => args);
  (mockedPrisma.$transaction as jest.Mock).mockResolvedValue([]);
});

describe('refundOrder', () => {
  it('marque REFUNDED, annule la commande et remet les produits en stock', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());

    const result = await refundOrder('order-r1');

    expect(result.orderId).toBe('order-r1');
    expect(result.transactionId).toBe('tx-cp-9');
    expect(result.provider).toBe('CINETPAY');
    expect(result.amount).toBe(3500);
    expect(result.restocked).toEqual([
      { productId: 'prod-1', quantity: 2 },
      { productId: 'prod-2', quantity: 1 },
    ]);

    // Transaction atomique : 1 payment.update + 1 order.update + 2 restocks
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = (mockedPrisma.$transaction as jest.Mock).mock.calls[0][0];
    expect(ops).toHaveLength(4);
    expect(ops[0]).toMatchObject({ where: { id: 'pay-1' }, data: { status: 'REFUNDED' } });
    expect(ops[1]).toMatchObject({ where: { id: 'order-r1' }, data: { status: 'CANCELLED' } });
    expect(ops[2]).toMatchObject({
      where: { id: 'prod-1' },
      data: { stock: { increment: 2 } },
    });
    expect(ops[3]).toMatchObject({
      where: { id: 'prod-2' },
      data: { stock: { increment: 1 } },
    });
  });

  it('rejette une commande introuvable (RefundError)', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(refundOrder('nope')).rejects.toThrow(RefundError);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('est idempotent : refuse une commande déjà annulée', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(makeOrder({ status: 'CANCELLED' }));
    await expect(refundOrder('order-r1')).rejects.toThrow('déjà annulée');
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejette une commande sans paiement SUCCESS (COD)', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(
      makeOrder({ payments: [{ id: 'pay-2', provider: 'CINETPAY', transactionId: 'tx-2', amount: 3500, status: PaymentStatus.PENDING }] }),
    );
    await expect(refundOrder('order-r1')).rejects.toThrow('Aucun paiement SUCCESS');
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('isRefundable', () => {
  it('retourne true pour une commande payée avec paiement SUCCESS', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(makeOrder());
    await expect(isRefundable('order-r1')).resolves.toBe(true);
  });

  it('retourne false si la commande est introuvable ou annulée', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(isRefundable('nope')).resolves.toBe(false);
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(makeOrder({ status: 'CANCELLED' }));
    await expect(isRefundable('order-r1')).resolves.toBe(false);
  });

  it('retourne false sans paiement SUCCESS', async () => {
    (mockedPrisma.order.findUnique as jest.Mock).mockResolvedValue(makeOrder({ payments: [] }));
    await expect(isRefundable('order-r1')).resolves.toBe(false);
  });
});