-- =============================================================================
-- Migration : montants FCFA Float -> Int (pas de centimes en XOF)
-- - deliveries.codAmount : DOUBLE PRECISION -> INTEGER
-- - campaigns.revenueGenerated : DOUBLE PRECISION -> INTEGER
-- Les valeurs existantes sont arrondies (ROUND) avant conversion.
-- =============================================================================

ALTER TABLE "deliveries" ALTER COLUMN "codAmount" TYPE INTEGER USING ROUND("codAmount")::INTEGER;
ALTER TABLE "campaigns" ALTER COLUMN "revenueGenerated" TYPE INTEGER USING ROUND("revenueGenerated")::INTEGER;
ALTER TABLE "campaigns" ALTER COLUMN "revenueGenerated" SET DEFAULT 0;
