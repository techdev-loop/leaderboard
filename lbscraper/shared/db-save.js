const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Sanitize string - remove ALL problematic characters for PostgreSQL
 * Handles null bytes, control chars, incomplete hex escapes, backslash issues,
 * and unpaired Unicode surrogates (incomplete emoji sequences)
 */
function sanitizeString(str, maxLength = 100, defaultValue = 'unknown') {
  if (str == null) return defaultValue;

  let result = String(str);

  // Replace backslash-x sequences that could cause hex escape issues
  result = result.replace(/\\+x[0-9a-fA-F]*/gi, '');

  // Remove actual null bytes and control characters (ASCII 0-31, 127)
  result = result.replace(/[\x00-\x1F\x7F]/g, '');

  // Remove any remaining backslashes followed by problematic chars
  result = result.replace(/\\[^nrt"\\]/g, '');

  // Remove unpaired Unicode surrogates (broken emoji/special chars)
  // High surrogates: \uD800-\uDBFF, Low surrogates: \uDC00-\uDFFF
  // Remove high surrogate not followed by low surrogate
  result = result.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '');
  // Remove low surrogate not preceded by high surrogate
  result = result.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

  // Truncate and return
  result = result.substring(0, maxLength).trim();

  return result || defaultValue;
}

/**
 * Safely parse a number, returning 0 for invalid values
 */
function safeNumber(val) {
  if (val == null) return 0;
  const num = parseFloat(val);
  return isNaN(num) ? 0 : num;
}

/**
 * Save scrape results to database
 * Auto-creates site if it doesn't exist
 */
async function saveToDatabase(domain, result) {
  // 1. Find or create LeaderboardSite
  let site = await prisma.leaderboardSite.findUnique({
    where: { domain }
  });

  if (!site) {
    site = await prisma.leaderboardSite.create({
      data: {
        domain,
        name: domain.replace(/\.(com|gg|net|io|bet)$/, ''),
        isActive: true,
        errorCount: 0
      }
    });
    console.log(`[DB] Created new site: ${domain}`);
  }

  let snapshotCount = 0;
  let entryCount = 0;

  // 2. For each leaderboard result, create cycle + snapshot + entries
  for (const lb of result.results || []) {
    // Find or create cycle (simplified - one cycle per site/name combo)
    let cycle = await prisma.leaderboardCycle.findFirst({
      where: { siteId: site.id, siteName: lb.name || 'default' },
      orderBy: { startedAt: 'desc' }
    });

    if (!cycle) {
      cycle = await prisma.leaderboardCycle.create({
        data: {
          siteId: site.id,
          siteName: lb.name || 'default',
          cycleNumber: 1,
          startedAt: new Date()
        }
      });
    }

    // 3. Create snapshot
    const snapshot = await prisma.leaderboardSnapshot.create({
      data: {
        cycleId: cycle.id,
        confidence: lb.confidence || 0,
        extractionMethod: lb.source || 'unknown',
        totalWager: lb.totalWagered || 0,
        prizePool: lb.totalPrizePool || null,
        apiValidated: lb.source === 'api'
      }
    });
    snapshotCount++;

    // 4. Insert entries one by one (createMany has issues with some character encodings)
    if (lb.entries?.length > 0) {
      for (const e of lb.entries) {
        try {
          await prisma.leaderboardEntry.create({
            data: {
              snapshotId: snapshot.id,
              rank: parseInt(e.rank) || 0,
              username: sanitizeString(e.username, 100, 'unknown'),
              wager: safeNumber(e.wager),
              prize: safeNumber(e.prize),
              verified: Boolean(e._verified)
            }
          });
          entryCount++;
        } catch (entryErr) {
          console.log(`[DB-WARN] Failed to insert entry rank ${e.rank}: ${entryErr.message.substring(0, 100)}`);
        }
      }
    }
  }

  // 5. Update site lastScrapedAt
  await prisma.leaderboardSite.update({
    where: { id: site.id },
    data: {
      lastScrapedAt: new Date(),
      errorCount: 0,
      lastError: null
    }
  });

  return { siteId: site.id, domain, snapshotCount, entryCount };
}

async function disconnect() {
  await prisma.$disconnect();
}

module.exports = { saveToDatabase, disconnect, prisma };
