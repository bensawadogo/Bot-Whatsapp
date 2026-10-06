-- =============================================================================
-- Migration : campagnes pub ciblées — CTWA + Broadcast (MODULE CAMPAGNES)
-- Compatible PostgreSQL 12+. Générée depuis prisma/schema.prisma
-- (prisma migrate diff — SQL identique à `prisma migrate dev`).
-- =============================================================================

-- CreateTable : campagnes (broadcast / CTWA / réactivation)
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "templateKey" TEXT NOT NULL,
    "templateParams" TEXT NOT NULL DEFAULT '{}',
    "targetSegment" TEXT NOT NULL DEFAULT 'ALL',
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "totalTargeted" INTEGER NOT NULL DEFAULT 0,
    "totalSent" INTEGER NOT NULL DEFAULT 0,
    "totalDelivered" INTEGER NOT NULL DEFAULT 0,
    "totalRead" INTEGER NOT NULL DEFAULT 0,
    "totalReplied" INTEGER NOT NULL DEFAULT 0,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "revenueGenerated" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qualityScore" TEXT NOT NULL DEFAULT 'GREEN',
    "blockRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable : contacts ciblés par campagne (tracking envoi/livraison/lecture)
CREATE TABLE "campaign_contacts" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "ctwaClid" TEXT,
    "isFromCtwa" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "campaign_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_merchantId_status_idx" ON "campaigns"("merchantId", "status");

-- CreateIndex
CREATE INDEX "campaigns_merchantId_createdAt_idx" ON "campaigns"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "campaign_contacts_campaignId_status_idx" ON "campaign_contacts"("campaignId", "status");

-- CreateIndex
CREATE INDEX "campaign_contacts_phoneNumber_idx" ON "campaign_contacts"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_contacts_campaignId_phoneNumber_key" ON "campaign_contacts"("campaignId", "phoneNumber");

-- AddForeignKey
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
