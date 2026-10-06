/**
 * Tests — DeliveryModule (flux WhatsApp côté livreur + feedback client).
 * Tous les signaux sortants (sender), la persistance (delivery/order service,
 * paiements) et la session sont mockés — la logique de routage/conversation
 * est testée sans WhatsApp ni PostgreSQL (pattern tests/payment.module.test.ts).
 */
import { DeliveryModule } from '../src/modules/delivery/delivery.module';
import * as deliveryService from '../src/modules/delivery/delivery.service';
import * as orderService from '../src/modules/orders/order.service';
import { messageSender } from '../src/shared/sender';
import { configService } from '../src/shared/config.service';
import { sessionManager, ConversationStateEnum } from '../src/shared/session';
import * as paymentService from '../src/modules/payments/payment.service';
import { DeliveryStatus, type Delivery } from '../src/modules/delivery/delivery.types';
import { OrderStatus, PaymentMethod, type Order } from '../src/modules/orders/order.types';

import { EscalationReason } from '../src/modules/agents/agent.types';

jest.mock('../src/modules/orders/order.service', () => ({
  getOrderById: jest.fn(),
  updateOrderStatus: jest.fn(),
  listOrders: jest.fn(),
}));

jest.mock('../src/shared/sender', () => ({
  messageSender: { sendText: jest.fn() },
}));

jest.mock('../src/shared/config.service', () => ({
  configService: { getConfig: jest.fn(), getNotifyPhone: jest.fn() },
}));

jest.mock('../src/shared/session', () => ({
  sessionManager: { setState: jest.fn() },
  ConversationStateEnum: {
    IDLE: 'IDLE', BROWSING_CATALOG: 'BROWSING_CATALOG', ORDERING: 'ORDERING',
    AWAITING_PAYMENT: 'AWAITING_PAYMENT', COMPLETED: 'COMPLETED', AGENT_ESCALATION: 'AGENT_ESCALATION',
    ONBOARDING_NAME: 'ONBOARDING_NAME', ONBOARDING_HOURS_OPEN: 'ONBOARDING_HOURS_OPEN',
    ONBOARDING_HOURS_CLOSE: 'ONBOARDING_HOURS_CLOSE', ONBOARDING_PAYMENT: 'ONBOARDING_PAYMENT',
    ONBOARDING_WAVE: 'ONBOARDING_WAVE', ONBOARDING_LIVREUR: 'ONBOARDING_LIVREUR',
    ONBOARDING_LIVREUR_PHONE: 'ONBOARDING_LIVREUR_PHONE',
  },
}));

jest.mock('../src/modules/agents/agent.module', () => ({
  AgentModule: jest.fn().mockImplementation(() => ({
    escalateToHuman: jest.fn(),
    handle: jest.fn(),
  })),
}));

jest.mock('../src/modules/payments/payment.service', () => ({
  createPaymentRecord: jest.fn(),
  updatePaymentStatus: jest.fn(),
  settleCODPayment: jest.fn(),
}));

jest.mock('../src/modules/delivery/delivery.service', () => ({
  listLivreurs: jest.fn(),
  normalizePhone: jest.fn((p) => String(p ?? '').replace(/[^\d]/g, '')),
  upsertAssignedDelivery: jest.fn(),
  setLivreurAvailability: jest.fn(),
  extractOrderIdReference: jest.fn(),
  findActiveDeliveryForLivreur: jest.fn(),
  updateDeliveryStatus: jest.fn(),
  findLivreurByPhone: jest.fn(),
  findDeliveryForLivreur: jest.fn(),
  incrementLivreurDeliveries: jest.fn(),
  getDeliveryById: jest.fn(),
  getDeliveryByOrderId: jest.fn(),
}));

const ds = deliveryService as jest.Mocked<typeof deliveryService>;
const os = orderService as jest.Mocked<typeof orderService>;
const sender = messageSender as jest.Mocked<typeof messageSender>;
const cfg = configService as jest.Mocked<typeof configService>;
const sm = sessionManager as jest.Mocked<typeof sessionManager>;
const ps = paymentService as jest.Mocked<typeof paymentService>;

const PHONE = '221771234567';
const CUSTOMER = '221701234567';
const MERCHANT = '221781234567';
const ORDER_ID = 'abcdef123456';
const ORDER_REF = 'abcdef12';

function makeDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'del-1',
    orderId: ORDER_ID,
    livreurId: 'liv-1',
    status: DeliveryStatus.ASSIGNED,
    livreurPhone: PHONE,
    customerPhone: CUSTOMER,
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

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    phoneNumber: CUSTOMER,
    items: [],
    total: 5000,
    status: OrderStatus.PENDING,
    paymentMethod: PaymentMethod.COD,
    address: 'Rue 12, Dakar',
    createdAt: new Date('2026-01-02'),
    ...overrides,
  };
}

function makeLivreur(overrides: Record<string, unknown> = {}) {
  return {
    id: 'liv-1',
    merchantId: 'admin',
    name: 'Moussa Diop',
    phone: PHONE,
    zone: 'Dakar',
    isActive: true,
    isAvailable: true,
    totalDeliveries: 0,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('DeliveryModule', () => {
  let module: DeliveryModule;

  beforeEach(() => {
    jest.clearAllMocks();
    module = new DeliveryModule();
  });

  // -------------------------------------------------------------------------
  // assignDelivery
  // -------------------------------------------------------------------------

  describe('assignDelivery', () => {
    it('commande introuvable → null sans message envoyé', async () => {
      os.getOrderById.mockResolvedValue(null);

      await expect(module.assignDelivery(ORDER_ID, { livreurId: 'liv-1' })).resolves.toBeNull();
      expect(ds.upsertAssignedDelivery).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
    });

    it('livreur introuvable (dashboard ou numéro) → null', async () => {
      os.getOrderById.mockResolvedValue(makeOrder());
      cfg.getConfig.mockResolvedValue({ merchantId: 'admin' } as never);
      ds.listLivreurs.mockResolvedValue([] as never);

      await expect(module.assignDelivery(ORDER_ID, { livreurId: 'inconnu' })).resolves.toBeNull();
      await expect(
        module.assignDelivery(ORDER_ID, { livreurPhone: '221700000000' }),
      ).resolves.toBeNull();
      expect(ds.upsertAssignedDelivery).not.toHaveBeenCalled();
    });

    it('assigne par livreurId : COD pour commande non payée + proposition WhatsApp', async () => {
      os.getOrderById.mockResolvedValue(makeOrder());
      cfg.getConfig.mockResolvedValue({ merchantId: 'admin' } as never);
      ds.listLivreurs.mockResolvedValue([makeLivreur()] as never);
      ds.upsertAssignedDelivery.mockResolvedValue(makeDelivery());

      const result = await module.assignDelivery(ORDER_ID, { livreurId: 'liv-1' }, {
        estimatedTime: 45,
        notes: 'Colis fragile',
      });

      expect(ds.upsertAssignedDelivery).toHaveBeenCalledWith({
        orderId: ORDER_ID,
        customerPhone: CUSTOMER,
        deliveryAddress: 'Rue 12, Dakar',
        livreurId: 'liv-1',
        livreurPhone: PHONE,
        codAmount: 5000,
        options: { estimatedTime: 45, notes: 'Colis fragile' },
      });
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Nouvelle livraison #abcdef12'));
      expect(sender.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('5 000 FCFA'),
      );
      expect(result?.id).toBe('del-1');
    });

    it('commande déjà PAID → pas de montant à collecter (codAmount null)', async () => {
      os.getOrderById.mockResolvedValue(makeOrder({ status: OrderStatus.PAID }));
      cfg.getConfig.mockResolvedValue({ merchantId: 'admin' } as never);
      ds.listLivreurs.mockResolvedValue([makeLivreur()] as never);
      ds.upsertAssignedDelivery.mockResolvedValue(makeDelivery());

      await module.assignDelivery(ORDER_ID, { livreurId: 'liv-1' });

      expect(ds.upsertAssignedDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ codAmount: null }),
      );
    });

    it('assigne par numéro WhatsApp (normalisé) quand aucun livreurId', async () => {
      os.getOrderById.mockResolvedValue(makeOrder());
      cfg.getConfig.mockResolvedValue({ merchantId: 'admin' } as never);
      ds.listLivreurs.mockResolvedValue([makeLivreur()] as never);
      ds.upsertAssignedDelivery.mockResolvedValue(makeDelivery());

      await module.assignDelivery(ORDER_ID, { livreurPhone: '+221 77 123 45 67@s.whatsapp.net' });

      expect(ds.upsertAssignedDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ livreurId: 'liv-1', livreurPhone: PHONE }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // handleLivreurResponse
  // -------------------------------------------------------------------------

  describe('handleLivreurResponse', () => {
    it('DISPO → livreur disponible + accusé de réception', async () => {
      await module.handleLivreurResponse(PHONE, ' dispo ');

      expect(ds.setLivreurAvailability).toHaveBeenCalledWith(PHONE, true);
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('disponible'));
    });

    it('DISPO avec course active → rappelle la course au livreur', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery() as never);

      await module.handleLivreurResponse(PHONE, 'dispo');

      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('disponible'));
      expect(sender.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('Course en cours'),
      );
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining(ORDER_REF));
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining(CUSTOMER));
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('À collecter'));
    });

    it('DISPO sans course active → message d\'attente', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(null);

      await module.handleLivreurResponse(PHONE, 'dispo');

      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Aucune course'));
    });

    it('AIDE → guide des commandes du livreur', async () => {
      await module.handleLivreurResponse(PHONE, 'aide');

      expect(sender.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining('Guide du livreur'),
      );
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('*LIVRÉ'));
      expect(ds.setLivreurAvailability).not.toHaveBeenCalled();
    });

    it('INDISPO / pause → livreur indisponible', async () => {
      await module.handleLivreurResponse(PHONE, 'indispo');
      expect(ds.setLivreurAvailability).toHaveBeenCalledWith(PHONE, false);

      await module.handleLivreurResponse(PHONE, 'pause');
      expect(ds.setLivreurAvailability).toHaveBeenCalledTimes(2);
    });

    it('LIVRÉ <réf> → délègue à confirmDelivery avec la référence extraite', async () => {
      ds.extractOrderIdReference.mockReturnValue(ORDER_REF);
      const spy = jest.spyOn(module, 'confirmDelivery').mockResolvedValue();

      await module.handleLivreurResponse(PHONE, `LIVRÉ ${ORDER_REF}`);

      expect(spy).toHaveBeenCalledWith(PHONE, ORDER_REF);
      expect(ds.findActiveDeliveryForLivreur).not.toHaveBeenCalled();
    });

    it('« livré » sans référence → confirmDelivery avec chaîne vide (utilise la course active)', async () => {
      ds.extractOrderIdReference.mockReturnValue(null);
      const spy = jest.spyOn(module, 'confirmDelivery').mockResolvedValue();

      await module.handleLivreurResponse(PHONE, 'livré');

      expect(spy).toHaveBeenCalledWith(PHONE, '');
    });

    it('EN ROUTE → statut intermédiaire + notifications livreur et client', async () => {
      const active = makeDelivery();
      ds.findActiveDeliveryForLivreur.mockResolvedValue(active);
      ds.updateDeliveryStatus.mockResolvedValue(active);

      await module.handleLivreurResponse(PHONE, 'en route');

      expect(ds.updateDeliveryStatus).toHaveBeenCalledWith('del-1', DeliveryStatus.EN_ROUTE);
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('en route'));
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('#abcdef12'));
    });

    it('EN ROUTE sans course active → pas de mise à jour de statut', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(null);

      await module.handleLivreurResponse(PHONE, 'en route');

      expect(ds.updateDeliveryStatus).not.toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, 'Aucune livraison en cours.');
    });

    it('OUI → PICKED_UP, commande PENDING→CONFIRMED, client prévenu', async () => {
      const active = makeDelivery();
      ds.findActiveDeliveryForLivreur.mockResolvedValue(active);
      ds.updateDeliveryStatus.mockResolvedValue(active);
      os.getOrderById.mockResolvedValue(makeOrder());
      ds.findLivreurByPhone.mockResolvedValue(makeLivreur() as never);

      await module.handleLivreurResponse(PHONE, 'oui');

      expect(ds.updateDeliveryStatus).toHaveBeenCalledWith('del-1', DeliveryStatus.PICKED_UP);
      expect(os.updateOrderStatus).toHaveBeenCalledWith(ORDER_ID, OrderStatus.CONFIRMED);
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('en route'));
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Course acceptée'));
    });

    it('OUI avec commande déjà CONFIRMED → ne re-confirme pas la commande', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery());
      os.getOrderById.mockResolvedValue(makeOrder({ status: OrderStatus.CONFIRMED }));
      ds.findLivreurByPhone.mockResolvedValue(null);

      await module.handleLivreurResponse(PHONE, 'ok');

      expect(os.updateOrderStatus).not.toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('Votre livreur'));
    });

    it('NON → FAILED « Refusée par le livreur » + alerte commerçant', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery());
      ds.findLivreurByPhone.mockResolvedValue(makeLivreur() as never);
      cfg.getNotifyPhone.mockResolvedValue(MERCHANT);

      await module.handleLivreurResponse(PHONE, 'non');

      expect(ds.updateDeliveryStatus).toHaveBeenCalledWith('del-1', DeliveryStatus.FAILED, {
        failureReason: 'Refusée par le livreur',
      });
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('refusée'));
      expect(sender.sendText).toHaveBeenCalledWith(MERCHANT, expect.stringContaining('a refusé la commande'));
    });

    it('NON sans numéro commerçant → le commerçant n est pas notifié', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery());
      ds.findLivreurByPhone.mockResolvedValue(makeLivreur() as never);
      cfg.getNotifyPhone.mockResolvedValue(null);

      await module.handleLivreurResponse(PHONE, 'non');

      expect(sender.sendText).toHaveBeenCalledTimes(1); // uniquement le livreur
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('refusée'));
    });

    it('NON avec notifyMerchantOrders=false → alerte commerçant maintenue (course bloquée)', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery());
      ds.findLivreurByPhone.mockResolvedValue(makeLivreur() as never);
      cfg.getNotifyPhone.mockResolvedValue(MERCHANT);
      cfg.getConfig.mockResolvedValue({
        merchantId: 'admin',
        notifyMerchantOrders: false,
      } as never);

      await module.handleLivreurResponse(PHONE, 'non');

      // Exception volontaire : sans alerte, la course resterait bloquée en
      // silence (il faut une réassignation manuelle depuis le dashboard).
      expect(sender.sendText).toHaveBeenCalledWith(MERCHANT, expect.stringContaining('a refusé la commande'));

      // clearMocks ne réinitialise PAS les implémentations : on remet l'état
      // « notifications activées » attendu par les tests suivants.
      cfg.getConfig.mockResolvedValue({ merchantId: 'admin' } as never);
    });

    it('message non reconnu avec course en attente → rappel des commandes', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery());

      await module.handleLivreurResponse(PHONE, 'blabla');

      expect(sender.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining(`LIVRÉ ${ORDER_REF}`),
      );
    });

    it('OUI sans aucune course en attente → message « aucune livraison en attente »', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(null);

      await module.handleLivreurResponse(PHONE, 'oui');

      expect(ds.updateDeliveryStatus).not.toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Aucune livraison en attente'));
    });
  });

  // -------------------------------------------------------------------------
  // confirmDelivery
  // -------------------------------------------------------------------------

  describe('confirmDelivery', () => {
    it('référence vide → demande la commande (active ou exemple)', async () => {
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery());

      await module.confirmDelivery(PHONE, '   ');

      expect(sender.sendText).toHaveBeenCalledWith(
        PHONE,
        expect.stringContaining(`LIVRÉ ${ORDER_REF}`),
      );
      expect(ds.findDeliveryForLivreur).not.toHaveBeenCalled();
    });

    it('référence introuvable (ni directe ni active) → « introuvable pour vous »', async () => {
      ds.findDeliveryForLivreur.mockResolvedValue(null);
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery({ orderId: 'fedcba987654' }));

      await module.confirmDelivery(PHONE, 'zzzz9999');

      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('introuvable pour vous'));
      expect(ds.updateDeliveryStatus).not.toHaveBeenCalled();
    });

    it('résout une référence courte via la course active du livreur', async () => {
      ds.findDeliveryForLivreur.mockResolvedValue(null);
      ds.findActiveDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery({ status: DeliveryStatus.DELIVERED }));
      os.getOrderById.mockResolvedValue(makeOrder());
      cfg.getNotifyPhone.mockResolvedValue(MERCHANT);

      await module.confirmDelivery(PHONE, ORDER_REF);

      expect(ds.updateDeliveryStatus).toHaveBeenCalledWith(
        'del-1',
        DeliveryStatus.DELIVERED,
        expect.objectContaining({ deliveredAt: expect.any(Date), codCollected: true }),
      );
    });

    it('livraison déjà DELIVERED → réponse idempotente, aucune re-mise à jour', async () => {
      ds.findDeliveryForLivreur.mockResolvedValue(makeDelivery({ status: DeliveryStatus.DELIVERED }));

      await module.confirmDelivery(PHONE, ORDER_REF);

      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('déjà enregistrée'));
      expect(ds.updateDeliveryStatus).not.toHaveBeenCalled();
    });

    it('flux COD complet : DELIVERED + paiement DIRECT SUCCESS + commande PAID + compteur', async () => {
      ds.findDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery({ status: DeliveryStatus.DELIVERED }));
      os.getOrderById.mockResolvedValue(makeOrder());
      ps.settleCODPayment.mockResolvedValue(undefined);
      cfg.getNotifyPhone.mockResolvedValue(MERCHANT);

      await module.confirmDelivery(PHONE, ORDER_REF);

      expect(ds.updateDeliveryStatus).toHaveBeenCalledWith(
        'del-1',
        DeliveryStatus.DELIVERED,
        expect.objectContaining({ codCollected: true }),
      );
      expect(ps.settleCODPayment).toHaveBeenCalledWith('del-1', ORDER_ID, 5000);
      expect(ds.incrementLivreurDeliveries).toHaveBeenCalledWith('liv-1');
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('Commande livrée'));
      expect(sender.sendText).toHaveBeenCalledWith(MERCHANT, expect.stringContaining('5 000 FCFA'));
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('enregistrée'));
    });

    it('notifyMerchantOrders=false → commerçant non notifié (livraison enregistrée quand même)', async () => {
      ds.findDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery({ status: DeliveryStatus.DELIVERED }));
      os.getOrderById.mockResolvedValue(makeOrder());
      ps.settleCODPayment.mockResolvedValue(undefined);
      cfg.getNotifyPhone.mockResolvedValue(MERCHANT);
      // ...Once : consommé par le seul appel de ce flux, sans fuite vers les
      // tests suivants (clearMocks ne réinitialise pas les implémentations).
      cfg.getConfig.mockResolvedValueOnce({
        merchantId: 'admin',
        notifyMerchantOrders: false,
      } as never);

      await module.confirmDelivery(PHONE, ORDER_REF);

      // Le flux métier va au bout : paiement COD + client prévenu + livreur remercié
      expect(ps.settleCODPayment).toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('Commande livrée'));
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('enregistrée'));
      // ...mais le commerçant n'est pas notifié
      expect(sender.sendText).not.toHaveBeenCalledWith(MERCHANT, expect.anything());
    });

    it('sans COD (livré contre rien) : aucun enregistrement de paiement', async () => {
      ds.findDeliveryForLivreur.mockResolvedValue(
        makeDelivery({ codAmount: null, livreurId: null }),
      );
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery({ status: DeliveryStatus.DELIVERED }));
      os.getOrderById.mockResolvedValue(makeOrder());
      cfg.getNotifyPhone.mockResolvedValue(MERCHANT);

      await module.confirmDelivery(PHONE, ORDER_REF);

      expect(ps.settleCODPayment).not.toHaveBeenCalled();
      expect(ds.incrementLivreurDeliveries).not.toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('enregistrée'));
    });

    it('rejeu du message : paiement déjà enregistré → resynchronise le statut SUCCESS', async () => {
      ds.findDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery({ status: DeliveryStatus.DELIVERED }));
      os.getOrderById.mockResolvedValue(makeOrder());
      ps.settleCODPayment.mockResolvedValue(undefined);
      cfg.getNotifyPhone.mockResolvedValue(MERCHANT);

      await module.confirmDelivery(PHONE, ORDER_REF);

      expect(ps.settleCODPayment).toHaveBeenCalledWith('del-1', ORDER_ID, 5000);
    });

    it('aucun numéro commerçant configuré → le commerçant n est pas notifié (livreur/client si)', async () => {
      ds.findDeliveryForLivreur.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery({ status: DeliveryStatus.DELIVERED }));
      os.getOrderById.mockResolvedValue(makeOrder());
      ps.settleCODPayment.mockResolvedValue(undefined);
      cfg.getNotifyPhone.mockResolvedValue(null);

      await module.confirmDelivery(PHONE, ORDER_REF);

      const merchantMessages = sender.sendText.mock.calls.filter(([to]) => to === MERCHANT);
      expect(merchantMessages).toHaveLength(0);
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('Commande livrée'));
      expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('enregistrée'));
    });
  });

  // -------------------------------------------------------------------------
  // handleCustomerDeliveryFeedback
  // -------------------------------------------------------------------------

  describe('handleCustomerDeliveryFeedback', () => {
    it('REÇU → remercie le client + session IDLE + message consommé', async () => {
      os.listOrders.mockResolvedValue({ orders: [makeOrder()] } as never);
      ds.getDeliveryByOrderId.mockResolvedValue(makeDelivery());

      const consumed = await module.handleCustomerDeliveryFeedback(CUSTOMER, 'reçu');

      expect(consumed).toBe(true);
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('Merci'));
      expect(sm.setState).toHaveBeenCalledWith(CUSTOMER, ConversationStateEnum.IDLE);
      expect(os.listOrders).toHaveBeenCalledWith({ phoneNumber: CUSTOMER, limit: 1 });
    });

    it('PROBLÈME → escalade vers un agent humain (raison COMPLAINT)', async () => {
      const agent = (module as unknown as { agent: { escalateToHuman: jest.Mock } }).agent;

      const consumed = await module.handleCustomerDeliveryFeedback(CUSTOMER, 'probleme');

      expect(consumed).toBe(true);
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('agent'));
      expect(agent.escalateToHuman).toHaveBeenCalledWith(CUSTOMER, EscalationReason.COMPLAINT);
    });

    it('message hors feedback → consommé = false, rien envoyé', async () => {
      const consumed = await module.handleCustomerDeliveryFeedback(CUSTOMER, 'catalogue');

      expect(consumed).toBe(false);
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(sm.setState).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // updateStatusFromDashboard
  // -------------------------------------------------------------------------

  describe('updateStatusFromDashboard', () => {
    it('livraison introuvable → null', async () => {
      ds.getDeliveryById.mockResolvedValue(null);
      await expect(module.updateStatusFromDashboard('nope', DeliveryStatus.DELIVERED)).resolves.toBeNull();
    });

    it('DELIVERED → délègue au flux complet confirmDelivery', async () => {
      ds.getDeliveryById.mockResolvedValueOnce(makeDelivery())
        .mockResolvedValueOnce(makeDelivery({ status: DeliveryStatus.DELIVERED }));
      const spy = jest.spyOn(module, 'confirmDelivery').mockResolvedValue();

      const result = await module.updateStatusFromDashboard('del-1', DeliveryStatus.DELIVERED);

      expect(spy).toHaveBeenCalledWith(PHONE, ORDER_ID);
      expect(result?.status).toBe(DeliveryStatus.DELIVERED);
      expect(ds.updateDeliveryStatus).not.toHaveBeenCalled();
    });

    it('FAILED → raison dashboard + notification client et commerçant', async () => {
      ds.getDeliveryById.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery({ status: DeliveryStatus.FAILED }));
      cfg.getNotifyPhone.mockResolvedValue(MERCHANT);

      await module.updateStatusFromDashboard('del-1', DeliveryStatus.FAILED);

      expect(ds.updateDeliveryStatus).toHaveBeenCalledWith('del-1', DeliveryStatus.FAILED, {
        failureReason: 'Échec signalé depuis le dashboard',
      });
      expect(sender.sendText).toHaveBeenCalledWith(CUSTOMER, expect.stringContaining('❌ Échec'));
      expect(sender.sendText).toHaveBeenCalledWith(MERCHANT, expect.stringContaining('en échec'));
    });

    it('PENDING (état purement interne) → aucune notification client', async () => {
      ds.getDeliveryById.mockResolvedValue(makeDelivery());
      ds.updateDeliveryStatus.mockResolvedValue(makeDelivery({ status: DeliveryStatus.PENDING }));

      await module.updateStatusFromDashboard('del-1', DeliveryStatus.PENDING);

      expect(ds.updateDeliveryStatus).toHaveBeenCalledWith('del-1', DeliveryStatus.PENDING, {});
      expect(sender.sendText).not.toHaveBeenCalled();
    });
  });
});