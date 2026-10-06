/**
 * Tests — ConversationRouter (machine à états).
 *
 * Couvre : détection d'intention IDLE, mots-clés globaux (menu/aide/annuler),
 * escalade après 3 messages non compris, délégation par état (catalogue,
 * commande, paiement, agent), pass-through livreur, interception onboarding,
 * validation manuelle commerçant, horaires fermés.
 *
 * Stratégie de moquage (conforme aux conventions du repo) :
 *  - mocks lourds globaux : session, sender, config.service, businessHours,
 *    delivery.module, delivery.service, guided.onboarding, config/env, database ;
 *  - injection par constructeur pour catalog/order/payment/agent (les instances
 *    factices remplacent les modules réels : aucun appel Redis/Prisma/HTTP).
 */
import { ConversationRouter } from '../src/shared/conversation.router';
import { sessionManager, ConversationStateEnum, type ConversationState } from '../src/shared/session';
import { messageSender } from '../src/shared/sender';
import { configService } from '../src/shared/config.service';
import { isShopOpen } from '../src/shared/businessHours';
import { deliveryModule } from '../src/modules/delivery/delivery.module';
import { isRegisteredLivreur } from '../src/modules/delivery/delivery.service';
import * as guidedOnboarding from '../src/modules/onboarding/guided.onboarding';
import { EscalationReason } from '../src/modules/agents/agent.types';

jest.mock('../src/config/env', () => ({
  config: {
    server: {
      nodeEnv: 'test',
      isProduction: false,
      port: 3001,
      appUrl: 'https://afribot.test',
      logLevel: 'error',
      jwtSecret: 'test-secret-32-caracteres-minimum-ok-1234',
      jwtExpiresIn: '1h',
      dashboardAdminEmail: 'admin@afribot.test',
      dashboardAdminPassword: 'motdepassefort123',
    },
    database: { url: 'postgresql://afribot:test@localhost:5432/afribot_test' },
    redis: {
      url: 'redis://:test-password@localhost:6379/0',
      password: 'test-password',
      prefix: 'afribot:',
      sessionTtl: 1800,
    },
    evolution: {
      apiUrl: 'http://localhost:8080',
      apiKey: 'test-evolution-key',
      instanceName: 'afribot-test',
      integration: 'WHATSAPP-BUSINESS',
      waBusinessTokenWebhook: 'test-webhook-token',
      waBusinessUrl: 'https://graph.facebook.com',
      waBusinessVersion: 'v20.0',
    },
    payment: {
      cinetpay: {
        siteId: 'test-site-id',
        apiKey: 'test-api-key',
        notifyUrl: 'http://localhost:3000/webhook/payment',
        currency: 'XOF',
        baseUrl: 'https://api-checkout.cinetpay.com/v2',
      },
      fedapay: { secretKey: undefined, publicKey: undefined, environment: 'sandbox' },
      direct: { waveNumber: undefined, orangeNumber: undefined, moovNumber: undefined },
      pawapay: { apiToken: undefined, environment: 'sandbox', baseUrl: '' },
    },
    chatwoot: { url: undefined, apiKey: undefined, inboxId: undefined, accountId: undefined },
    merchant: { id: 'admin', name: 'Test', phone: undefined, timezone: 'Africa/Dakar', openHour: 9, closeHour: 18 },
    n8n: { url: undefined, apiKey: undefined, encryptionKey: undefined },
    speech: { digiDays: { token: undefined }, smigo: { endpoint: undefined, token: undefined } },
  },
}));
jest.mock('../src/config/database', () => ({ prisma: {} }));
jest.mock('../src/shared/session', () => ({
  ConversationStateEnum: {
    IDLE: 'IDLE',
    BROWSING_CATALOG: 'BROWSING_CATALOG',
    ORDERING: 'ORDERING',
    AWAITING_PAYMENT: 'AWAITING_PAYMENT',
    COMPLETED: 'COMPLETED',
    AGENT_ESCALATION: 'AGENT_ESCALATION',
    ONBOARDING_NAME: 'ONBOARDING_NAME',
    ONBOARDING_HOURS_OPEN: 'ONBOARDING_HOURS_OPEN',
    ONBOARDING_HOURS_CLOSE: 'ONBOARDING_HOURS_CLOSE',
    ONBOARDING_PAYMENT: 'ONBOARDING_PAYMENT',
    ONBOARDING_WAVE: 'ONBOARDING_WAVE',
    ONBOARDING_LIVREUR: 'ONBOARDING_LIVREUR',
    ONBOARDING_LIVREUR_PHONE: 'ONBOARDING_LIVREUR_PHONE',
  },
  sessionManager: {
    getSession: jest.fn(),
    setState: jest.fn(),
    updateSession: jest.fn(),
    resetUnknownCount: jest.fn(),
    incrementUnknownCount: jest.fn(),
    deleteSession: jest.fn(),
  },
}));
jest.mock('../src/shared/sender', () => ({
  messageSender: {
    sendText: jest.fn(),
    sendList: jest.fn(),
    sendImage: jest.fn(),
    sendButtons: jest.fn(),
    sendTextTemplate: jest.fn(),
  },
}));
jest.mock('../src/shared/config.service', () => ({
  configService: { getNotifyPhone: jest.fn(), getConfig: jest.fn() },
}));
jest.mock('../src/shared/businessHours', () => ({
  isShopOpen: jest.fn().mockReturnValue(true),
}));
jest.mock('../src/modules/delivery/delivery.module', () => ({
  deliveryModule: {
    handleLivreurResponse: jest.fn(),
    handleCustomerDeliveryFeedback: jest.fn(),
  },
}));
jest.mock('../src/modules/delivery/delivery.service', () => ({
  isRegisteredLivreur: jest.fn(),
}));
jest.mock('../src/modules/onboarding/guided.onboarding', () => ({
  handle: jest.fn(),
  isOnboardingState: jest.fn().mockReturnValue(false),
}));

