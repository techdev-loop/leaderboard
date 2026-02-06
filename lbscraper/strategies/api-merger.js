/**
 * API Response Merger
 *
 * RESPONSIBILITY: Detect and merge complementary API responses
 * - Categorize responses by content type (users, prizes, combined)
 * - Merge user data from one response with prize data from another
 * - Handle pagination (multiple user responses)
 *
 * Solves: Sites with split APIs (users in one call, prizes in another)
 */

const { log, parseNum, cleanUsername } = require('../shared/utils');

// ============================================================================
// RESPONSE TYPE DETECTION
// ============================================================================

/**
 * URL patterns that suggest response content type
 */
const URL_PATTERNS = {
  USERS: [
    /leaderboard.*users/i,
    /leaderboard.*entries/i,
    /leaderboard.*leaders/i,
    /leaderboard.*ranking/i,
    /leaderboard.*participants/i,
    /[?&]ranking/i,
    /\/players\b/i,
    /\/entries\b/i,
    /\bld-leaders\b/i,  // wrewards.com user entries endpoint
    /leaders\?.*viewState/i  // wrewards.com: leaders?casinoProvider=X&viewState=expanded
  ],
  PRIZES: [
    /leaderboard.*prizes/i,
    /leaderboard-info\?/i,  // wrewards.com: leaderboard-info?casinoProvider=X (metadata with prizes)
    /list-winner/i,  // wrewards.com: list-winner endpoint (past winners)
    /\/prize.*pool/i,
    /\/prize.*table/i,
    /\/payouts\b/i,
    /\/rewards\b(?!\.)/i  // Match /rewards but NOT WREWARDS (site name)
  ],
  COMBINED: [
    /leaderboard\/data/i,
    /leaderboard\/full/i,
    /leaderboard\/current/i,
    /leaderboard$/i
  ],
  // HISTORICAL: URLs that indicate past/historical data - should be EXCLUDED from current leaderboard extraction
  HISTORICAL: [
    /past-winners/i,              // e.g., /packdraw-leaderboard/past-winners?year=2025&month=12
    /previous-leaderboard/i,
    /history/i,
    /archived/i,
    /\byear=\d{4}.*month=/i,      // year=2025&month=12 pattern (historical date params)
    /\bmonth=\d+.*year=\d{4}/i,   // month=12&year=2025 pattern (reversed order)
    /past-results/i,
    /old-leaderboard/i,
    /finished-leaderboard/i
  ]
};

/**
 * Check if a URL indicates historical/past data that should be excluded
 * @param {string} url - URL to check
 * @returns {boolean} - True if URL is for historical data
 */
