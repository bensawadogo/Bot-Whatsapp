/**
 * AfriBot - verification de la base locale (stack Windows native, sans Docker).
 *
 * Controle que les tables attendues existent et sont vides/peuplees comme
 * prevu, puis se deconnecte. Usage : node scripts/db-verify.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const [campaigns, contacts, livreurs, deliveries, orders, products] = await Promise.all([
      prisma.campaign.count(),
      prisma.campaignContact.count(),
      prisma.livreur.count(),
      prisma.delivery.count(),
      prisma.order.count(),
      prisma.product.count(),
    ]);

    console.log('CONNEXION=OK');
    console.log(`campaigns=${campaigns}`);
    console.log(`campaign_contacts=${contacts}`);
    console.log(`livreurs=${livreurs}`);
    console.log(`deliveries=${deliveries}`);
    console.log(`orders=${orders}`);
    console.log(`products=${products}`);

    const rows = await prisma.$queryRawUnsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    console.log('TABLES=' + rows.map((r) => r.table_name).join(','));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('ERREUR=' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});