const PHONE = '221771234567';

const sm = sessionManager as jest.Mocked<typeof sessionManager>;
const sender = messageSender as jest.Mocked<typeof messageSender>;
const configSvc = configService as jest.Mocked<typeof configService>;
const shopOpen = isShopOpen as jest.MockedFn<typeof isShopOpen>;
const gui = guidedOnboarding as jest.Mocked<typeof guidedOnboarding>;
const dlv = deliveryModule as jest.Mocked<typeof deliveryModule>;
const isLivreurSvc = isRegisteredLivreur as jest.MockedFn<typeof isRegisteredLivreur>;

// Instances factices injectées par le constructeur (aucun module réel construit)
const catalog = { handle: jest.fn().mockResolvedValue(undefined) };
const order = { handle: jest.fn().mockResolvedValue(undefined) };
const payment = {
  handle: jest.fn().mockResolvedValue(undefined),
  handleMerchantValidation: jest.fn().mockResolvedValue(true),
};
const agent = {
  handle: jest.fn().mockResolvedValue(undefined),
  escalateToHuman: jest.fn().mockResolvedValue(undefined),
};

function makeSession(overrides: Partial<ConversationState> = {}): ConversationState {
  return { phoneNumber: PHONE, state: ConversationStateEnum.IDLE, lastActivity: Date.now(), ...overrides };
}