function isHistoricalUrl(url) {
  if (!url) return false;

  for (const pattern of URL_PATTERNS.HISTORICAL) {
    if (pattern.test(url)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect what type of data a response contains
 * @param {Object} data - Response data
 * @param {string} [url] - Response URL for pattern matching
 * @returns {string} - 'users' | 'prizes' | 'combined' | 'unknown'
 */
function detectResponseType(data, url = '') {
  if (!data) return 'unknown';

  // Check URL patterns first
  if (url) {
    for (const pattern of URL_PATTERNS.PRIZES) {
      if (pattern.test(url)) return 'prizes';
    }
    for (const pattern of URL_PATTERNS.USERS) {
      if (pattern.test(url)) return 'users';
    }
    for (const pattern of URL_PATTERNS.COMBINED) {
      if (pattern.test(url)) return 'combined';
    }
  }

  // Analyze data structure
  const contentType = analyzeDataContent(data);
  return contentType;
}

/**
 * Check if data is leaderboard metadata containing prize info
 * Detects patterns like: { prize1: 25000, prize2: 10000, additionalPrizes: [...], totalPrizePool: 50000 }
 * @param {Object} data - Data to check
 * @returns {boolean} - True if this is leaderboard metadata with prizes
 */
function isLeaderboardMetadata(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;

  const keys = Object.keys(data);

  // Check for numbered prize fields (prize1, prize2, prize3)
  const hasNumberedPrizes = keys.some(k => /^prize\d+$/i.test(k));

  // Check for metadata fields that indicate leaderboard config
  const metadataFields = ['totalPrizePool', 'additionalPrizes', 'prizeCount', 'startDate', 'endDate', 'durationDays'];
  const hasMetadataFields = metadataFields.some(f => data[f] !== undefined);

  // Check for state field with leaderboard values
  const hasStateField = data.state && ['ACTIVE', 'FINISHED', 'PENDING'].includes(data.state);

  return hasNumberedPrizes || (hasMetadataFields && (hasNumberedPrizes || hasStateField));
}

/**
 * Analyze data structure to determine content type
 * @param {any} data - Response data
 * @returns {string} - Content type
 */
function analyzeDataContent(data) {
  if (!data) return 'unknown';

  // Handle array of entries
  if (Array.isArray(data)) {
    if (data.length === 0) return 'unknown';
    return analyzeEntryArray(data);
  }

  // Handle object
  if (typeof data === 'object') {
    // PRIORITY 1: Check for user/entry data FIRST (before metadata)
    // This handles { "data": [{ displayName, wageredTotal, position }] } pattern
    const userKeys = ['leaderboard', 'entries', 'users', 'players', 'ranking', 'leaders', 'data'];
    for (const key of userKeys) {
      if (data[key] && Array.isArray(data[key]) && data[key].length > 0) {
        const arrayType = analyzeEntryArray(data[key]);
        if (arrayType === 'users') return 'users';
        if (arrayType === 'combined') return 'combined';
        // If array but not users/combined, continue checking other keys
      }
    }

    // PRIORITY 2: Check if data.data is a metadata object (not array) - wrewards.com pattern
    // This handles { "data": { prize1, prize2, prize3, additionalPrizes, totalPrizePool } }
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
      if (isLeaderboardMetadata(data.data)) {
        return 'prizes';  // This is a metadata response with prize info
      }
    }

    // PRIORITY 3: Check if top-level object is metadata
    if (isLeaderboardMetadata(data)) {
      return 'prizes';
    }

    // PRIORITY 4: Check for prize table keys
    const prizeKeys = [
      'prizes', 'prizeTable', 'rewards', 'payouts', 'prizePool', 'prize_table',
      'additionalPrizes', 'additional_prizes', 'totalPrizePool', 'total_prize_pool'
    ];
    for (const key of prizeKeys) {
      if (data[key] && (Array.isArray(data[key]) || typeof data[key] === 'object')) {
        return 'prizes';
      }
    }

    // PRIORITY 5: Check for numbered prize fields directly (prize1, prize2, prize3)
    const keys = Object.keys(data);
    const hasNumberedPrizes = keys.some(k => /^prize\d+$/i.test(k));
    if (hasNumberedPrizes) {
      return 'prizes';
    }

    // PRIORITY 6: Recursively check nested objects
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const nestedType = analyzeDataContent(value);
        if (nestedType !== 'unknown') return nestedType;
      }
    }
  }

  return 'unknown';
}

/**
 * Analyze an array of entries to determine if it contains users or prizes
 * @param {Array} arr - Array to analyze
 * @returns {string} - 'users' | 'prizes' | 'combined' | 'unknown'
 */
function analyzeEntryArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 'unknown';

  const sample = arr.slice(0, 5);
  let hasUsername = false;
  let hasWager = false;
  let hasPrize = false;
  let hasRank = false;

  const usernameFields = ['username', 'user', 'name', 'player', 'displayName', 'display_name'];
  const wagerFields = ['wager', 'wagered', 'amount', 'total', 'bet', 'wageredTotal', 'totalWagered', 'points', 'gpoints'];
  const prizeFields = ['prize', 'reward', 'payout', 'winnings', 'bonus', 'prizeAmount'];
  const rankFields = ['rank', 'position', 'place', 'index', 'pos'];

  for (const item of sample) {
    if (!item || typeof item !== 'object') continue;

    const keys = Object.keys(item).map(k => k.toLowerCase());

    for (const field of usernameFields) {
      if (keys.includes(field.toLowerCase())) {
        hasUsername = true;
        break;
      }
    }

    for (const field of wagerFields) {
      if (keys.includes(field.toLowerCase())) {
        hasWager = true;
        break;
      }
    }

    for (const field of prizeFields) {
      if (keys.includes(field.toLowerCase())) {
        hasPrize = true;
        break;
      }
    }

    for (const field of rankFields) {
      if (keys.includes(field.toLowerCase())) {
        hasRank = true;
        break;
      }
    }
  }

  // Determine type based on what we found
  if (hasUsername && (hasWager || hasRank)) {
    if (hasPrize) return 'combined';
    return 'users';
  }

  if (hasPrize && hasRank && !hasUsername) {
    return 'prizes';
  }

  if (hasUsername) return 'users';
  if (hasPrize) return 'prizes';

  return 'unknown';
}

