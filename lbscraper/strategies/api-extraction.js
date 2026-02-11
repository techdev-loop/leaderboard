/**
 * API Extraction Strategy
 *
 * RESPONSIBILITY: Extract leaderboard entries from intercepted API responses
 * - Parse JSON responses for leaderboard data
 * - Find entries in nested structures
 * - Extract prize tables
 * - Score response quality
 *
 * Priority: 1 (highest - most reliable when available)
 */

const { log, parseNum, cleanUsername } = require('../shared/utils');

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

const strategy = {
  name: 'api',
  priority: 1,

  /**
   * Check if this strategy can extract from the given input
   * @param {Object} input - Extraction input
   * @returns {boolean}
   */
  canExtract(input) {
    return input.rawJsonResponses && input.rawJsonResponses.length > 0;
  },

  /**
   * Extract leaderboard entries from API responses
   * @param {Object} input - Extraction input
   * @returns {Promise<Object|null>} - Extraction result or null
   */
  async extract(input) {
    const { rawJsonResponses, siteName } = input;
    log('API-EXTRACT', 'Trying API extraction strategy...');

    let bestResult = null;
    let bestScore = 0;

    for (const response of rawJsonResponses) {
      try {
        const result = findLeaderboardInResponse(response.data, siteName);

        if (result && result.entries.length > 0) {
          const score = scoreLeaderboardQuality(result.entries);

          if (score > bestScore) {
            bestScore = score;
            bestResult = {
              ...result,
              apiUrl: response.url,
              timestamp: response.timestamp
            };
          }
        }
      } catch (e) {
        log('API-EXTRACT', `Error parsing response: ${e.message}`);
      }
    }

    if (bestResult && bestResult.entries.length > 0) {
      // Calculate confidence based on quality
      const confidence = Math.min(95, 70 + Math.min(25, bestResult.entries.length * 2));

      log('API-EXTRACT', `Found ${bestResult.entries.length} entries (confidence: ${confidence})`);

      return {
        entries: bestResult.entries,
        prizes: bestResult.prizes || [],
        confidence,
        apiUrl: bestResult.apiUrl,
        metadata: {
          responseCount: rawJsonResponses.length,
          selectedUrl: bestResult.apiUrl
        }
      };
    }

    log('API-EXTRACT', 'No valid leaderboard data found in API responses');
    return null;
  }
};

// ============================================================================
// LEADERBOARD DETECTION
// ============================================================================

/**
 * Find leaderboard data in an API response
 * @param {any} data - API response data
 * @param {string} [siteName] - Optional site name filter
 * @returns {Object|null} - { entries, prizes, url } or null
 */
