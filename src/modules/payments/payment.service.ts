/**
 * AfriBot — service paiements.
 *
 * - CinetPay : appels HTTP directs axios vers l'API checkout v2
 *   (https://api-checkout.cinetpay.com/v2) — le SDK npm officiel n'existe pas
 *   (404 sur le registre, documenté dans docs/CONFIGURATION.md).
 * - FedaPay : SDK officiel `fedapay` (à initialiser via FedaPay.setApiKey).
 *
 * Sécurité : on ne fait JAMAIS confiance au webhook fournisseur seul.
 * `verifyPayment()` re-demande le statut au fournisseur avant de mettre à jour
 * la base — defence-in-depth contre les webhooks falsifiés.
 */
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { FedaPay, Transaction } from 'fedapay';

import { prisma } from '../../config/database';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { formatPrice } from '../../shared/format';
import type { Order } from '../orders/order.types';
import { PaymentProvider, PaymentStatus, type PaymentRecord } from './payment.types';
import type { CinetPayTransactionResponse } from './payment.types';

export function redactId(id: string): string {
  if (id.length <= 6) return id;
  return `${id.slice(0, 4)}...${id.slice(-2)}`;
}

/**
 * Crée un lien de paiement CinetPay pour une commande.
 * Retourne l'URL de paiement + l'identifiant de transaction (référence).
 * Persisté en tant que PaymentRecord PENDING avant d'envoyer le lien.
 */
export async function createCinetPayLink(order: Order): Promise<{ paymentUrl: string; transactionId: string }> {
  const cp = config.payment.cinetpay;
  if (!cp.siteId || !cp.apiKey || !cp.notifyUrl) {
    throw new Error('Configuration CinetPay incomplète : CINETPAY_SITE_ID / API_KEY / NOTIFY_URL requis');
  }

  // transaction_id = référence métier (commande + uuid)
  const transactionId = `${order.id.slice(0, 8)}-${uuidv4().slice(0, 8)}`;

  const payload = {
    apikey: cp.apiKey,
    site_id: cp.siteId,
    transaction_id: transactionId,
    amount: order.total,
    currency: cp.currency,
    description: `Commande #${order.id} — AfriBot`,
    notify_url: cp.notifyUrl,
    return_url: `${config.server.appUrl}/commande/succes`,
    customer_phone_number: order.phoneNumber,
    channels: 'ALL',
    lang: 'fr',
  };

  const response = await axios.post<CinetPayTransactionResponse>(`${cp.baseUrl}/payment`, payload, {
    timeout: 15_000,
  });

  // Code "00" = transaction créée avec succès (voir doc CinetPay v2)
  if (response.data.code !== '00') {
    throw new Error(`CinetPay : création refusée (${response.data.code} — ${response.data.message})`);
  }

  // Persistance du paiement en attente (anti-double-paiement)
  await createPaymentRecord({
    orderId: order.id,
    provider: PaymentProvider.CINETPAY,
    transactionId,
    amount: order.total,
    currency: cp.currency,
    status: PaymentStatus.PENDING,
  });

  return { paymentUrl: response.data.data.payment_url, transactionId };
}

/**
 * Crée un lien de paiement FedaPay pour une commande.
 * Utilise le SDK officiel `fedapay` (voir node_modules/fedapay — MIT).
 */