// ============================================================================
// RESPONSE MERGING
// ============================================================================

/**
 * Merge multiple API responses into a unified data structure
 * @param {Array} rawJsonResponses - Array of { url, data, timestamp }
 * @param {string} [siteName] - Optional site name filter
 * @returns {Array} - Merged responses ready for extraction
 */
function mergeApiResponses(rawJsonResponses, siteName = null, knownKeywords = []) {
  if (!rawJsonResponses || rawJsonResponses.length === 0) {
    return [];
  }

  // FIRST: Filter out historical/past-winners API responses
  // These contain old leaderboard data and should not be used for current extraction
  let filteredResponses = rawJsonResponses.filter(response => {
    if (isHistoricalUrl(response.url)) {
      log('API-MERGE', `Filtering out historical API: ${response.url?.slice(-80) || 'unknown'}`);
      return false;
    }
    return true;
  });

  if (filteredResponses.length !== rawJsonResponses.length) {
    log('API-MERGE', `Filtered ${rawJsonResponses.length - filteredResponses.length} historical API response(s)`);
  }

  if (filteredResponses.length === 0) {
    log('API-MERGE', `All responses were historical, returning empty`);
    return [];
  }

  // Filter out responses that contain a DIFFERENT leaderboard name in the URL
  // This prevents using packdraw API for rainbet scraping when both are captured
  if (siteName && knownKeywords && knownKeywords.length > 0) {
    const siteNameLower = siteName.toLowerCase();
    const otherKeywords = knownKeywords
      .map(k => k.toLowerCase())
      .filter(k => k !== siteNameLower && k.length >= 3); // Exclude current site and short keywords

    filteredResponses = rawJsonResponses.filter(response => {
      if (!response.url) return true;
      const urlLower = response.url.toLowerCase();

      // Check if URL contains another leaderboard's name
      for (const keyword of otherKeywords) {
        // Match keyword as a path segment or parameter (not just substring)
        // e.g., /packdraw-leaderboard matches "packdraw", but /leaderboard doesn't match "board"
        const patterns = [
          new RegExp(`[/\\-_]${keyword}[/\\-_]`, 'i'),  // /packdraw/ or -packdraw-
          new RegExp(`[/\\-_]${keyword}$`, 'i'),        // ends with /packdraw
          new RegExp(`[/\\-_]${keyword}[?&]`, 'i'),     // /packdraw? or -packdraw&
          new RegExp(`=${keyword}(&|$)`, 'i')           // ?site=packdraw
        ];

        if (patterns.some(p => p.test(urlLower))) {
          log('API-MERGE', `Filtering out ${response.url.slice(-50)} - contains "${keyword}" but scraping "${siteName}"`);
          return false;
        }
      }
      return true;
    });

    if (filteredResponses.length !== rawJsonResponses.length) {
      log('API-MERGE', `Filtered ${rawJsonResponses.length - filteredResponses.length} API response(s) belonging to other leaderboards`);
    }
  }

  // If only one response after filtering, return as-is
  if (filteredResponses.length === 1) {
    return filteredResponses;
  }

  if (filteredResponses.length === 0) {
    log('API-MERGE', `All responses filtered out, returning empty`);
    return [];
  }

  log('API-MERGE', `Analyzing ${filteredResponses.length} API responses for merging`);

  // Categorize responses
  const categorized = {
    users: [],
    prizes: [],
    combined: [],
    unknown: []
  };

  for (const response of filteredResponses) {
    const type = detectResponseType(response.data, response.url);
    categorized[type].push(response);
    log('API-MERGE', `Response ${response.url?.slice(-50) || 'unknown'} categorized as: ${type}`);
  }

  // If we have combined responses, prefer those
  if (categorized.combined.length > 0) {
    log('API-MERGE', `Found ${categorized.combined.length} combined response(s), using those`);
    return categorized.combined;
  }

  // If we have both users and prizes, merge them
  if (categorized.users.length > 0 && categorized.prizes.length > 0) {
    log('API-MERGE', `Merging ${categorized.users.length} user response(s) with ${categorized.prizes.length} prize response(s)`);
    return mergeUsersAndPrizes(categorized.users, categorized.prizes);
  }

  // If only users, return those
  if (categorized.users.length > 0) {
    log('API-MERGE', `Using ${categorized.users.length} user response(s)`);
    return categorized.users;
  }

  // If only prizes, return those (extraction will likely fail but worth trying)
  if (categorized.prizes.length > 0) {
    log('API-MERGE', `Only prize response(s) found, no user data`);
    return categorized.prizes;
  }

  // Return all unknown for fallback
  log('API-MERGE', `No clear categorization, returning all ${categorized.unknown.length} response(s)`);
  return categorized.unknown;
}

