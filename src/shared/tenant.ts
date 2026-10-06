/**
 * AfriBot — tenant mono-commerçant (MODULE 3).
 *
 * Le déploiement sert UN commerçant : l'identifiant est fixé par MERCHANT_ID
 * (défaut `admin`) et DOIT rester aligné sur le `merchantId` signé dans le JWT
 * (src/routes/api/auth.routes.ts → 'admin'). Les modèles `Livreur` et
 * `MerchantConfig` portent une clé `merchantId` pour préparer le multi-clients
 * (Phase 5b) sans réécriture.
 *
 * `ensureMerchant()` est un upsert paresseux idempotent : aucun script de seed
 * n'est nécessaire, la ligne est créée au premier accès (dashboard, livreur...).
 */
import { prisma } from '../config/database';
import { config } from '../config/env';

/** Identifiant du tenant unique — aligné sur le payload JWT (`merchantId`). */
export const SINGLE_TENANT_MERCHANT_ID = config.merchant.id;

/** Garantit l'existence du commerçant en base et retourne son identifiant. */
export async function ensureMerchant(): Promise<string> {
  const id = SINGLE_TENANT_MERCHANT_ID;
  await prisma.merchant.upsert({
    where: { id },
    create: {
      id,
      name: config.merchant.name,
      phone: config.merchant.phone ?? null,
    },
    // Aucune mise à jour : les valeurs de .env ne doivent pas écraser un nom
    // renommé depuis le dashboard.
    update: {},
  });
  return id;
}

/** Ligne `Merchant` (créée si absente). */
export async function getMerchant(): Promise<{ id: string; name: string; phone: string | null }> {
  const id = await ensureMerchant();
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id },
    select: { id: true, name: true, phone: true },
  });
  return merchant;
}
