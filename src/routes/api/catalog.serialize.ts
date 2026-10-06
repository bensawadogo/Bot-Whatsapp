/**
 * Sérialisation partagée des produits pour l'API dashboard
 * (lecture : catalog.routes.ts · mutations : catalog.admin.routes.ts).
 */
import type { Product } from '../../modules/catalog/catalog.types';
import { formatPrice } from '../../shared/format';

/** Produit prêt pour le dashboard : prix brut + prix formaté FCFA. */
export function serializeProduct(p: Product): {
  id: string;
  name: string;
  description: string;
  price: number;
  priceFormatted: string;
  stock: number;
  category: string;
  imageUrl: string | null;
  isActive: boolean;
} {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    priceFormatted: formatPrice(p.price),
    stock: p.stock,
    category: p.category,
    imageUrl: p.imageUrl !== '' ? p.imageUrl : null,
    isActive: p.isActive,
  };
}