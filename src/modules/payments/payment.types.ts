/**
 * AfriBot — types du module paiements.
 */

/** Fournisseur de paiement Mobile Money utilisé. */
export enum PaymentProvider {
  CINETPAY = 'CINETPAY',
  FEDAPAY = 'FEDAPAY',
  /** MODE B — virement direct Wave/Orange/Moov validé manuellement (inclut le COD encaissé). */
  DIRECT = 'DIRECT',
  /** MODE C — agrégateur PawaPay (activé quand l'entreprise est créée). */
  PAWAPAY = 'PAWAPAY',
}

/** Cycle de vie d'un paiement. */
export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

/** Paiement persisté (table Prisma `Payment` à venir). */
export interface PaymentRecord {
  id: string;
  orderId: string;
  provider: PaymentProvider;
  transactionId: string;
  /** Montant en unité principale (XOF = FCFA entier). */
  amount: number;
  currency: string;
  status: PaymentStatus;
}

/** Webhook entrant CinetPay (champs `cpm_*` de l'API v2). */
export interface CinetPayWebhook {
  cpm_trans_id: string;
  cpm_site_id: string;
  cpm_trans_status: string;
  cpm_amount: string | number;
  cpm_currency: string;
  cpm_payment_method: string;
  cpm_phone_prefixe?: string;
  cpm_custom?: string;
  cpm_error_message?: string;
  signature?: string;
}

/** Webhook entrant FedaPay (événement transaction.*). */
export interface FedaPayWebhook {
  id: string;
  name: string;
  /** ex: "transaction.approved" */
  event: string;
  data?: {
    id: number;
    status?: string;
    amount?: number;
    currency?: { iso?: string };
    custom_metadata?: { order_id?: string };
  };
}

/** Réponse de création de transaction CinetPay (API v2). */
export interface CinetPayTransactionResponse {
  code: string;
  message: string;
  data: {
    payment_url: string;
    payment_token?: string;
  };
}
