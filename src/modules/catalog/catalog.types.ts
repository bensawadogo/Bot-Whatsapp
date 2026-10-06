/**
 * AfriBot — types du module catalogue.
 */

/** Produit du catalogue commerçant (table Prisma `Product` à venir). */
export interface Product {
  id: string;
  name: string;
  /** Prix en unité principale de devise (XOF = FCFA entier, pas de centimes). */
  price: number;
  stock: number;
  /** URL de la photo compressée (< 100 Ko — optimisation 2G/3G via sharp). */
  imageUrl: string;
  category: string;
  description: string;
  isActive: boolean;
}

/** Message catalogue paginé envoyé sur WhatsApp. */
export interface CatalogMessage {
  products: Product[];
  page: number;
}