function findLeaderboardInResponse(data, siteName = null) {
  if (!data) return null;

  // Handle array of entries directly
  if (Array.isArray(data)) {
    const entries = extractEntriesFromArray(data);
    if (entries.length >= 2) {
      let prizes = extractPrizeTable(data);
      const fromEntries = buildPrizeTableFromEntries(entries);
      if (fromEntries.length > 0) prizes = mergePrizeTables(prizes, fromEntries);
      return { entries, prizes };
    }
  }

  // Handle object with leaderboard property
  if (typeof data === 'object') {
    // Check for split format: top_three + rest_of_users (dustintfp.com) or topThree + rest (ilovemav-style)
    const topKey = data.top_three ? 'top_three' : (data.topThree ? 'topThree' : null);
    const restKey = data.rest_of_users ? 'rest_of_users' : (data.rest ? 'rest' : (data.restOfUsers ? 'restOfUsers' : null));
    if (topKey && restKey && Array.isArray(data[topKey]) && Array.isArray(data[restKey])) {
      const topEntries = extractEntriesFromArray(data[topKey]);
      const restEntries = extractEntriesFromArray(data[restKey]);
      topEntries.forEach((e, i) => { if (!e.rank) e.rank = i + 1; });
      restEntries.forEach((e, i) => { if (!e.rank) e.rank = i + 4; });
      const combined = [...topEntries, ...restEntries];
      if (combined.length >= 2) {
        let prizes = extractPrizeTable(data);
        const fromEntries = buildPrizeTableFromEntries(combined);
        if (fromEntries.length > 0) prizes = mergePrizeTables(prizes, fromEntries);
        log('API-EXTRACT', `Found split format (${topKey} + ${restKey}): ${combined.length} entries`);
        return { entries: combined, prizes };
      }
    }

    // Check common leaderboard property names
    const leaderboardKeys = [
      'leaderboard', 'leaderboards', 'leaders', 'ranking', 'rankings',
      'entries', 'users', 'players', 'winners', 'data', 'results',
      'participants', 'top', 'list', 'items', 'members',
      'wagers',  // prodigyddk.com uses this
      'top_three', 'rest_of_users'  // dustintfp.com split format (individual arrays)
    ];

    // First try direct properties
    for (const key of leaderboardKeys) {
      if (data[key] && Array.isArray(data[key])) {
        const entries = extractEntriesFromArray(data[key]);
        if (entries.length >= 2) {
          let prizes = extractPrizeTable(data);
          const fromEntries = buildPrizeTableFromEntries(entries);
          if (fromEntries.length > 0) prizes = mergePrizeTables(prizes, fromEntries);
          return { entries, prizes };
        }
      }
    }

    // Fallback: try ANY top-level array (e.g. ilovemav.com/api/chickengg with unknown key)
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value) && value.length >= 2) {
        const entries = extractEntriesFromArray(value);
        if (entries.length >= 2) {
          let prizes = extractPrizeTable(data);
          const fromEntries = buildPrizeTableFromEntries(entries);
          if (fromEntries.length > 0) prizes = mergePrizeTables(prizes, fromEntries);
          log('API-EXTRACT', `Found leaderboard array at key "${key}": ${entries.length} entries`);
          return { entries, prizes };
        }
      }
    }

    // Try nested structures (e.g., data.result.leaderboard)
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const result = findLeaderboardInResponse(value, siteName);
        if (result && result.entries.length >= 2) {
          return result;
        }
      }
    }
  }

  return null;
}

// ============================================================================
// ENTRY EXTRACTION
// ============================================================================

/**
 * Extract entries from an array of user objects
 * @param {Array} arr - Array of potential entry objects
 * @returns {Array} - Standardized entries
 */
function extractEntriesFromArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];

  const entries = [];

  // Field name mappings
  const usernameFields = [
    'username', 'user', 'name', 'player', 'nickname', 'displayName',
    'display_name', 'userName', 'playerName', 'user_name'
  ];
  const wagerFields = [
    'wager', 'wagered', 'amount', 'total', 'bet', 'volume',
    'totalWager', 'total_wager', 'wagerAmount', 'bets',
    'wageredTotal', 'totalWagered', 'wagered_total', 'total_wagered',
    'points', 'gpoints', 'balance', 'score', 'value', 'coins',
    'xp', 'experience', 'level', 'deposited', 'spent'
  ];
  const prizeFields = [
    'prize', 'reward', 'payout', 'winnings', 'bonus',
    'prizeAmount', 'prize_amount', 'rewards', 'rewardAmount',
    'payoutAmount', 'winningsAmount', 'bonusAmount',
    'rankPrize', 'positionPrize', 'prizeValue', 'rewardValue'
  ];
  const rankFields = [
    'rank', 'position', 'place', 'index', 'pos',
    'placement'  // prodigyddk.com uses this
  ];

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;

    // Extract username
    let username = null;
    for (const field of usernameFields) {
      const value = getNestedValue(item, field);
      if (value && typeof value === 'string' && value.length >= 2) {
        username = cleanUsername(value);
        break;
      }
    }

    if (!username) continue;

    // Extract wager
    let wager = 0;
    for (const field of wagerFields) {
      const value = getNestedValue(item, field);
      if (value !== undefined) {
        wager = parseNum(value);
        if (wager > 0) break;
      }
    }

    // Extract prize
    let prize = 0;
    for (const field of prizeFields) {
      const value = getNestedValue(item, field);
      if (value !== undefined) {
        prize = parseNum(value);
        if (prize > 0) break;
      }
    }

    // Extract rank
    let rank = i + 1; // Default to array position
    for (const field of rankFields) {
      const value = getNestedValue(item, field);
      if (value !== undefined && typeof value === 'number' && value > 0) {
        rank = value;
        break;
      }
    }

    entries.push({
      rank,
      username,
      wager,
      prize,
      source: 'api'
    });
  }

  // Sort by rank
  entries.sort((a, b) => a.rank - b.rank);

  // Re-number if ranks are not sequential
  const hasSequentialRanks = entries.every((e, i) => e.rank === i + 1);
  if (!hasSequentialRanks) {
    entries.forEach((e, i) => e.rank = i + 1);
  }

  return entries;
}

