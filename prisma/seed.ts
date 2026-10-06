import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const merchant = await prisma.merchant.upsert({
    where: { id: 'admin' },
    update: {},
    create: {
      id: 'admin',
      name: process.env.MERCHANT_NAME || 'Mon commerce',
      phone: process.env.MERCHANT_PHONE || null,
    },
  });

  const configExists = await prisma.merchantConfig.findUnique({
    where: { merchantId: merchant.id },
  });

  if (!configExists) {
    await prisma.merchantConfig.create({
      data: {
        merchantId: merchant.id,
        businessName: merchant.name,
        openHour: parseInt(process.env.MERCHANT_OPEN_HOUR || '8', 10),
        closeHour: parseInt(process.env.MERCHANT_CLOSE_HOUR || '20', 10),
        timezone: process.env.MERCHANT_TIMEZONE || 'Africa/Dakar',
      },
    });
  }

  console.log('✅ Seed terminé : merchant "admin" prêt.');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('❌ Erreur seed :', e);
    await prisma.$disconnect();
    process.exit(1);
  });
