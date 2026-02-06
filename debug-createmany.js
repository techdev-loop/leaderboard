const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function test() {
  const data = JSON.parse(fs.readFileSync('lbscraper/results/current/wrewards.com.json'));

  // Get first leaderboard with entries
  const lb = data.results.find(r => r.entries?.length > 0);
  if (!lb) {
    console.log('No entries found');
    return;
  }

  console.log(`Testing createMany with ${lb.name}: ${lb.entries.length} entries`);

  // Get or create a test snapshot
  const site = await prisma.leaderboardSite.findFirst();
  if (!site) {
    console.log('No site found');
    return;
  }

  let cycle = await prisma.leaderboardCycle.findFirst({ where: { siteId: site.id } });
  if (!cycle) {
    cycle = await prisma.leaderboardCycle.create({
      data: {
        siteId: site.id,
        siteName: 'test',
        cycleNumber: 1,
        startedAt: new Date()
      }
    });
  }

  const snapshot = await prisma.leaderboardSnapshot.create({
    data: {
      cycleId: cycle.id,
      confidence: 100,
      extractionMethod: 'test',
      totalWager: 0,
      apiValidated: false
    }
  });

  console.log('Created snapshot:', snapshot.id);

  // Prepare entries
  const entries = lb.entries.map(e => ({
    snapshotId: snapshot.id,
    rank: parseInt(e.rank) || 0,
    username: String(e.username || 'unknown').substring(0, 100),
    wager: parseFloat(e.wager) || 0,
    prize: parseFloat(e.prize) || 0,
    verified: Boolean(e._verified)
  }));

  console.log('Prepared', entries.length, 'entries');

  // Show the raw JSON that will be sent
  const jsonPayload = JSON.stringify(entries);
  console.log('JSON payload length:', jsonPayload.length);
  console.log('Characters around position 970-1010:', jsonPayload.substring(970, 1010));

  // Check for \x patterns in the JSON
  const hexMatch = jsonPayload.match(/\\x[0-9a-fA-F]{0,2}/g);
  if (hexMatch) {
    console.log('Found hex patterns:', hexMatch);
    const idx = jsonPayload.indexOf(hexMatch[0]);
    console.log('Context around first match:', jsonPayload.substring(idx - 50, idx + 50));
  }

  try {
    await prisma.leaderboardEntry.createMany({ data: entries });
    console.log('SUCCESS! createMany worked');
  } catch (err) {
    console.log('FAILED:', err.message.substring(0, 300));
  }

  // Clean up
  await prisma.leaderboardSnapshot.delete({ where: { id: snapshot.id } });
  console.log('Cleaned up');

  await prisma.$disconnect();
}

test().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