/**
 * Merge user responses with prize responses
 * @param {Array} usersResponses - Responses containing user data
 * @param {Array} prizeResponses - Responses containing prize data
 * @returns {Array} - Merged responses
 */
function mergeUsersAndPrizes(usersResponses, prizeResponses) {
  // Extract prize table from prize responses
  const prizeTable = extractPrizeTableFromResponses(prizeResponses);

  // Create merged responses by injecting prize data into user responses
  const mergedResponses = [];

  for (const userResponse of usersResponses) {
    const mergedData = injectPrizesIntoData(userResponse.data, prizeTable);

    mergedResponses.push({
      url: userResponse.url,
      data: mergedData,
      timestamp: userResponse.timestamp,
      _merged: true,
      _prizeSource: prizeResponses[0]?.url || 'unknown'
    });
  }

  return mergedResponses;
}

/**
 * Extract prize table from prize responses
 * @param {Array} prizeResponses - Prize responses
 * @returns {Array} - Prize table [{rank, prize}] with _totalPrizePool property
 */
function extractPrizeTableFromResponses(prizeResponses) {
  const prizeTable = [];
  let totalPrizePool = 0;

  for (const response of prizeResponses) {
    const prizes = findPrizesInData(response.data);
    if (prizes.length > 0) {
      prizeTable.push(...prizes);
      // Preserve _totalPrizePool from prize data
      if (prizes._totalPrizePool && prizes._totalPrizePool > totalPrizePool) {
        totalPrizePool = prizes._totalPrizePool;
      }
    }
  }

  // Deduplicate by rank, keeping highest prize
  const byRank = new Map();
  for (const p of prizeTable) {
    if (!byRank.has(p.rank) || byRank.get(p.rank).prize < p.prize) {
      byRank.set(p.rank, p);
    }
  }

  const result = Array.from(byRank.values()).sort((a, b) => a.rank - b.rank);

  // Attach totalPrizePool as property on the array
  if (totalPrizePool > 0) {
    result._totalPrizePool = totalPrizePool;
  }

  return result;
}

/**
 * Find prizes in response data
 * Handles multiple formats:
 * - Named arrays: { prizes: [...] }
 * - Numbered fields: { prize1: 25000, prize2: 10000, prize3: 5000 }
 * - Additional prizes: { additionalPrizes: [{ prizeNumber: 4, amount: 2500 }] }
 * - Nested in data: { data: { prize1: ..., additionalPrizes: [...] } }
 * @param {any} data - Response data
 * @returns {Array} - Prize array [{rank, prize}]
 */
