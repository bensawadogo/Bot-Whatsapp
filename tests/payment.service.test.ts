/**
 * Tests — service paiements (CinetPay + FedaPay, persistence).
 * Moke axios (HTTP) et prisma (persistence) — aucun appel réseau réel.
 */
import axios from 'axios';

import { prisma } from '../src/config/database';
import {
  createCinetPayLink,
  createFedaPayLink,
  verifyPayment,
  createPaymentRecord,
  updatePaymentStatus,
  redactId,
} from '../src/modules/payments/payment.service';
import {
  PaymentProvider,
  PaymentStatus,
  type PaymentRecord,
} from '../src/modules/payments/payment.types';
import { OrderStatus, type Order } from '../src/modules/orders/order.types';
import type { CinetPayTransactionResponse } from '../src/modules/payments/payment.types';

// Mock axios — aucun appel HTTP réel pendant les tests
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock prisma — aucune base réelle
jest.mock('../src/config/database', () => ({
  prisma: {
    payment: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
  },
}));
const mockedPrisma = prisma as unknown as {
  payment: { create: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock };
};

// Mock le SDK FedaPay
jest.mock('fedapay', () => ({
  FedaPay: { setApiKey: jest.fn(), setEnvironment: jest.fn() },
  Transaction: { create: jest.fn(), retrieve: jest.fn() },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fedapay = require('fedapay') as {
  FedaPay: { setApiKey: jest.Mock; setEnvironment: jest.Mock };
  Transaction: { create: jest.Mock; retrieve: jest.Mock };
};

const ORDER: Order = {
  id: 'order-abc-123-def-456',
  phoneNumber: '221771234567',
  items: [{ productId: 'prod-1', quantity: 1, unitPrice: 1500 }],
  total: 1500,
  status: OrderStatus.PENDING,
  paymentMethod: 'MOBILE_MONEY' as never,
  address: 'Médina, Dakar',
  createdAt: new Date('2026-09-14T10:00:00Z'),
};

describe('createCinetPayLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.payment.create.mockResolvedValue({
      id: 'pay-1', orderId: ORDER.id, provider: 'CINETPAY',
      transactionId: 'tx-cinetpay-1', amount: 1500, currency: 'XOF', status: 'PENDING',
    } as unknown as PaymentRecord);
  });

  it('génère un lien et persiste le paiement en PENDING', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        code: '00', message: 'Success',
        data: { payment_url: 'https://cinetpay.com/checkout/test', payment_token: 'tok' },
      } as CinetPayTransactionResponse,
    });

    const result = await createCinetPayLink(ORDER);
    expect(result.paymentUrl).toBe('https://cinetpay.com/checkout/test');
    // transaction_id = 8 premiers caractères de l'id commande + uuid court
    expect(result.transactionId).toContain(`${ORDER.id.slice(0, 8)}-`);
    expect(mockedPrisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: ORDER.id, provider: 'CINETPAY', status: 'PENDING', amount: 1500 }),
      }),
    );
  });

  it('lève une erreur si la config CinetPay est incomplète', async () => {
    jest.resetModules();
    jest.doMock('../src/config/env', () => ({
      config: {
        payment: { cinetpay: { siteId: undefined, apiKey: undefined, notifyUrl: undefined, currency: 'XOF', baseUrl: '' },
          fedapay: { secretKey: undefined, publicKey: undefined, environment: 'sandbox' } },
        server: { appUrl: 'http://test.com' },
      },
    }));
    const { createCinetPayLink: createBad } = require('../src/modules/payments/payment.service');
    await expect(createBad(ORDER)).rejects.toThrow('Configuration CinetPay incomplète');
    jest.dontMock('../src/config/env');
  });
});

