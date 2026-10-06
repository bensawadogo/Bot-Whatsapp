/**
 * AfriBot — service catalogue (accès données PostgreSQL via Prisma).
 *
 * Les requêtes partent du client Prisma (table `products` créée par la
 * migration initiale). Les variantes sans accents (wolof/dioula) sont
 * couvertes par une recherche insensible à la casse sur nom + description.
 */
import { Prisma } from '@prisma/client';

import { prisma } from '../../config/database';
import type { Product } from './catalog.types';

/** Mappe un enregistrement Prisma vers le type métier Product. */
function toProduct(row: {
  id: string;
  name: string;
  price: number;
  stock: number;
  imageUrl: string | null;
  category: string;
  description: string;
  isActive: boolean;
}): Product {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    stock: row.stock,
    imageUrl: row.imageUrl ?? '',
    category: row.category,
    description: row.description,
    isActive: row.isActive,
  };
}

/** Retourne un produit par son identifiant, ou null si introuvable/inactif. */
export async function getProductById(id: string): Promise<Product | null> {
  const row = await prisma.product.findFirst({ where: { id, isActive: true } });
  return row ? toProduct(row) : null;
}

/** Retourne plusieurs produits par leurs identifiants (actifs uniquement). */
export async function getProductsByIds(ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.product.findMany({ where: { id: { in: ids }, isActive: true } });
  return rows.map(toProduct);
}

/** Retourne tous les produits actifs, triés par catégorie puis nom. */
export async function getAllProducts(): Promise<Product[]> {
  const rows = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toProduct);
}

/** Recherche plein texte simple par mot-clé (nom, description, catégorie). */
export async function searchProducts(query: string): Promise<Product[]> {
  const term = query.trim();
  if (term.length === 0) return [];

  const rows = await prisma.product.findMany({
    where: {
      isActive: true,
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { category: { contains: term, mode: 'insensitive' } },
      ],
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    take: 50,
  });
  return rows.map(toProduct);
}

/** Retourne un produit par son nom exact (recherche depuis la liste). */
export async function getProductByName(name: string): Promise<Product | null> {
  const row = await prisma.product.findFirst({
    where: { name, isActive: true },
  });
  return row ? toProduct(row) : null;
}

/** Résultat paginé pour l'API REST du dashboard. */
export interface PaginatedProducts {
  products: Product[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Liste paginée des produits actifs, avec recherche optionnelle.
 * Utilisée par GET /api/catalog (dashboard). Pagination côté SQL (skip/take)
 * pour rester scalable quand le catalogue grossit.
 */
export async function listProductsPaginated(options: {
  query?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}): Promise<PaginatedProducts> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
  const term = (options.query ?? '').trim();

  const where = {
    isActive: true,
    ...(term.length > 0 && {
      OR: [
        { name: { contains: term, mode: 'insensitive' as const } },
        { description: { contains: term, mode: 'insensitive' as const } },
        { category: { contains: term, mode: 'insensitive' as const } },
      ],
    }),
  };

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.product.count({ where }),
  ]);

  return {
    products: rows.map(toProduct),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ---------------------------------------------------------------------------
// Mutations (dashboard commerçant — Phase 5, protégées par JWT)
// ---------------------------------------------------------------------------

/** Données de création d'un produit (validation Zod faite dans la route). */
export interface CreateProductDto {
  name: string;
  description: string;
  price: number;
  stock: number;
  category: string;
  imageUrl?: string | undefined;
}

/** Champs modifiables d'un produit (update partiel). */
export type UpdateProductDto = {
  name?: string | undefined;
  description?: string | undefined;
  price?: number | undefined;
  stock?: number | undefined;
  category?: string | undefined;
  imageUrl?: string | null | undefined;
};

/** Traduit une erreur Prisma connue en message métier lisible. */
function prismaErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return 'Ce nom de produit existe déjà.';
    if (error.code === 'P2025') return 'Produit introuvable.';
  }
  return fallback;
}

/** Crée un produit (actif par défaut). */
export async function createProduct(data: CreateProductDto): Promise<Product> {
  const row = await prisma.product.create({
    data: {
      name: data.name,
      description: data.description,
      price: data.price,
      stock: data.stock,
      category: data.category,
      imageUrl: data.imageUrl ?? null,
    },
  });
  return toProduct(row);
}

/**
 * Met à jour uniquement les champs fournis.
 * Retourne null si le produit n'existe pas (P2025) — les autres erreurs
 * (connexion...) sont repropagées.
 */
export async function updateProduct(id: string, data: UpdateProductDto): Promise<Product | null> {
  const dbData: {
    name?: string;
    description?: string;
    price?: number;
    stock?: number;
    category?: string;
    imageUrl?: string | null;
  } = {};
  if (data.name !== undefined) dbData.name = data.name;
  if (data.description !== undefined) dbData.description = data.description;
  if (data.price !== undefined) dbData.price = data.price;
  if (data.stock !== undefined) dbData.stock = data.stock;
  if (data.category !== undefined) dbData.category = data.category;
  if (data.imageUrl !== undefined) dbData.imageUrl = data.imageUrl;

  try {
    const row = await prisma.product.update({ where: { id }, data: dbData });
    return toProduct(row);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return null;
    }
    throw error;
  }
}

/** Met à jour uniquement le stock. Retourne null si produit introuvable. */
export async function setStock(id: string, stock: number): Promise<Product | null> {
  try {
    const row = await prisma.product.update({ where: { id }, data: { stock } });
    return toProduct(row);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return null;
    }
    throw error;
  }
}

/**
 * Soft delete : isActive = false (jamais de suppression physique — les
 * OrderItem référencent le produit et l'historique doit rester lisible).
 */
export async function deactivateProduct(id: string): Promise<Product | null> {
  try {
    const row = await prisma.product.update({ where: { id }, data: { isActive: false } });
    return toProduct(row);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return null;
    }
    throw error;
  }
}

export { prismaErrorMessage };