function findPrizesInData(data) {
  if (!data) return [];

  // Handle nested data.data structure (wrewards.com pattern)
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    const nestedPrizes = findPrizesInData(data.data);
    if (nestedPrizes.length > 0) {
      // Preserve _totalPrizePool from nested call
      return nestedPrizes;
    }
  }

  const prizes = [];

  // Extract numbered prize fields (prize1, prize2, prize3)
  if (typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    for (const key of keys) {
      const match = key.match(/^prize(\d+)$/i);
      if (match) {
        const rank = parseInt(match[1]);
        const prize = parseNum(data[key]);
        if (rank > 0 && prize > 0) {
          prizes.push({ rank, prize });
        }
      }
    }

    // Extract additionalPrizes array (wrewards.com format)
    if (data.additionalPrizes && Array.isArray(data.additionalPrizes)) {
      for (const item of data.additionalPrizes) {
        if (item && typeof item === 'object') {
          // Use parseInt to handle string values like "2" or "3"
          const rank = parseInt(item.prizeNumber || item.position || item.rank || 0);
          const prize = parseNum(item.amount || item.prize || item.value);
          // Allow prize >= 0 (some positions may have $0 prize)
          if (rank > 0 && prize >= 0) {
            prizes.push({ rank, prize });
          }
        }
      }
    }

    // Store totalPrizePool as metadata on the array
    if (data.totalPrizePool) {
      prizes._totalPrizePool = parseNum(data.totalPrizePool);
    }
  }

  // If we found numbered prizes, return them
  if (prizes.length > 0) {
    return prizes.sort((a, b) => a.rank - b.rank);
  }

  // Fall back to checking named prize keys
  const prizeKeys = ['prizes', 'prizeTable', 'rewards', 'payouts', 'prizePool', 'prize_table', 'reward_table'];
  for (const key of prizeKeys) {
    const value = data[key];
    if (value) {
      return parsePrizeValue(value);
    }
  }

  // Check nested objects
  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && key !== 'data') {
        const nested = findPrizesInData(value);
        if (nested.length > 0) return nested;
      }
    }
  }

  return [];
}

/**
 * Parse prize value into array
 * @param {any} value - Prize value
 * @returns {Array} - Prize array
 */
function parsePrizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item === 'number') {
        return { rank: index + 1, prize: item };
      }
      return {
        rank: item.rank || item.position || index + 1,
        prize: parseNum(item.prize || item.reward || item.amount || item.value || item)
      };
    }).filter(p => p.prize > 0);
  }

  if (typeof value === 'object') {
    const prizes = [];
    for (const [rank, prize] of Object.entries(value)) {
      const rankNum = parseInt(rank);
      if (!isNaN(rankNum) && rankNum > 0) {
        prizes.push({ rank: rankNum, prize: parseNum(prize) });
      }
    }
    return prizes.sort((a, b) => a.rank - b.rank);
  }

  return [];
}

/**
 * Inject prize data into user data
 * @param {any} userData - User data
 * @param {Array} prizeTable - Prize table
 * @returns {any} - Merged data
 */
function injectPrizesIntoData(userData, prizeTable) {
  if (!userData || prizeTable.length === 0) return userData;

  // Create a prize lookup by rank
  const prizeLookup = new Map(prizeTable.map(p => [p.rank, p.prize]));

  // Deep clone to avoid mutating original
  const merged = JSON.parse(JSON.stringify(userData));

  // Add prize table to merged data
  merged._mergedPrizes = prizeTable;

  // Try to inject prizes into entries
  const entriesArrays = findEntriesArrays(merged);

  for (const arr of entriesArrays) {
    for (const entry of arr) {
      if (entry && typeof entry === 'object') {
        const rank = entry.rank || entry.position || entry.place;
        if (rank && prizeLookup.has(rank)) {
          entry.prize = prizeLookup.get(rank);
          entry._prizeInjected = true;
        }
      }
    }
  }

  return merged;
}

/**
 * Find arrays of entries in data structure
 * @param {any} data - Data to search
 * @returns {Array} - Arrays found
 */
function findEntriesArrays(data) {
  const arrays = [];

  if (Array.isArray(data)) {
    arrays.push(data);
    return arrays;
  }

  if (typeof data === 'object' && data !== null) {
    const entryKeys = ['leaderboard', 'entries', 'users', 'players', 'ranking', 'leaders', 'data', 'results'];
    for (const key of entryKeys) {
      if (data[key] && Array.isArray(data[key])) {
        arrays.push(data[key]);
      }
    }

    // Recurse into nested objects
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        arrays.push(...findEntriesArrays(value));
      }
    }
  }

  return arrays;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main function
  mergeApiResponses,

  // Detection helpers
  detectResponseType,
  analyzeDataContent,
  analyzeEntryArray,
  isLeaderboardMetadata,
  isHistoricalUrl,

  // Merging helpers
  mergeUsersAndPrizes,
  extractPrizeTableFromResponses,
  findPrizesInData,
  parsePrizeValue,
  injectPrizesIntoData,
  findEntriesArrays,

  // Constants
  URL_PATTERNS
};