/**
 * Get a nested value from an object
 * @param {Object} obj - Source object
 * @param {string} field - Field name (supports dot notation)
 * @returns {any}
 */
function getNestedValue(obj, field) {
  // Direct access
  if (obj[field] !== undefined) return obj[field];

  // Case-insensitive lookup
  const lowerField = field.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lowerField) {
      return obj[key];
    }
  }

  // Nested lookup (e.g., "user.name")
  if (field.includes('.')) {
    const parts = field.split('.');
    let value = obj;
    for (const part of parts) {
      if (value && typeof value === 'object') {
        value = value[part];
      } else {
        return undefined;
      }
    }
    return value;
  }

  return undefined;
}

// ============================================================================
// PRIZE TABLE EXTRACTION
// ============================================================================

/**
 * Extract prize table from API response
 * @param {Object} data - API response data
 * @returns {Array} - Prize table [{rank, prize}] with optional _totalPrizePool
 */
function extractPrizeTable(data) {
  if (!data || typeof data !== 'object') return [];

  // PRIORITY: Check for merged prizes from API merger (has _totalPrizePool)
  if (data._mergedPrizes && Array.isArray(data._mergedPrizes) && data._mergedPrizes.length > 0) {
    const result = [...data._mergedPrizes];
    if (data._mergedPrizes._totalPrizePool) {
      result._totalPrizePool = data._mergedPrizes._totalPrizePool;
    }
    return result;
  }

  const prizeKeys = [
    'prizes', 'prizeTable', 'rewards', 'payouts',
    'prizePool', 'prize_table', 'reward_table',
    'topPrizes', 'top_three_prizes', 'rewardTiers', 'prizeTiers',
    'prizeBreakdown', 'leaderboardPrizes', 'prizeStructure'
  ];

  for (const key of prizeKeys) {
    const value = data[key];

    if (Array.isArray(value)) {
      const table = value.map((item, index) => {
        if (typeof item === 'number') {
          return { rank: index + 1, prize: parseNum(item) };
        }
        return {
          rank: item.rank || item.position || index + 1,
          prize: parseNum(item.prize || item.reward || item.amount || item)
        };
      });
      // Include all ranks (even 0) so rank 4+ get correct value when API provides it
      return table.filter(p => p.rank >= 1).sort((a, b) => a.rank - b.rank);
    }

    if (typeof value === 'object' && value !== null) {
      // Handle object format: { "1": 1000, "2": 500, ... }
      const prizes = [];
      for (const [rank, prize] of Object.entries(value)) {
        const rankNum = parseInt(rank);
        if (!isNaN(rankNum) && rankNum > 0) {
          prizes.push({ rank: rankNum, prize: parseNum(prize) });
        }
      }
      if (prizes.length > 0) {
        return prizes.sort((a, b) => a.rank - b.rank);
      }
    }
  }

  // Fallback: any top-level array of numbers (rank = index + 1), e.g. [525, 350, 225, 100, ...]
  for (const [k, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length >= 4 && value.length <= 150) {
      const allNumbers = value.every(v => typeof v === 'number' && v >= 0);
      if (allNumbers) {
        const table = value.map((prize, index) => ({ rank: index + 1, prize: parseNum(prize) }));
        return table.filter(p => p.rank >= 1).sort((a, b) => a.rank - b.rank);
      }
    }
  }

  return [];
}

