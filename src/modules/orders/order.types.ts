/**
 * AfriBot — types du module commandes.
 */

/** Cycle de vie d'une commande (aligné ARCHITECTURE.md). */
export enum OrderStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  PAID = 'PAID',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

/** Mode de paiement : livraison contre espèces ou Mobile Money. */
export enum PaymentMethod {
  COD = 'COD',
  MOBILE_MONEY = 'MOBILE_MONEY',
}

/** Sous-états internes du flow de commande (persistés en session). */
export enum OrderFlowState {
  SELECT_QUANTITY = 'SELECT_QUANTITY',
  CART_REVIEW = 'CART_REVIEW',
  CONFIRM_ADDRESS = 'CONFIRM_ADDRESS',
  CONFIRM_ORDER = 'CONFIRM_ORDER',
}

/** Ligne de panier (prix figé au moment de l'ajout — anti-surprise). */
export interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

/** Ligne de commande. */
export interface OrderItem {
  productId: string;
  quantity: number;
  /** Prix unitaire figé au moment de la commande (FCFA). */
  unitPrice: number;
}

/** Commande persistée dans PostgreSQL (table Prisma `Order` à venir). */
export interface Order {
  id: string;
  phoneNumber: string;
  items: OrderItem[];
  /** Total en FCFA (entier, pas de centimes). */
  total: number;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  address: string;
  createdAt: Date;
}

/** Données nécessaires à la création d'une commande. */
export interface CreateOrderDto {
  phoneNumber: string;
  items: OrderItem[];
  paymentMethod: PaymentMethod;
  address: string;
}
