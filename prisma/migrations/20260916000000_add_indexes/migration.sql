-- =============================================================================
-- Migration : index supplémentaires pour les requêtes de lecture fréquentes
-- (rapports, stats, livraisons par livreur). Compatible PostgreSQL 12+.
-- =============================================================================

-- CreateIndex
CREATE INDEX "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");

-- CreateIndex
CREATE INDEX "deliveries_livreurPhone_status_idx" ON "deliveries"("livreurPhone", "status");