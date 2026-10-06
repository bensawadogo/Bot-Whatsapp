/**
 * AfriBot - nettoyage des donnees laissees par les runs e2e (campagnes de test).
 * Supprime uniquement les campagnes dont le nom correspond aux motifs de test.
 * Usage : node scripts/clean-e2e-data.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const TEST_NAME_PATTERNS = ['Test DORMANT (e2e)', 'Test invalide', 'Test (e2e)'];

(async () => {
  const prisma = new PrismaClient();
  const out = [];
  try {
    const rows = await prisma.campaign.findMany({
      where: { OR: TEST_NAME_PATTERNS.map((name) => ({ name })) },
      select: { id: true, name: true, status: true },
    });
    out.push(`TROUVEES=${rows.length}`);
    for (const row of rows) {
      const contacts = await prisma.campaignContact.deleteMany({ where: { campaignId: row.id } });
      await prisma.campaign.delete({ where: { id: row.id } });
      out.push(`SUPPRIMEE ${row.id} | ${row.name} | ${row.status} | contacts=${contacts.count}`);
    }
    const rest = await prisma.campaign.count();
    out.push(`CAMPAGNES_RESTANTES=${rest}`);
  } catch (err) {
    out.push(`ERREUR: ${String(err)}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
  console.log(out.join('\n'));
})().catch((err) => {
  console.error(`ERREUR CLEANUP : ${String(err)}`);
  process.exitCode = 1;
});
