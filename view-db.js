const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function viewData() {
  console.log('=== LEADERBOARD SITES ===');
  const sites = await prisma.leaderboardSite.findMany({
    select: { id: true, domain: true, name: true, lastScrapedAt: true, errorCount: true }
  });
  console.table(sites);

  console.log('\n=== LEADERBOARD CYCLES ===');
  const cycles = await prisma.leaderboardCycle.findMany({
    select: { id: true, siteName: true, cycleNumber: true, startedAt: true }
  });
  console.table(cycles);

  console.log('\n=== RECENT SNAPSHOTS (last 10) ===');
  const snapshots = await prisma.leaderboardSnapshot.findMany({
    take: 10,
    orderBy: { scrapedAt: 'desc' },
    select: { id: true, confidence: true, extractionMethod: true, totalWager: true, scrapedAt: true }
  });
  console.table(snapshots);

  console.log('\n=== ENTRY COUNTS BY SNAPSHOT ===');
  const entryCounts = await prisma.leaderboardEntry.groupBy({
    by: ['snapshotId'],
    _count: { id: true }
  });
  console.table(entryCounts.slice(0, 10));

  console.log('\n=== SAMPLE ENTRIES (first 20) ===');
  const entries = await prisma.leaderboardEntry.findMany({
    take: 20,
    orderBy: { scrapedAt: 'desc' },
    select: { rank: true, username: true, wager: true, prize: true, scrapedAt: true }
  });
  console.table(entries);

  console.log('\n=== TOTALS ===');
  const totalSites = await prisma.leaderboardSite.count();
  const totalCycles = await prisma.leaderboardCycle.count();
  const totalSnapshots = await prisma.leaderboardSnapshot.count();
  const totalEntries = await prisma.leaderboardEntry.count();
  console.log(`Sites: ${totalSites}`);
  console.log(`Cycles: ${totalCycles}`);
  console.log(`Snapshots: ${totalSnapshots}`);
  console.log(`Entries: ${totalEntries}`);

  await prisma.$disconnect();
}

viewData().catch(e => {
  console.error(e);
  process.exit(1);
});
