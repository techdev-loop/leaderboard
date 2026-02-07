import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Optional: seed default scraper config keys if you want DB-driven config
  const defaults = [
    { key: 'JSON_LOGGING_ENABLED', value: 'true' },
    { key: 'JSON_AUTO_CLEANUP_ENABLED', value: 'true' },
    { key: 'JSON_RETENTION_HOURS', value: '48' },
  ];
  for (const row of defaults) {
    await prisma.scraperConfig.upsert({
      where: { key: row.key },
      create: row,
      update: {},
    });
  }
  console.log('Seed: scraper config defaults upserted');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
