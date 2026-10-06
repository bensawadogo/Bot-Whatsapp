-- =============================================================================
-- Migration : livraison + livreurs + config commerçant + journal conformité
-- (MODULES 1, 3 & 5). Compatible PostgreSQL 12+.
-- =============================================================================

-- AlterEnum : nouveaux fournisseurs de paiement (MODE B direct / MODE C PawaPay)
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'DIRECT';
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'PAWAPAY';

-- CreateEnum : cycle de vie d'une livraison
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'ASSIGNED', 'PICKED_UP', 'EN_ROUTE', 'DELIVERED', 'FAILED');

-- AlterTable : métadonnées libres du paiement (code transaction Wave/OM/Moov...)
ALTER TABLE "payments" ADD COLUMN "metadata" TEXT;

-- CreateTable : journal de conversation durable (conformité Meta — MODULE 5)
-- Sert de preuve d'opt-in et de source pour la fenêtre de service de 24 h.
CREATE TABLE "conversation_logs" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "fromMe" BOOLEAN NOT NULL,
    "text" TEXT,
    "type" TEXT NOT NULL DEFAULT 'text',
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable : commerçant (tenant unique — cf. auth.routes.ts merchantId 'admin')
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Mon commerce',
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable : configuration du bot éditable depuis le dashboard (MODULE 3.1)
CREATE TABLE "merchant_configs" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "businessDescription" TEXT,
    "logoUrl" TEXT,
    "openHour" INTEGER NOT NULL DEFAULT 8,
    "closeHour" INTEGER NOT NULL DEFAULT 20,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Ouagadougou',
    "closedDays" TEXT NOT NULL DEFAULT '[]',
    "welcomeMessage" TEXT,
    "closedMessage" TEXT,
    "thankYouMessage" TEXT,
    "paymentMode" TEXT NOT NULL DEFAULT 'COD',
    "waveNumber" TEXT,
    "orangeNumber" TEXT,
    "moovNumber" TEXT,
    "pawaPayToken" TEXT,
    "deliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deliveryZones" TEXT NOT NULL DEFAULT '[]',
    "deliveryFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "codEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'fr',
    "supportedLanguages" TEXT NOT NULL DEFAULT '["fr"]',
    "notifyMerchantOrders" BOOLEAN NOT NULL DEFAULT true,
    "merchantNotifPhone" TEXT,
    "waPhoneNumberId" TEXT,
    "waAccessToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable : livreurs du commerçant (notifiés via WhatsApp — MODULE 1)
CREATE TABLE "livreurs" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "zone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "totalDeliveries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "livreurs_pkey" PRIMARY KEY ("id")
);

-- CreateTable : livraisons (1-1 avec une commande — MODULE 1)
CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "livreurId" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "livreurPhone" TEXT,
    "customerPhone" TEXT NOT NULL,
    "deliveryAddress" TEXT NOT NULL,
    "estimatedTime" INTEGER,
    "proofPhoto" TEXT,
    "failureReason" TEXT,
    "codAmount" DOUBLE PRECISION,
    "codCollected" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "assignedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_logs_phone_fromMe_createdAt_idx" ON "conversation_logs"("phone", "fromMe", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_configs_merchantId_key" ON "merchant_configs"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "livreurs_phone_key" ON "livreurs"("phone");

-- CreateIndex
CREATE INDEX "livreurs_merchantId_isActive_idx" ON "livreurs"("merchantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_orderId_key" ON "deliveries"("orderId");

-- CreateIndex
CREATE INDEX "deliveries_status_idx" ON "deliveries"("status");

-- CreateIndex
CREATE INDEX "deliveries_livreurId_status_idx" ON "deliveries"("livreurId", "status");

-- AddForeignKey
ALTER TABLE "merchant_configs" ADD CONSTRAINT "merchant_configs_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "livreurs" ADD CONSTRAINT "livreurs_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_livreurId_fkey" FOREIGN KEY ("livreurId") REFERENCES "livreurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