export async function createFedaPayLink(order: Order): Promise<{ paymentUrl: string; transactionId: string }> {
  const fp = config.payment.fedapay;
  if (!fp.secretKey) {
    throw new Error('Configuration FedaPay incomplète : FEDAPAY_SECRET_KEY requise');
  }

  FedaPay.setApiKey(fp.secretKey);
  FedaPay.setEnvironment(fp.environment);

  // FedaPay génère un token puis une URL de paiement
  const tx = await Transaction.create({
    description: `Commande #${order.id} — AfriBot`,
    amount: order.total,
    currency: 'XOF',
    callback_url: `${config.server.appUrl}/webhook/payment`,
    customer: { phone_number: order.phoneNumber },
  });

  // generateToken() → { token, ... } ; l'URL de paiement utilise ce token
  const tokenObj = await tx.generateToken();
  const token = (tokenObj as { token?: string }).token ?? '';
  if (!token) {
    throw new Error('FedaPay : token de paiement introuvable dans la réponse');
  }

  // URL de paiement FedaPay standard (sandbox/live)
  const baseUrl = fp.environment === 'live' ? 'https://fedapay.com' : 'https://sandbox.fedapay.com';
  const paymentUrl = `${baseUrl}/p/checkout/${token}`;
  const transactionId = String((tx as { id?: string | number }).id ?? uuidv4());

  await createPaymentRecord({
    orderId: order.id,
    provider: PaymentProvider.FEDAPAY,
    transactionId,
    amount: order.total,
    currency: 'XOF',
    status: PaymentStatus.PENDING,
  });

  return { paymentUrl, transactionId };
}

// ---------------------------------------------------------------------------
// Vérification anti-fraude
// ---------------------------------------------------------------------------

/**
 * Vérifie le statut réel d'un paiement auprès du fournisseur (anti-fraude webhook).
 * Re-demande le statut auprès du fournisseur avant de mettre à jour la base —
 * on ne fait JAMAIS confiance au webhook fournisseur seul.
 *
 * @param provider Fournisseur concerné (CINETPAY ou FEDAPAY).
 * @returns true si le paiement est ACCEPTED/approved.
 */
export async function verifyPayment(transactionId: string, provider: PaymentProvider): Promise<boolean> {
  if (provider === PaymentProvider.CINETPAY) {
    return verifyCinetPay(transactionId);
  }
  return verifyFedaPay(transactionId);
}

/** Vérifie un paiement CinetPay via l'endpoint /payment/check. */
async function verifyCinetPay(transactionId: string): Promise<boolean> {
  const cp = config.payment.cinetpay;
  if (!cp.siteId || !cp.apiKey) {
    throw new Error('Configuration CinetPay incomplète pour la vérification');
  }

  try {
    const response = await axios.post<{ code: string; data?: { status?: string } }>(
      `${cp.baseUrl}/payment/check`,
      { apikey: cp.apiKey, site_id: cp.siteId, transaction_id: transactionId },
      { timeout: 10_000 },
    );

    // CinetPay renvoie code "00" + data.status à vérifier
    const status = response.data.data?.status?.toUpperCase() ?? '';
    return response.data.code === '00' && status === 'ACCEPTED';
  } catch (err) {
    logger.error(`Vérification CinetPay ${redactId(transactionId)} échouée : ${String(err)}`);
    return false;
  }
}

