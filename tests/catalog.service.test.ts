/**
 * Tests — service catalogue (accès données produits).
 * Prisma est mocké (pas de PostgreSQL requis), pattern identique à
 * tests/refund.service.test.ts. Les erreurs Prisma (P2002/P2025) sont
 * simulées avec la vraie classe Prisma.PrismaClientKnownRequestError.
 */
import { Prisma } from '@prisma/client';

import { prisma } from '../src/config/database';
import {
  createProduct,
  deactivateProduct,
  getAllProducts,
  getProductById,
  getProductByName,
  getProductsByIds,
  listProductsPaginated,
  prismaErrorMessage,
  searchProducts,
  setStock,
  updateProduct,
} from '../src/modules/catalog/catalog.service';

jest.mock('../src/config/database', () => ({
  prisma: {
    product: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

const productDb = prisma.product as unknown as {
  findFirst: jest.Mock;
  findMany: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

/** Construit une vraie erreur Prisma avec le code donné (instanceof OK). */
function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Erreur Prisma ${code}`, {
    code,
    clientVersion: '5.22.0',
  });
}

/** Ligne retournée par Prisma (product table) — correspond au schéma. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    name: 'Riz parfumé 5kg',
    price: 3500,
    stock: 12,
    imageUrl: 'https://img.example/riz.jpg',
    category: 'Céréales',
    description: 'Riz de qualité supérieure',
    isActive: true,
    ...overrides,
  };
}

describe('getProductById', () => {
  it('retourne le produit mappé (imageUrl null → "") ou null si introuvable', async () => {
    productDb.findFirst.mockResolvedValue(row({ imageUrl: null }));
    const product = await getProductById('prod-1');
    expect(product).toEqual({
      id: 'prod-1',
      name: 'Riz parfumé 5kg',
      price: 3500,
      stock: 12,
      imageUrl: '',
      category: 'Céréales',
      description: 'Riz de qualité supérieure',
      isActive: true,
    });
    expect(productDb.findFirst).toHaveBeenCalledWith({ where: { id: 'prod-1', isActive: true } });

    productDb.findFirst.mockResolvedValueOnce(null);
    expect(await getProductById('nope')).toBeNull();
  });
});

describe('getProductsByIds', () => {
  it('retourne [] sans toucher Prisma si la liste est vide, sinon filtre les ids manquants', async () => {
    expect(await getProductsByIds([])).toEqual([]);
    expect(productDb.findMany).not.toHaveBeenCalled();

    productDb.findMany.mockResolvedValue([row()]);
    const products = await getProductsByIds(['prod-1', 'prod-999']);
    expect(products).toHaveLength(1);
    expect(products[0].id).toBe('prod-1');
    expect(productDb.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['prod-1', 'prod-999'] }, isActive: true },
    });
  });
});

describe('getAllProducts', () => {
  it('retourne tous les produits actifs triés catégorie puis nom', async () => {
    productDb.findMany.mockResolvedValue([row({ id: 'p2', name: 'B' }), row({ id: 'p1', name: 'A' })]);
    const products = await getAllProducts();
    expect(products.map((p) => p.id)).toEqual(['p2', 'p1']);
    expect(productDb.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  });
});

describe('searchProducts', () => {
  it('retourne [] pour une requête vide (espaces seuls) sans toucher Prisma', async () => {
    expect(await searchProducts('   ')).toEqual([]);
    expect(productDb.findMany).not.toHaveBeenCalled();
  });

  it('cherche insensible à la casse sur nom/description/catégorie, limité à 50', async () => {
    productDb.findMany.mockResolvedValue([row()]);
    const products = await searchProducts('riz');
    expect(products).toHaveLength(1);
    expect(productDb.findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        OR: [
          { name: { contains: 'riz', mode: 'insensitive' } },
          { description: { contains: 'riz', mode: 'insensitive' } },
          { category: { contains: 'riz', mode: 'insensitive' } },
        ],
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: 50,
    });
  });
});

describe('getProductByName', () => {
  it('retrouve par nom exact, ou retourne null', async () => {
    productDb.findFirst.mockResolvedValue(row());
    const product = await getProductByName('Riz parfumé 5kg');
    expect(product?.id).toBe('prod-1');
    expect(productDb.findFirst).toHaveBeenCalledWith({ where: { name: 'Riz parfumé 5kg', isActive: true } });

    productDb.findFirst.mockResolvedValueOnce(null);
    expect(await getProductByName('Inconnu')).toBeNull();
  });
});

describe('listProductsPaginated', () => {
  it('applique les défauts page=1 / limit=20 et calcule totalPages', async () => {
    productDb.findMany.mockResolvedValue([row()]);
    productDb.count.mockResolvedValue(1);
    const result = await listProductsPaginated({});
    expect(result).toEqual({
      products: [expect.objectContaining({ id: 'prod-1' })],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
    expect(productDb.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      skip: 0,
      take: 20,
    });
    expect(productDb.count).toHaveBeenCalledWith({ where: { isActive: true } });
  });

  it('borne page/limit (page<1 → 1, limit>100 → 100) et applique la recherche', async () => {
    productDb.findMany.mockResolvedValue([row()]);
    productDb.count.mockResolvedValue(0);
    const result = await listProductsPaginated({ page: -2, limit: 500, query: '  riz  ' });
    expect(result.page).toBe(1);
    expect(result.limit).toBe(100);
    expect(result.totalPages).toBe(0); // ceil(0/100) — comportement actuel
    expect(productDb.findMany).toHaveBeenCalledWith({
      where: {
        isActive: true,
        OR: [
          { name: { contains: 'riz', mode: 'insensitive' } },
          { description: { contains: 'riz', mode: 'insensitive' } },
          { category: { contains: 'riz', mode: 'insensitive' } },
        ],
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      skip: 0,
      take: 100,
    });
  });
});

describe('createProduct', () => {
  it('crée un produit (imageUrl fournie ou null) et mappe le résultat', async () => {
    productDb.create.mockResolvedValue(row());
    const withImage = await createProduct({
      name: 'Riz',
      description: 'desc',
      price: 3500,
      stock: 12,
      category: 'Céréales',
      imageUrl: 'https://img.example/riz.jpg',
    });
    expect(withImage).toEqual(expect.objectContaining({ id: 'prod-1', imageUrl: 'https://img.example/riz.jpg' }));
    expect(productDb.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Riz', imageUrl: 'https://img.example/riz.jpg' }),
    });

    productDb.create.mockResolvedValue(row({ imageUrl: null }));
    const withoutImage = await createProduct({
      name: 'Sucre',
      description: '',
      price: 1000,
      stock: 5,
      category: 'Épicerie',
    });
    expect(withoutImage.imageUrl).toBe('');
    expect(productDb.create).toHaveBeenCalledWith({ data: expect.objectContaining({ imageUrl: null }) });
  });

  it('rejette l’erreur P2002 sur nom dupliqué (non capturée par le service)', async () => {
    productDb.create.mockRejectedValueOnce(prismaError('P2002'));
    await expect(
      createProduct({ name: 'Riz', description: '', price: 1000, stock: 1, category: 'general' }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('updateProduct', () => {
  it('ne met à jour que les champs fournis', async () => {
    productDb.update.mockResolvedValue(row({ price: 4000 }));
    const product = await updateProduct('prod-1', { price: 4000 });
    expect(product?.price).toBe(4000);
    expect(productDb.update).toHaveBeenCalledWith({ where: { id: 'prod-1' }, data: { price: 4000 } });
  });

  it('retourne null sur P2025 (introuvable) et re-propage les autres erreurs', async () => {
    productDb.update.mockRejectedValueOnce(prismaError('P2025'));
    expect(await updateProduct('prod-x', { stock: 0 })).toBeNull();

    productDb.update.mockRejectedValueOnce(new Error('panne réseau'));
    await expect(updateProduct('prod-x', { price: 1 })).rejects.toThrow('panne réseau');
  });
});

describe('setStock / deactivateProduct', () => {
  it('setStock met à jour le stock (succès + P2025 → null)', async () => {
    productDb.update.mockResolvedValue(row({ stock: 0 }));
    expect((await setStock('prod-1', 0))?.stock).toBe(0);
    expect(productDb.update).toHaveBeenCalledWith({ where: { id: 'prod-1' }, data: { stock: 0 } });

    productDb.update.mockRejectedValueOnce(prismaError('P2025'));
    expect(await setStock('prod-x', 5)).toBeNull();
  });

  it('deactivateProduct fait le soft delete isActive:false (succès + P2025 → null)', async () => {
    productDb.update.mockResolvedValue(row({ isActive: false }));
    const product = await deactivateProduct('prod-1');
    expect(product?.isActive).toBe(false);
    expect(productDb.update).toHaveBeenCalledWith({ where: { id: 'prod-1' }, data: { isActive: false } });

    productDb.update.mockRejectedValueOnce(prismaError('P2025'));
    expect(await deactivateProduct('prod-x')).toBeNull();
  });
});

describe('prismaErrorMessage', () => {
  it('mappe P2002 → doublon et P2025 → introuvable, sinon fallback', () => {
    expect(prismaErrorMessage(prismaError('P2002'), 'fallback')).toBe('Ce nom de produit existe déjà.');
    expect(prismaErrorMessage(prismaError('P2025'), 'fallback')).toBe('Produit introuvable.');
    expect(prismaErrorMessage(new Error('autre'), 'fallback')).toBe('fallback');
    expect(prismaErrorMessage({ code: 'P2002' }, 'fallback')).toBe('fallback');
  });
});