/**
 * Build prize table from entries that have rank and prize > 0 only.
 * We only include ranks with non-zero prize so we don't overwrite fused podium prizes
 * (e.g. from markdown) with a full table of zeros when the API has no prize per entry.
 * When the API does provide prize for rank 4+, those are included.
 * @param {Array} entries - Extracted entries
 * @returns {Array} - Prize table [{rank, prize}] for ranks with prize > 0
 */
function buildPrizeTableFromEntries(entries) {
  if (!entries || entries.length === 0) return [];
  const table = [];
  for (const e of entries) {
    const r = e.rank != null ? Number(e.rank) : 0;
    const p = e.prize != null ? parseNum(e.prize) : 0;
    if (r >= 1 && p > 0) {
      table.push({ rank: r, prize: p });
    }
  }
  return table.sort((a, b) => a.rank - b.rank);
}

/**
 * Merge two prize tables; prefer non-zero values so we don't overwrite podium with zeros.
 * @param {Array} fromData - From extractPrizeTable(data)
 * @param {Array} fromEntries - From buildPrizeTableFromEntries(entries) (only ranks with prize > 0)
 * @returns {Array} - Merged table
 */
function mergePrizeTables(fromData, fromEntries) {
  if (!fromEntries || fromEntries.length === 0) return fromData || [];
  if (!fromData || fromData.length === 0) return fromEntries;
  const maxRank = Math.max(
    Math.max(...fromData.map(p => p.rank), 0),
    Math.max(...fromEntries.map(p => p.rank), 0)
  );
  const merged = [];
  for (let r = 1; r <= maxRank; r++) {
    const fromD = fromData.find(p => p.rank === r);
    const fromE = fromEntries.find(p => p.rank === r);
    const prizeD = fromD && fromD.prize != null ? fromD.prize : 0;
    const prizeE = fromE && fromE.prize != null ? fromE.prize : 0;
    const prize = prizeE > 0 ? prizeE : (prizeD > 0 ? prizeD : prizeD || prizeE);
    merged.push({ rank: r, prize });
  }
  return merged;
}

// ============================================================================
// QUALITY SCORING
// ============================================================================

/**
 * Score the quality of extracted leaderboard entries
 * @param {Array} entries - Extracted entries
 * @returns {number} - Quality score (0-100)
 */
function scoreLeaderboardQuality(entries) {
  if (!entries || entries.length === 0) return 0;

  let score = 0;

  // Entry count - more entries is always better (no cap)
  // Use logarithmic scale to still favor more entries but not overwhelm other factors
  score += entries.length * 2;

  // All have usernames (20 points)
  const hasUsernames = entries.every(e => e.username && e.username.length >= 2);
  if (hasUsernames) score += 20;

  // Has wagers (20 points)
  const withWagers = entries.filter(e => e.wager > 0);
  if (withWagers.length > 0) {
    score += Math.min(20, (withWagers.length / entries.length) * 20);
  }

  // Has prizes (15 points)
  const withPrizes = entries.filter(e => e.prize > 0);
  if (withPrizes.length > 0) {
    score += Math.min(15, (withPrizes.length / entries.length) * 15);
  }

  // Sequential ranks (15 points)
  const hasSequentialRanks = entries.every((e, i) => e.rank === i + 1);
  if (hasSequentialRanks) score += 15;

  return Math.min(100, Math.round(score));
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  strategy,

  // Helper functions (for testing/reuse)
  findLeaderboardInResponse,
  extractEntriesFromArray,
  extractPrizeTable,
  scoreLeaderboardQuality,
  getNestedValue
};
