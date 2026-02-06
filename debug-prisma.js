const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: ['query', 'error', 'warn']
});

async function test() {
  const data = JSON.parse(fs.readFileSync('lbscraper/results/current/wrewards.com.json'));

  // Get first leaderboard with entries
  const lb = data.results.find(r => r.entries?.length > 0);
  if (!lb) {
    console.log('No entries found');
    return;
  }

  console.log(`Testing with ${lb.name}: ${lb.entries.length} entries`);

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

  // Try inserting entries one by one to find the problematic one
  for (let i = 0; i < lb.entries.length; i++) {
    const e = lb.entries[i];
    const entry = {
      snapshotId: snapshot.id,
      rank: parseInt(e.rank) || 0,
      username: String(e.username || 'unknown').substring(0, 100),
      wager: parseFloat(e.wager) || 0,
      prize: parseFloat(e.prize) || 0,
      verified: Boolean(e._verified)
    };

    try {
      await prisma.leaderboardEntry.create({ data: entry });
    } catch (err) {
      console.log(`\nFAILED at entry ${i}:`);
      console.log('  username:', JSON.stringify(e.username));
      console.log('  rank:', e.rank);
      console.log('  wager:', e.wager);
      console.log('  error:', err.message.substring(0, 200));

      // Check each character
      const username = String(e.username || '');
      console.log('  username chars:');
      for (let j = 0; j < Math.min(username.length, 50); j++) {
        const c = username.charCodeAt(j);
        if (c < 32 || c > 126) {
          console.log(`    pos ${j}: code ${c} (0x${c.toString(16)})`);
        }
      }
      break;
    }
  }

  // Clean up
  await prisma.leaderboardSnapshot.delete({ where: { id: snapshot.id } });
  console.log('\nCleaned up test data');

  await prisma.$disconnect();
}

test().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