/** Vérifie un paiement FedaPay via Transaction.retrieve(). */
async function verifyFedaPay(transactionId: string): Promise<boolean> {
  const fp = config.payment.fedapay;
  if (!fp.secretKey) {
    throw new Error('Configuration FedaPay incomplète pour la vérification');
  }

  FedaPay.setApiKey(fp.secretKey);
  FedaPay.setEnvironment(fp.environment);

  try {
    const tx = await Transaction.retrieve(transactionId);
    const status = (tx as { status?: string }).status?.toLowerCase() ?? '';
    // Statuts FedaPay payants : approved, transferred, refunded
    return ['approved', 'transferred', 'refunded'].includes(status);
  } catch (err) {
    logger.error(`Vérification FedaPay ${redactId(transactionId)} échouée : ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistance (Prisma — table Payment)
// ---------------------------------------------------------------------------

interface CreatePaymentInput {
  orderId: string;
  provider: PaymentProvider;
  transactionId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
}

/** Persiste un enregistrement de paiement (table `payments`). */
export async function createPaymentRecord(input: CreatePaymentInput): Promise<PaymentRecord> {
  const record = await prisma.payment.create({
    data: {
      orderId: input.orderId,
      provider: input.provider,
      transactionId: input.transactionId,
      amount: input.amount,
      currency: input.currency,
      status: input.status,
    },
  });
  return {
    id: record.id,
    orderId: record.orderId,
    provider: record.provider as PaymentProvider,
    transactionId: record.transactionId,
    amount: record.amount,
    currency: record.currency,
    status: record.status as PaymentStatus,
  };
}

/** Met à jour le statut d'un paiement (SUCCESS / FAILED / REFUNDED). */
export async function updatePaymentStatus(transactionId: string, status: PaymentStatus): Promise<void> {
  await prisma.payment.updateMany({
    where: { transactionId },
    data: { status },
  });
  logger.info(`Paiement ${redactId(transactionId)} → ${status}`);
}

/**
 * Enregistre le paiement COD (Cash On Delivery) lors de la livraison.
 * Appelé par DeliveryModule.confirmDelivery().
 */
export async function settleCODPayment(deliveryId: string, orderId: string, amount: number): Promise<void> {
  const transactionId = `COD-${deliveryId}`;
  try {
    await createPaymentRecord({
      orderId,
      provider: PaymentProvider.DIRECT,
      transactionId,
      amount: Math.round(amount),
      currency: 'XOF',
      status: PaymentStatus.SUCCESS,
    });
  } catch (err) {
    // Déjà enregistré (rejeu du message « LIVRÉ ») → on resynchronise le statut
    logger.warn(`Paiement COD ${deliveryId} déjà enregistré : ${String(err)}`);
    await updatePaymentStatus(transactionId, PaymentStatus.SUCCESS);
  }
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'PAID' },
  });
  logger.info(`Paiement COD ${deliveryId} réglé (commande ${orderId.slice(0, 8)})`);
}

// ---------------------------------------------------------------------------
// MODE C — PawaPay (agrégateur) : actif seulement si PAWAPAY_API_TOKEN existe
// ---------------------------------------------------------------------------

/** Réponse de création de dépôt PawaPay (champs utilisés uniquement). */
interface PawaPayDepositResponse {
  depositId: string;
  status: string;
  /** Lien de paiement hébergé (mode lien). */
  paymentLink?: string;
  /** Code USSD à composer par le client (mode USSD push). */
  ussd?: string;
  operator?: string;
}

/** MODE C activé ? Token présent dans l'env (repli MODE B sinon). */
export function isPawaPayEnabled(): boolean {
  return Boolean(config.payment.pawapay.apiToken);
}

/**
 * Crée un dépôt PawaPay pour une commande (appel HTTP direct à api.pawapay.io).
 * Retourne les instructions client (lien de paiement ou code USSD) et persiste
 * le paiement en PENDING (provider PAWAPAY). La confirmation arrive par
 * webhook (verifyPayment côté handler).
 */
export async function createPawaPayDeposit(order: Order): Promise<{ instructions: string; depositId: string }> {
  const pp = config.payment.pawapay;
  if (!pp.apiToken) {
    throw new Error('PAWAPAY_API_TOKEN manquant — repli sur le MODE B requis');
  }

  // L'API PawaPay attend des montants en centimes (minor units) et un numéro
  // au format international SANS « + ».
  const phone = order.phoneNumber.replace(/\D/g, '');

  const response = await axios.post<PawaPayDepositResponse>(
    `${pp.baseUrl}/deposits`,
    {
      depositId: `afribot-${order.id.slice(0, 8)}-${Date.now()}`,
      amount: String(Math.round(order.total * 100)),
      currency: 'XOF',
      payer: { type: 'MMO', accountNo: phone },
      customerReference: order.id,
      description: `Commande #${order.id.slice(0, 8)}`,
    },
    {
      headers: {
        Authorization: `Bearer ${pp.apiToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    },
  );

  const { depositId, paymentLink, ussd } = response.data;

  await createPaymentRecord({
    orderId: order.id,
    provider: PaymentProvider.PAWAPAY,
    transactionId: depositId,
    amount: order.total,
    currency: 'XOF',
    status: PaymentStatus.PENDING,
  });

  const instructions = ussd
    ? `💳 PawaPay : composez *${ussd}* sur votre téléphone pour payer ${formatPrice(order.total)}.`
    : `💳 PawaPay : ouvrez ce lien pour payer ${formatPrice(order.total)} :\n${paymentLink ?? 'https://pawapay.io'}`;

  return { instructions, depositId };
}