describe('ConversationRouter', () => {
  let router: ConversationRouter;

  beforeEach(() => {
    jest.clearAllMocks();
    router = new ConversationRouter(catalog as never, order as never, payment as never, agent as never);
    sm.getSession.mockResolvedValue(makeSession());
    sm.setState.mockResolvedValue();
    sm.updateSession.mockResolvedValue();
    sm.resetUnknownCount.mockResolvedValue();
    sm.incrementUnknownCount.mockResolvedValue(1);
    configSvc.getNotifyPhone.mockResolvedValue(null);
    configSvc.getConfig.mockResolvedValue({
      merchantId: 'admin',
      businessName: 'Test',
      businessDescription: null,
      logoUrl: null,
      openHour: 9,
      closeHour: 18,
      timezone: 'Africa/Dakar',
      closedDays: [],
      welcomeMessage: null,
      closedMessage: null,
      thankYouMessage: null,
      paymentMode: 'COD',
      waveNumber: null,
      orangeNumber: null,
      moovNumber: null,
      pawaPayToken: null,
      deliveryEnabled: false,
      deliveryZones: [],
      deliveryFee: 0,
      codEnabled: true,
      defaultLanguage: 'fr',
      supportedLanguages: ['fr'],
      notifyMerchantOrders: true,
      merchantNotifPhone: null,
      waPhoneNumberId: null,
      waAccessToken: null,
      isConfigured: false,
    });
    shopOpen.mockReturnValue(true);
    dlv.handleCustomerDeliveryFeedback.mockResolvedValue(false);
    isLivreurSvc.mockResolvedValue(false);
    gui.isOnboardingState.mockReturnValue(false);
  });

  // -------------------------------------------------------------------------
  // État IDLE — détection d'intention
  // -------------------------------------------------------------------------

  it('aiguille « Catalogue ? » (normalisé) vers le module catalogue', async () => {
    await expect(router.route(PHONE, '  Catalogue ? ', 'text')).resolves.toBeUndefined();
    expect(sm.setState).toHaveBeenCalledWith(PHONE, ConversationStateEnum.BROWSING_CATALOG);
    expect(sm.resetUnknownCount).toHaveBeenCalledWith(PHONE);
    expect(catalog.handle).toHaveBeenCalledWith(PHONE, 'catalogue ');
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('« bonjour » à l’état IDLE → menu principal (mot-clé de retour accueil)', async () => {
    await router.route(PHONE, 'bonjour', 'text');
    expect(sm.setState).toHaveBeenCalledWith(PHONE, ConversationStateEnum.IDLE);
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Bienvenue chez notre boutique'));
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('« catalogue »'));
    expect(catalog.handle).not.toHaveBeenCalled();
  });

  it('« aide » → escalade demandée par l’utilisateur (sans menu)', async () => {
    await router.route(PHONE, 'aide', 'text');
    expect(agent.escalateToHuman).toHaveBeenCalledWith(PHONE, EscalationReason.USER_REQUEST);
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('« commander » → intention ORDER : message de guidance, pas de changement d’état', async () => {
    await router.route(PHONE, 'commander', 'text');
    expect(sender.sendText).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining('Pour commander, tapez d’abord « catalogue »'),
    );
    expect(sm.resetUnknownCount).toHaveBeenCalledWith(PHONE);
    expect(sm.setState).not.toHaveBeenCalled();
    expect(catalog.handle).not.toHaveBeenCalled();
  });

  it('« payer » → intention PAYMENT : message de guidance', async () => {
    await router.route(PHONE, 'payer', 'text');
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Pour commander'));
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('« catalogue »'));
  });

  it('message inconnu → menu d’accueil + compteur de blocage (1), pas d’escalade', async () => {
    sm.incrementUnknownCount.mockResolvedValue(1);
    await router.route(PHONE, 'xyz', 'text');
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Bienvenue chez notre boutique'));
    expect(sm.incrementUnknownCount).toHaveBeenCalledWith(PHONE);
    expect(agent.escalateToHuman).not.toHaveBeenCalled();
  });

  it('3 messages non compris consécutifs → escalade automatique vers un humain (BOT_STUCK)', async () => {
    let count = 0;
    sm.incrementUnknownCount.mockImplementation(async () => ++count);
    for (const text of ['xyz', 'gloub', 'foobar']) {
      await router.route(PHONE, text, 'text');
    }
    expect(sm.incrementUnknownCount).toHaveBeenCalledTimes(3);
    expect(sender.sendText).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining('Je vous transfère à un agent humain'),
    );
    expect(agent.escalateToHuman).toHaveBeenCalledWith(PHONE, EscalationReason.BOT_STUCK);
  });

  it('feedback de livraison « reçu » consommé silencieusement (pas de menu ni compteur)', async () => {
    dlv.handleCustomerDeliveryFeedback.mockResolvedValue(true);
    await router.route(PHONE, 'reçu', 'text');
    expect(dlv.handleCustomerDeliveryFeedback).toHaveBeenCalledWith(PHONE, 'reçu');
    expect(sm.resetUnknownCount).toHaveBeenCalledWith(PHONE);
    expect(sm.incrementUnknownCount).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Délégation par état courant (hors IDLE)
  // -------------------------------------------------------------------------

  it('BROWSING_CATALOG → délègue au module catalogue', async () => {
    sm.getSession.mockResolvedValue(makeSession({ state: ConversationStateEnum.BROWSING_CATALOG }));
    await router.route(PHONE, 'suivant', 'text');
    expect(sm.resetUnknownCount).toHaveBeenCalledWith(PHONE);
    expect(catalog.handle).toHaveBeenCalledWith(PHONE, 'suivant');
    expect(order.handle).not.toHaveBeenCalled();
  });

  it('ORDERING → délègue au module commandes avec la session', async () => {
    sm.getSession.mockResolvedValue(makeSession({ state: ConversationStateEnum.ORDERING, orderFlow: 'SELECT_QUANTITY' }));
    await router.route(PHONE, '3', 'text');
    expect(order.handle).toHaveBeenCalledWith(
      PHONE,
      '3',
      expect.objectContaining({ state: ConversationStateEnum.ORDERING, orderFlow: 'SELECT_QUANTITY' }),
    );
    expect(catalog.handle).not.toHaveBeenCalled();
  });

  it('AWAITING_PAYMENT → délègue au module paiement avec la session', async () => {
    sm.getSession.mockResolvedValue(makeSession({ state: ConversationStateEnum.AWAITING_PAYMENT, currentOrderId: 'ord-1' }));
    await router.route(PHONE, 'relancer', 'text');
    expect(payment.handle).toHaveBeenCalledWith(
      PHONE,
      'relancer',
      expect.objectContaining({ state: ConversationStateEnum.AWAITING_PAYMENT, currentOrderId: 'ord-1' }),
    );
  });

  it('COMPLETED → remerciement puis retour IDLE', async () => {
    sm.getSession.mockResolvedValue(makeSession({ state: ConversationStateEnum.COMPLETED }));
    await router.route(PHONE, 'ok', 'text');
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Merci pour votre commande !'));
    expect(sm.setState).toHaveBeenCalledWith(PHONE, ConversationStateEnum.IDLE);
  });

  it('AGENT_ESCALATION → relaie le message à l’agent humain', async () => {
    sm.getSession.mockResolvedValue(makeSession({ state: ConversationStateEnum.AGENT_ESCALATION }));
    await router.route(PHONE, 'hello', 'text');
    expect(agent.handle).toHaveBeenCalledWith(PHONE, 'hello');
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('« menu » depuis ORDERING → retour accueil (reset global prioritaire)', async () => {
    sm.getSession.mockResolvedValue(makeSession({ state: ConversationStateEnum.ORDERING }));
    await router.route(PHONE, 'menu', 'text');
    expect(sm.setState).toHaveBeenCalledWith(PHONE, ConversationStateEnum.IDLE);
    expect(sm.resetUnknownCount).toHaveBeenCalledWith(PHONE);
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Bienvenue chez notre boutique'));
    expect(order.handle).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Horaires commerçant (boutique fermée)
  // -------------------------------------------------------------------------

  it('boutique fermée + IDLE → message « fermé » avec les horaires', async () => {
    shopOpen.mockReturnValue(false);
    await router.route(PHONE, 'catalogue', 'text');
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('La boutique est fermée pour le moment.'));
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Nos horaires : 09h — 18h.'));
    expect(catalog.handle).not.toHaveBeenCalled();
  });

  it('boutique fermée sans horaires configurés → message « fermé » sans plage horaire', async () => {
    configSvc.getConfig.mockResolvedValue({
      merchantId: 'admin',
      businessName: 'Test',
      businessDescription: null,
      logoUrl: null,
      openHour: undefined,
      closeHour: undefined,
      timezone: 'Africa/Dakar',
      closedDays: [],
      welcomeMessage: null,
      closedMessage: null,
      thankYouMessage: null,
      paymentMode: 'COD',
      waveNumber: null,
      orangeNumber: null,
      moovNumber: null,
      pawaPayToken: null,
      deliveryEnabled: false,
      deliveryZones: [],
      deliveryFee: 0,
      codEnabled: true,
      defaultLanguage: 'fr',
      supportedLanguages: ['fr'],
      notifyMerchantOrders: true,
      merchantNotifPhone: null,
      waPhoneNumberId: null,
      waAccessToken: null,
      isConfigured: false,
    } as never);
    shopOpen.mockReturnValue(false);
    await router.route(PHONE, 'catalogue', 'text');
    expect(sender.sendText).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining('La boutique est fermée pour le moment.'),
    );
    expect(sender.sendText).not.toHaveBeenCalledWith(PHONE, expect.stringContaining('Nos horaires'));
  });

  it('boutique fermée + flow déjà engagé (ORDERING) → jamais interrompu', async () => {
    sm.getSession.mockResolvedValue(makeSession({ state: ConversationStateEnum.ORDERING, orderFlow: 'CONFIRM_ORDER' }));
    shopOpen.mockReturnValue(false);
    await router.route(PHONE, '1', 'text');
    expect(order.handle).toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Pass-through livreur + onboarding
  // -------------------------------------------------------------------------

  it('numéro de livreur enregistré → DeliveryModule uniquement, état client intact', async () => {
    isLivreurSvc.mockResolvedValue(true);
    await router.route(PHONE, 'OUI', 'text');
    expect(dlv.handleLivreurResponse).toHaveBeenCalledWith(PHONE, 'OUI');
    expect(sm.getSession).not.toHaveBeenCalled();
    expect(catalog.handle).not.toHaveBeenCalled();
  });

  it('« activer » → interception onboarding (chemin B)', async () => {
    await router.route(PHONE, 'ACTIVER', 'text');
    expect(gui.handle).toHaveBeenCalledWith(PHONE, 'ACTIVER');
    expect(sm.setState).not.toHaveBeenCalled();
    expect(catalog.handle).not.toHaveBeenCalled();
  });

  it('état ONBOARDING_* → message confié à l’onboarding guidé', async () => {
    sm.getSession.mockResolvedValue(makeSession({ state: ConversationStateEnum.ONBOARDING_NAME, onboarding: {} }));
    gui.isOnboardingState.mockImplementation(() => true);
    await router.route(PHONE, 'Ma boutique', 'text');
    expect(gui.handle).toHaveBeenCalledWith(PHONE, 'Ma boutique');
    expect(catalog.handle).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Validation manuelle des paiements (MODE B — commerçant)
  // -------------------------------------------------------------------------

  it('numéro commerçant + « VALIDER <ref> » → traité par PaymentModule, flux court-circuité', async () => {
    configSvc.getNotifyPhone.mockResolvedValue(PHONE);
    payment.handleMerchantValidation.mockResolvedValue(true);
    await router.route(PHONE, 'VALIDER 1a2b3c4d', 'text');
    expect(payment.handleMerchantValidation).toHaveBeenCalledWith(PHONE, 'VALIDER 1a2b3c4d');
    expect(sm.setState).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('numéro NON notifié → « VALIDER <ref> » n’est pas intercepté', async () => {
    configSvc.getNotifyPhone.mockResolvedValue('22170000000');
    await router.route(PHONE, 'VALIDER 1a2b3c4d', 'text');
    expect(payment.handleMerchantValidation).not.toHaveBeenCalled();
    expect(sender.sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Bienvenue chez notre boutique'));
  });

  // -------------------------------------------------------------------------
  // Divers
  // -------------------------------------------------------------------------

  it('isLivreur() expose le résultat du service de détection', async () => {
    isLivreurSvc.mockResolvedValue(true);
    await expect(router.isLivreur(PHONE)).resolves.toBe(true);
    expect(isLivreurSvc).toHaveBeenCalledWith(PHONE);
  });
});