describe('createFedaPayLink', () => {
  beforeEach(() => jest.clearAllMocks());

  it('génère un lien FedaPay via le SDK et persiste', async () => {
    const fakeTx = { id: 'tx-fedapay-42', generateToken: jest.fn().mockResolvedValue({ token: 'fp-token-123' }) };
    fedapay.Transaction.create.mockResolvedValue(fakeTx);
    mockedPrisma.payment.create.mockResolvedValue({} as PaymentRecord);

    const result = await createFedaPayLink(ORDER);
    expect(fedapay.FedaPay.setApiKey).toHaveBeenCalledWith('test-fedapay-secret');
    expect(fedapay.Transaction.create).toHaveBeenCalledWith(expect.objectContaining({ amount: ORDER.total, currency: 'XOF' }));
    expect(result.paymentUrl).toContain('fp-token-123');
    expect(result.transactionId).toBe('tx-fedapay-42');
    expect(mockedPrisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: 'FEDAPAY' }) }),
    );
  });

  it("utilise l'URL sandbox pour l'environnement sandbox", async () => {
    fedapay.Transaction.create.mockResolvedValue({
      id: 1, generateToken: jest.fn().mockResolvedValue({ token: 't1' }),
    });
    mockedPrisma.payment.create.mockResolvedValue({} as PaymentRecord);
    const result = await createFedaPayLink(ORDER);
    expect(result.paymentUrl).toContain('sandbox.fedapay.com');
  });

  it('lève une erreur si FEDAPAY_SECRET_KEY est absent', async () => {
    jest.resetModules();
    jest.doMock('../src/config/env', () => ({
      config: {
        payment: { cinetpay: { siteId: undefined, apiKey: undefined, notifyUrl: undefined, currency: 'XOF', baseUrl: '' },
          fedapay: { secretKey: undefined, publicKey: undefined, environment: 'sandbox' } },
        server: { appUrl: 'http://test.com' },
      },
    }));
    const { createFedaPayLink: createBad } = require('../src/modules/payments/payment.service');
        await expect(createBad(ORDER)).rejects.toThrow('Configuration FedaPay incomplète');
    jest.dontMock('../src/config/env');
  });
});

describe('verifyPayment', () => {
  beforeEach(() => jest.clearAllMocks());

  it('vérifie un paiement CinetPay (ACCEPTED → true)', async () => {
    mockedAxios.post.mockResolvedValue({ data: { code: '00', data: { status: 'ACCEPTED' } } });
    const ok = await verifyPayment('tx-cp-1', PaymentProvider.CINETPAY);
    expect(ok).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/payment/check'),
      expect.objectContaining({ transaction_id: 'tx-cp-1' }),
      expect.anything(), // options axios (timeout)
    );
  });

  it('refuse un paiement CinetPay non ACCEPTED', async () => {
    mockedAxios.post.mockResolvedValue({ data: { code: '00', data: { status: 'PENDING' } } });
    const ok = await verifyPayment('tx-cp-2', PaymentProvider.CINETPAY);
    expect(ok).toBe(false);
  });

  it('vérifie un paiement FedaPay (approved → true)', async () => {
    fedapay.Transaction.retrieve.mockResolvedValue({ status: 'approved' });
    const ok = await verifyPayment('tx-fp-1', PaymentProvider.FEDAPAY);
    expect(ok).toBe(true);
  });

  it('refuse un paiement FedaPay décliné', async () => {
    fedapay.Transaction.retrieve.mockResolvedValue({ status: 'cancelled' });
    const ok = await verifyPayment('tx-fp-2', PaymentProvider.FEDAPAY);
    expect(ok).toBe(false);
  });

  it('retourne false en cas d’erreur réseau CinetPay', async () => {
    mockedAxios.post.mockRejectedValue(new Error('timeout'));
    const ok = await verifyPayment('tx-cp-bad', PaymentProvider.CINETPAY);
    expect(ok).toBe(false);
  });
});

describe('redactId', () => {
  it('renvoie les IDs courts inchangés', () => {
    expect(redactId('abc')).toBe('abc');
    expect(redactId('abcdef')).toBe('abcdef');
  });

  it('tronque les IDs longs (4 premiers + 2 derniers)', () => {
    expect(redactId('abc123456789')).toBe('abc1...89');
  });
});

describe('createPaymentRecord / updatePaymentStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('persiste un enregistrement de paiement', async () => {
    mockedPrisma.payment.create.mockResolvedValue({
      id: 'pay-99', orderId: 'order-1', provider: 'CINETPAY',
      transactionId: 'tx-99', amount: 1500, currency: 'XOF', status: 'PENDING',
    } as unknown as PaymentRecord);

    const record = await createPaymentRecord({
      orderId: 'order-1', provider: PaymentProvider.CINETPAY,
      transactionId: 'tx-99', amount: 1500, currency: 'XOF', status: PaymentStatus.PENDING,
    });
    expect(record.id).toBe('pay-99');
    expect(mockedPrisma.payment.create).toHaveBeenCalled();
  });

  it('met à jour le statut d’un paiement', async () => {
    mockedPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    await updatePaymentStatus('tx-99', PaymentStatus.SUCCESS);
    expect(mockedPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { transactionId: 'tx-99' }, data: { status: 'SUCCESS' },
    });
  });
});

