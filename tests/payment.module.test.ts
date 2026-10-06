/**
 * Tests — PaymentModule (routage conversationnel AWAITING_PAYMENT + webhook).
 * Moke le service paiement, order.service, sender, session, prisma.
 */
import { PaymentModule } from '../src/modules/payments/payment.module';
import * as paymentService from '../src/modules/payments/payment.service';
import * as orderService from '../src/modules/orders/order.service';
import { messageSender } from '../src/shared/sender';
import { sessionManager, ConversationStateEnum } from '../src/shared/session';
import { PaymentProvider, PaymentStatus, type CinetPayWebhook, type FedaPayWebhook } from '../src/modules/payments/payment.types';
import { OrderStatus, type Order } from '../src/modules/orders/order.types';

jest.mock('../src/modules/payments/payment.service', () => ({
  createCinetPayLink: jest.fn(), createFedaPayLink: jest.fn(),
  createPawaPayDeposit: jest.fn(),
  // false → le code replique sur CinetPay/FedaPay (ne tente pas PawaPay → évite TypeError)
  isPawaPayEnabled: jest.fn(() => false),
  verifyPayment: jest.fn(), updatePaymentStatus: jest.fn(),
  redactId: jest.fn((id: string) => id),
}));
jest.mock('../src/modules/orders/order.service', () => ({
  getOrderById: jest.fn(), updateOrderStatus: jest.fn(),
}));
jest.mock('../src/shared/sender', () => ({
  messageSender: { sendText: jest.fn() },
}));
jest.mock('../src/shared/session', () => ({
  sessionManager: { setState: jest.fn(), updateSession: jest.fn(), resetUnknownCount: jest.fn(), getSession: jest.fn().mockResolvedValue({ currentOrderId: undefined }) },
    ConversationStateEnum: {
    IDLE: 'IDLE', BROWSING_CATALOG: 'BROWSING_CATALOG', ORDERING: 'ORDERING',
    AWAITING_PAYMENT: 'AWAITING_PAYMENT', COMPLETED: 'COMPLETED', AGENT_ESCALATION: 'AGENT_ESCALATION',
  },
}));
jest.mock('../src/config/database', () => ({
  prisma: { payment: { findUnique: jest.fn() } },
}));

// Un fournisseur de paiement DISPONIBLE est requis pour que initiatePayment
// choisisse un lien — on injecte un CinetPay factice dans le test pour que le
// mock payment.service soit invoqué (était le cas en prod avec CinetPay+).
jest.mock('../src/config/env', () => ({
  config: {
    payment: {
      cinetpay: {
        siteId: 's1',
        apiKey: 'k',
        notifyUrl: 'https://x',
        currency: 'XOF',
        baseUrl: 'https://api.cinetpay.com/v2',
      },
      fedapay: { secretKey: undefined, publicKey: undefined, environment: 'sandbox' },
      direct: { waveNumber: '', orangeNumber: '', moovNumber: '' },
      pawapay: { apiToken: undefined, environment: 'sandbox', baseUrl: '' },
    },
    merchant: {
      id: 'admin',
      name: 'Test',
      phone: undefined,
      timezone: 'Africa/Dakar',
      openHour: undefined,
      closeHour: undefined,
    },
    server: { jwtSecret: 's', appUrl: 'https://t' },
    evolution: { instanceName: 'inst', waBusinessTokenWebhook: 't' },
    redis: { url: 'redis://127.0.0.1:6379' },
  },
}));

const ps = paymentService as jest.Mocked<typeof paymentService>;
const os = orderService as jest.Mocked<typeof orderService>;
const sender = messageSender as jest.Mocked<typeof messageSender>;
const sm = sessionManager as jest.Mocked<typeof sessionManager>;
const { prisma } = require('../src/config/database');

const PHONE = '221771234567';

function makeSession(overrides: Record<string, unknown> = {}) {
  return { phoneNumber: PHONE, state: ConversationStateEnum.AWAITING_PAYMENT,
    lastActivity: Date.now(), ...overrides };
}

describe('PaymentModule.handle — routage AWAITING_PAYMENT', () => {
  let module: PaymentModule;
  beforeEach(() => { jest.clearAllMocks(); module = new PaymentModule(); });

  it('relance le paiement sur "relancer"', async () => {
    os.getOrderById.mockResolvedValue({ id: 'ord-1', total: 1500, phoneNumber: PHONE } as unknown as Order);
    ps.createCinetPayLink.mockResolvedValue({ paymentUrl: 'https://pay.example', transactionId: 'tx-1' });
    await module.handle(PHONE, 'relancer', makeSession({ currentOrderId: 'ord-1' }) as never);
    expect(ps.createCinetPayLink).toHaveBeenCalled();
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('https://pay.example'));
  });

  it('annule la commande + retour IDLE sur "annuler"', async () => {
    await module.handle(PHONE, 'annuler', makeSession({ currentOrderId: 'ord-1' }) as never);
    expect(os.updateOrderStatus).toHaveBeenCalledWith('ord-1', OrderStatus.CANCELLED);
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('annulé'));
  });

  it('affiche l’aide sur message non reconnu', async () => {
    await module.handle(PHONE, 'blabla', makeSession({ currentOrderId: 'ord-1' }) as never);
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('« relancer »'));
    expect(ps.createCinetPayLink).not.toHaveBeenCalled();
  });

  it('propose de recommencer si pas de commande en cours', async () => {
    os.getOrderById.mockResolvedValue(null);
    await module.handle(PHONE, 'relancer', makeSession({ currentOrderId: '' }) as never);
        expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Session expirée'));
  });
});

describe('PaymentModule.handleWebhook', () => {
  let module: PaymentModule;
  beforeEach(() => { jest.clearAllMocks(); module = new PaymentModule(); });

  it('ignore un payload dont le fournisseur est introuvable', async () => {
    await module.handleWebhook({ unexpected: 'data' } as never);
    expect(ps.verifyPayment).not.toHaveBeenCalled();
  });

  it('traite un webhook CinetPay ACCEPTED : vérifie → met à jour → envoie reçu', async () => {
    const payload: CinetPayWebhook = {
      cpm_trans_id: 'tx-cp-1', cpm_site_id: 's1', cpm_trans_status: 'ACCEPTED',
      cpm_amount: '1500', cpm_currency: 'XOF', cpm_payment_method: 'moov',
    };
    ps.verifyPayment.mockResolvedValue(true);
    ps.updatePaymentStatus.mockResolvedValue();
    prisma.payment.findUnique.mockResolvedValue({ orderId: 'ord-1', status: 'PENDING', amount: 1500 });
    os.updateOrderStatus.mockResolvedValue();
    os.getOrderById.mockResolvedValue({ id: 'ord-1', total: 1500, phoneNumber: PHONE } as unknown as Order);

    await module.handleWebhook(payload);

    expect(ps.verifyPayment).toHaveBeenCalledWith('tx-cp-1', PaymentProvider.CINETPAY);
    expect(ps.updatePaymentStatus).toHaveBeenCalledWith('tx-cp-1', PaymentStatus.SUCCESS);
    expect(os.updateOrderStatus).toHaveBeenCalledWith('ord-1', OrderStatus.PAID);
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Paiement confirmé'));
    expect(sm.setState).toHaveBeenCalledWith(PHONE, ConversationStateEnum.COMPLETED);
  });

  it('n’applique PAS le webhook si la vérification échoue (anti-fraude)', async () => {
    const payload: CinetPayWebhook = {
      cpm_trans_id: 'tx-cp-fake', cpm_site_id: 's1', cpm_trans_status: 'ACCEPTED',
      cpm_amount: '1500', cpm_currency: 'XOF', cpm_payment_method: 'moov',
    };
    ps.verifyPayment.mockResolvedValue(false);
    await module.handleWebhook(payload);
    expect(ps.updatePaymentStatus).not.toHaveBeenCalled();
    expect(os.updateOrderStatus).not.toHaveBeenCalled();
  });

  it('traite un webhook FedaPay approved', async () => {
    const payload: FedaPayWebhook = {
      id: 'evt-1', name: 'Transaction approved', event: 'transaction.approved',
      data: { id: 42, status: 'approved', amount: 1500, currency: { iso: 'XOF' } },
    };
    ps.verifyPayment.mockResolvedValue(true);
    ps.updatePaymentStatus.mockResolvedValue();
    prisma.payment.findUnique.mockResolvedValue({ orderId: 'ord-1', status: 'PENDING', amount: 1500 });
    os.updateOrderStatus.mockResolvedValue();
    os.getOrderById.mockResolvedValue({ id: 'ord-1', total: 1500, phoneNumber: PHONE } as unknown as Order);

    await module.handleWebhook(payload);
    expect(ps.verifyPayment).toHaveBeenCalledWith('42', PaymentProvider.FEDAPAY);
    expect(os.updateOrderStatus).toHaveBeenCalledWith('ord-1', OrderStatus.PAID);
  });

  it('ignore un statut webhook non final (PENDING) — verifyPayment échoue', async () => {
    const payload: CinetPayWebhook = {
      cpm_trans_id: 'tx-cp-pending', cpm_site_id: 's1', cpm_trans_status: 'PENDING',
      cpm_amount: '1500', cpm_currency: 'XOF', cpm_payment_method: 'moov',
    };
    ps.verifyPayment.mockResolvedValue(false);
    await module.handleWebhook(payload);
    expect(ps.updatePaymentStatus).not.toHaveBeenCalled();
  });

  it('ignore une seconde livraison (déjà SUCCESS) — ne re-send pas le reçu', async () => {
    const payload: CinetPayWebhook = {
      cpm_trans_id: 'tx-cp-dup', cpm_site_id: 's1', cpm_trans_status: 'ACCEPTED',
      cpm_amount: '1500', cpm_currency: 'XOF', cpm_payment_method: 'moov',
    };
    ps.verifyPayment.mockResolvedValue(true);
    prisma.payment.findUnique.mockResolvedValue({ orderId: 'ord-1', status: 'SUCCESS', amount: 1500 });

    await module.handleWebhook(payload);
    expect(ps.updatePaymentStatus).not.toHaveBeenCalled();
    expect(os.updateOrderStatus).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('ignore un webhook dont le montant ne correspond pas au paiement stocké', async () => {
    const payload: CinetPayWebhook = {
      cpm_trans_id: 'tx-cp-wrong-amount', cpm_site_id: 's1', cpm_trans_status: 'ACCEPTED',
      cpm_amount: '9999', cpm_currency: 'XOF', cpm_payment_method: 'moov',
    };
    ps.verifyPayment.mockResolvedValue(true);
    prisma.payment.findUnique.mockResolvedValue({ orderId: 'ord-1', status: 'PENDING', amount: 1500 });

    await module.handleWebhook(payload);
    expect(ps.updatePaymentStatus).not.toHaveBeenCalled();
    expect(os.updateOrderStatus).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });
});
