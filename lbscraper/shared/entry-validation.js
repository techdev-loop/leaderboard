/**
 * Validation Module for Leaderboard Scraper
 * 
 * Handles confidence scoring, duplicate detection, and entry validation
 */

const { log, validateUsername, isUIText } = require('./utils');

// ============================================================================
// GLOBAL ENTRIES TRACKER
// ============================================================================

/**
 * Global tracker for entries across all sites in current run
 * Used to detect cross-site contamination
 */
const globalEntriesTracker = new Map();

/**
 * Clear the global entries tracker
 */
function clearGlobalEntriesTracker() {
  globalEntriesTracker.clear();
}

/**
 * Check if entries were already seen for a different site
 * @param {string} siteName - Current site name
 * @param {Array} entries - Entries to check
 * @returns {Array} - Array of contamination objects
 */
function checkCrossSiteContamination(siteName, entries) {
  const contamination = [];
  
  for (const entry of entries) {
    const key = entry.username.toLowerCase();
    const previousSite = globalEntriesTracker.get(key);
    
    if (previousSite && previousSite !== siteName.toLowerCase()) {
      contamination.push({
        username: entry.username,
        previousSite,
        currentSite: siteName
      });
    }
  }
  
  if (contamination.length > 0) {
    log('DUP', `Cross-site contamination detected: ${contamination.length} users`, contamination.slice(0, 3));
  }
  
  return contamination;
}

/**
 * Register entries for a site in the global tracker
 * @param {string} siteName - Site name
 * @param {Array} entries - Entries to register
 */
function registerEntriesForSite(siteName, entries) {
  for (const entry of entries) {
    globalEntriesTracker.set(entry.username.toLowerCase(), siteName.toLowerCase());
  }
}

// ============================================================================
// DUPLICATE DETECTION
// ============================================================================

/**
 * Detect if current entries are duplicates of previous entries
 * @param {Array} previousEntries - Previous site's entries
 * @param {Array} currentEntries - Current entries to check
 * @param {number} duplicateThreshold - Threshold ratio (0-1)
 * @returns {Object} - { isDuplicate, matchRatio, matchedUsernames }
 */
function detectDuplicateData(previousEntries, currentEntries, duplicateThreshold = 0.7) {
  if (!previousEntries || previousEntries.length === 0) {
    return { isDuplicate: false, matchRatio: 0, matchedUsernames: [] };
  }
  
  if (!currentEntries || currentEntries.length === 0) {
    return { isDuplicate: false, matchRatio: 0, matchedUsernames: [] };
  }
  
  const prevUsernames = new Set(previousEntries.map(e => e.username.toLowerCase()));
  const matchedUsernames = [];
  
  for (const entry of currentEntries) {
    if (prevUsernames.has(entry.username.toLowerCase())) {
      matchedUsernames.push(entry.username);
    }
  }
  
  const matchRatio = matchedUsernames.length / Math.max(previousEntries.length, currentEntries.length);
  const isDuplicate = matchRatio >= duplicateThreshold;
  
  if (isDuplicate) {
    log('DUP', `Duplicate data detected! ${matchedUsernames.length}/${currentEntries.length} usernames match (${Math.round(matchRatio * 100)}%)`);
  }
  
  return { isDuplicate, matchRatio, matchedUsernames };
}

// ============================================================================
// CONFIDENCE SCORING
// ============================================================================

/**
 * Calculate confidence score for extracted entries
 * @param {Array} entries - Extracted entries
 * @param {Array} apiData - API entries for comparison
 * @param {Array} domData - DOM entries for comparison
 * @param {boolean} timerFound - Whether timer was detected
 * @param {Object} options - Options including siteValidated, production mode settings, crossValidation
 * @returns {Object} - { score, penalties, checks, manualReview }
 */
function calculateConfidence(entries, apiData, domData, timerFound, options = {}) {
  const {
    siteValidated,
    productionEnabled = false,
    productionMinConfidence = 70,
    validationMinConfidence = 85,
    requirePrizeForTop3 = true,
    llmVerified = false,
    llmConfidence = null,
    crossValidation = null  // NEW: Cross-validation report from fusion layer
  } = options;
  
  let score = 0;
  const penalties = [];
  const checks = {};
  
  const usernames = entries.map(e => e.username.toLowerCase());
  const uniqueCount = new Set(usernames).size;
  
  if (entries.length === 10 && uniqueCount === 10) {
    score += 30;
    checks.uniqueCount = 'PASS';
  } else if (entries.length >= 7 && uniqueCount >= 7) {
    score += 15;
    checks.uniqueCount = 'PARTIAL';
    penalties.push(`count: ${entries.length}/10, unique: ${uniqueCount}`);
  } else {
    checks.uniqueCount = 'FAIL';
    penalties.push(`count: ${entries.length}/10, unique: ${uniqueCount}`);
  }
  
  // Check wager ordering
  let wagersDescending = true;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].wager > entries[i - 1].wager) {
      wagersDescending = false;
      break;
    }
  }
  
  if (wagersDescending) {
    score += 30;
    checks.wagerOrder = 'PASS';
  } else {
    checks.wagerOrder = 'FAIL';
    penalties.push('wager_order_violation');
  }
  
  // Source agreement check - use cross-validation if available
  if (crossValidation && crossValidation.overallAgreement !== undefined) {
    // Use new fusion layer cross-validation
    const agreement = crossValidation.overallAgreement;

    if (agreement >= 0.9) {
      score += 30;
      checks.sourceAgreement = 'STRONG';
      log('VAL', `Cross-validation strong agreement: ${(agreement * 100).toFixed(0)}%`);
    } else if (agreement >= 0.7) {
      score += 20;
      checks.sourceAgreement = 'PASS';
      log('VAL', `Cross-validation pass: ${(agreement * 100).toFixed(0)}%`);
    } else if (agreement >= 0.5) {
      score += 10;
      checks.sourceAgreement = 'PARTIAL';
      penalties.push(`cross_validation: ${(agreement * 100).toFixed(0)}%`);
    } else {
      checks.sourceAgreement = 'WEAK';
      penalties.push(`low_cross_validation: ${(agreement * 100).toFixed(0)}%`);
    }

    // Add discrepancy penalty
    if (crossValidation.discrepancies && crossValidation.discrepancies.length > 5) {
      score -= 10;
      penalties.push(`discrepancies: ${crossValidation.discrepancies.length}`);
    }
  } else if (apiData && apiData.length > 0 && domData && domData.length > 0) {
    // Fallback to legacy API vs DOM comparison
    const apiUsernames = new Set(apiData.map(e => e.username.toLowerCase()));
    const domUsernames = new Set(domData.map(e => e.username.toLowerCase()));

    let matches = 0;
    for (const name of apiUsernames) {
      if (domUsernames.has(name)) matches++;
    }

    if (matches >= 8) {
      score += 30;
      checks.sourceAgreement = 'PASS';
    } else if (matches >= 5) {
      score += 15;
      checks.sourceAgreement = 'PARTIAL';
      penalties.push(`source_match: ${matches}/10`);
    } else {
      checks.sourceAgreement = 'FAIL';
      penalties.push(`source_mismatch: ${matches}/10`);
    }
  } else {
    score += 15;
    checks.sourceAgreement = 'SINGLE_SOURCE';
  }
  
  // Timer check
  if (timerFound) {
    score += 10;
    checks.timerFound = 'PASS';
  } else {
    checks.timerFound = 'MISSING';
  }
  
  // Garbage check
  let hasGarbage = false;
  for (const entry of entries) {
    if (isUIText(entry.username)) {
      hasGarbage = true;
      penalties.push(`garbage_username: "${entry.username}"`);
    }
  }
  
  if (hasGarbage) {
    score = 0;
    checks.garbageCheck = 'FAIL';
  } else {
    checks.garbageCheck = 'PASS';
  }
  
  // Prize validation for top 3
  if (requirePrizeForTop3) {
    const top3 = entries.slice(0, 3);
    const top3MissingPrize = top3.filter(e => !e.prize || e.prize <= 0);
    
    if (top3MissingPrize.length === 0) {
      checks.prizeValidation = 'PASS';
    } else if (top3MissingPrize.length <= 1) {
      checks.prizeValidation = 'PARTIAL';
      penalties.push(`top3_missing_prize: ${top3MissingPrize.length}`);
    } else {
      checks.prizeValidation = 'FAIL';
      penalties.push(`top3_missing_prize: ${top3MissingPrize.length}`);
      if (productionEnabled) {
        score -= 10;
      }
    }
  }
  
  // Site validation check
  if (siteValidated) {
    score += 5;
    checks.siteValidation = 'PASS';
  } else if (siteValidated === false) {
    checks.siteValidation = 'FAIL';
    penalties.push('api_site_mismatch');
    if (productionEnabled) {
      score -= 20;
    }
  } else {
    checks.siteValidation = 'NOT_CHECKED';
  }
  
  // Rank sequence check
  const ranks = entries.map(e => e.rank);
  const expectedRanks = Array.from({ length: entries.length }, (_, i) => i + 1);
  const ranksSequential = JSON.stringify(ranks) === JSON.stringify(expectedRanks);
  
  if (!ranksSequential && entries.length > 0) {
    penalties.push('non_sequential_ranks');
  }
  
  // LLM Teacher Mode verification bonus
  if (llmVerified) {
    score += 15;
    checks.llmVerification = 'PASS';
    log('VAL', `LLM verified bonus: +15`);
  }
  
  // Override with LLM confidence if high enough
  if (llmConfidence && llmConfidence >= 80) {
    score = Math.max(score, llmConfidence);
    checks.llmOverride = true;
    log('VAL', `LLM confidence override: ${llmConfidence}`);
  }
  
  // DOM-only bonus: When no API data available but DOM extraction looks valid
  // This helps sites like paxgambles.com that don't use JSON APIs
  const isDomOnly = (!apiData || apiData.length === 0) && domData && domData.length >= 7;
  if (isDomOnly && timerFound && entries.length >= 7 && checks.wagerOrder === 'PASS') {
    // DOM extraction with timer + valid wager order = trustworthy
    score += 15;
    checks.domOnlyBonus = 'PASS';
    log('VAL', `DOM-only with timer bonus: +15`);
  } else if (isDomOnly && timerFound && entries.length >= 7) {
    // DOM extraction with timer but wager order issues - smaller bonus
    score += 10;
    checks.domOnlyBonus = 'PARTIAL';
    log('VAL', `DOM-only with timer partial bonus: +10`);
  }
  
  // CRITICAL: Cap score at 100
  score = Math.min(100, Math.max(0, score));
  
  const minConfidence = productionEnabled ? productionMinConfidence : validationMinConfidence;
  
  return {
    score,
    penalties,
    checks,
    manualReview: score < minConfidence,
    llmVerified,
    llmConfidence
  };
}

// ============================================================================
// WEBSITE NAME DETECTION
// ============================================================================

/**
 * Common gambling/casino site names that should NOT be treated as usernames
 * If parsed as username, it indicates extraction error
 */
const KNOWN_WEBSITE_NAMES = [
  // Casinos
  'gamdom', 'stake', 'rollbit', 'roobet', 'duelbits', 'shuffle', 'bc.game', 'bcgame',
  'packdraw', 'hypedrop', 'cases', 'clash.gg', 'clashgg', 'csgoroll', 'csgopolygon',
  'csgoempire', 'lootbox', 'datdrop', 'keydrop', 'farmskins', 'hellcase', 'csgoluck',
  'skinclub', 'dmarket', 'gameboost', 'cscase', 'skinhub', 'csgo500', 'wtfskins',
  'skinbaron', 'skinport', 'bitsler', 'primedice', 'bitskins', 'csfloat',
  // Common website suffixes when parsed incorrectly
  'gamdom.com', 'stake.com', 'rollbit.com', 'roobet.com', 'duelbits.com',
  'shuffle.com', 'packdraw.com', 'hypedrop.com', 'csgoroll.com', 'csgoempire.com',
  // Company/brand names
  'leaderboard', 'leaderboards', 'rewards', 'affiliates', 'sponsored',
  // Reward site names (common branding that gets parsed as usernames)
  'paxgambles', 'wrewards', 'devlrewards', 'goatgambles', 'codeshury',
  'betjuicy', 'birb', 'muta', 'elliotrewards', 'crunchyrewards', 'augustrewards',
  'scrapesgambles', 'jonkenn', 'vinnyvh', 'tanskidegen', 'yeeterboards'
];

/**
 * Check if a string looks like a website name (domain)
 * @param {string} text - Text to check
 * @returns {boolean} - True if it looks like a website
 */
function looksLikeWebsiteName(text) {
  if (!text || typeof text !== 'string') return false;

  const textLower = text.toLowerCase().trim();

  // Check against known website names - use EXACT match only
  // Don't use includes() as it would reject valid usernames like "CODE Leaderboard"
  // that happen to contain "leaderboard" as a substring
  if (KNOWN_WEBSITE_NAMES.includes(textLower)) {
    return true;
  }
  
  // Check for domain patterns - but NOT if it looks like an email address
  // Email addresses (even censored ones like "***5@gmail.com") are valid usernames
  const isEmailLike = /@/.test(textLower);

  if (!isEmailLike) {
    const domainPatterns = [
      /\.com$/i,
      /\.gg$/i,
      /\.io$/i,
      /\.net$/i,
      /\.org$/i,
      /\.co$/i,
      /^www\./i,
      /^https?:\/\//i
    ];

    if (domainPatterns.some(pattern => pattern.test(textLower))) {
      return true;
    }
  }
  
  // Check if it's just a site name without TLD
  const exactSiteMatches = [
    'gamdom', 'stake', 'rollbit', 'roobet', 'duelbits', 'shuffle',
    'packdraw', 'hypedrop', 'csgoroll', 'csgoempire', 'clash', 'lootbox'
  ];
  
  if (exactSiteMatches.includes(textLower)) {
    return true;
  }
  
  return false;
}

/**
 * Validate that a username is not actually a website name
 * @param {string} username - Username to validate
 * @returns {Object} - { valid, reason }
 */
function validateUsernameNotWebsite(username) {
  if (!username || typeof username !== 'string') {
    return { valid: false, reason: 'empty_username' };
  }
  
  if (looksLikeWebsiteName(username)) {
    return { valid: false, reason: 'website_name_as_username' };
  }
  
  return { valid: true, reason: null };
}

// ============================================================================
// ENTRY VALIDATION
// ============================================================================

/**
 * Validate and clean entries, removing garbage
 * @param {Array} entries - Entries to validate
 * @returns {Object} - { cleaned, rejected }
 */
function validateAndCleanEntries(entries) {
  const cleaned = [];
  const rejected = [];
  
  for (const entry of entries) {
    // First check if username is valid
    const validation = validateUsername(entry.username);
    
    if (!validation.valid) {
      rejected.push({ entry, reason: validation.reason });
      log('VAL', `Rejected entry: "${entry.username}" (reason: ${validation.reason})`);
      continue;
    }
    
    // Check if username is actually a website name (parsing error)
    const websiteCheck = validateUsernameNotWebsite(entry.username);
    if (!websiteCheck.valid) {
      rejected.push({ entry, reason: websiteCheck.reason });
      log('VAL', `Rejected entry: "${entry.username}" (reason: ${websiteCheck.reason} - likely parsing error)`);
      continue;
    }

    // Filter out [hidden] placeholder entries with no real data
    // These are created when extraction found a rank/position but no username
    // Only reject if BOTH wager AND prize are 0 or missing (truly empty entry)
    if (entry.username === '[hidden]' && (!entry.wager || entry.wager === 0) && (!entry.prize || entry.prize === 0)) {
      rejected.push({ entry, reason: 'hidden_placeholder_no_data' });
      log('VAL', `Rejected entry: "[hidden]" (reason: placeholder with no wager/prize data)`);
      continue;
    }

    if (typeof entry.wager !== 'number' || entry.wager < 0 || isNaN(entry.wager)) {
      rejected.push({ entry, reason: 'invalid_wager' });
      log('VAL', `Rejected entry: "${entry.username}" (reason: invalid_wager)`);
      continue;
    }
    
    cleaned.push(entry);
  }
  
  return { cleaned, rejected };
}

// ============================================================================
// AGGREGATE STATS DETECTION
// ============================================================================

/**
 * Common patterns for aggregate stat usernames
 * These indicate a "total" row or summary data, not a real user
 */
const AGGREGATE_PATTERNS = [
  /^total$/i,
  /^total\s+(prize|pool|wager|wagered|amount|bonus)/i,
  /^sum$/i,
  /^average$/i,
  /^prize\s*pool$/i,
  /^grand\s*total$/i,
  /^volume$/i,
  /^duration$/i,
  /^ending$/i,
  /^remaining$/i,
  /^participants?$/i,
  /^entries$/i,
  /^players?$/i,
  /^current\s+(volume|total|prize)/i,
  /^all\s+(participants|players|entries)/i,
  /^\d+\s*(days?|hours?|minutes?|seconds?)/i,
  /^time\s*(left|remaining)/i
];

/**
 * Detect if entries contain aggregate stats that should be filtered out
 * Looks for:
 * - "Total" rows where wager equals sum of other wagers
 * - Usernames that match aggregate stat patterns
 * - Entries with impossible values (negative, extremely large)
 * 
 * @param {Array} entries - Entries to analyze
 * @returns {Object} - { issues: [], entriesToRemove: [], hasAggregates: boolean }
 */
function detectAggregateStats(entries) {
  if (!entries || entries.length === 0) {
    return { issues: [], entriesToRemove: [], hasAggregates: false };
  }
  
  const issues = [];
  const entriesToRemove = [];
  
  // Calculate total wager for sum detection
  const totalWager = entries.reduce((sum, e) => sum + (e.wager || 0), 0);
  
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const username = (entry.username || '').trim();
    const wager = entry.wager || 0;
    
    // Check 1: Username matches aggregate patterns
    for (const pattern of AGGREGATE_PATTERNS) {
      if (pattern.test(username)) {
        issues.push({
          entry,
          index: i,
          issue: 'aggregate_stat_username',
          detail: `Username "${username}" matches aggregate pattern`
        });
        entriesToRemove.push(i);
        break;
      }
    }
    
    // Check 2: Wager equals sum of all OTHER wagers (likely "total" row)
    // Only check if entry wasn't already flagged
    if (!entriesToRemove.includes(i) && entries.length >= 3) {
      const otherTotal = entries
        .filter((e, idx) => idx !== i)
        .reduce((sum, e) => sum + (e.wager || 0), 0);
      
      // Allow small tolerance (within 1% or $100)
      const tolerance = Math.max(otherTotal * 0.01, 100);
      
      if (Math.abs(wager - otherTotal) < tolerance && otherTotal > 0) {
        issues.push({
          entry,
          index: i,
          issue: 'likely_total_row',
          detail: `Wager ${wager} equals sum of other entries (${otherTotal})`
        });
        entriesToRemove.push(i);
      }
    }
    
    // Check 3: Extremely large wager (more than 10x the next highest)
    if (!entriesToRemove.includes(i) && entries.length >= 3) {
      const otherWagers = entries
        .filter((e, idx) => idx !== i)
        .map(e => e.wager || 0)
        .sort((a, b) => b - a);
      
      const nextHighest = otherWagers[0] || 0;
      
      if (nextHighest > 0 && wager > nextHighest * 10) {
        issues.push({
          entry,
          index: i,
          issue: 'outlier_wager',
          detail: `Wager ${wager} is 10x+ larger than next highest (${nextHighest})`
        });
        // Don't auto-remove, but flag for review
      }
    }
  }
  
  return {
    issues,
    entriesToRemove: [...new Set(entriesToRemove)], // Dedupe indices
    hasAggregates: entriesToRemove.length > 0
  };
}

/**
 * Filter out aggregate stat entries from results
 * @param {Array} entries - Original entries
 * @returns {Object} - { filtered: [], removed: [] }
 */
function filterAggregateStats(entries) {
  const detection = detectAggregateStats(entries);
  
  if (!detection.hasAggregates) {
    return { filtered: entries, removed: [] };
  }
  
  const indicesToRemove = new Set(detection.entriesToRemove);
  const filtered = [];
  const removed = [];
  
  for (let i = 0; i < entries.length; i++) {
    if (indicesToRemove.has(i)) {
      removed.push(entries[i]);
      log('VAL', `Filtered aggregate stat: "${entries[i].username}" (${detection.issues.find(is => is.index === i)?.issue})`);
    } else {
      filtered.push(entries[i]);
    }
  }
  
  return { filtered, removed };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Global tracker
  globalEntriesTracker,
  clearGlobalEntriesTracker,
  checkCrossSiteContamination,
  registerEntriesForSite,
  
  // Duplicate detection
  detectDuplicateData,
  
  // Confidence scoring
  calculateConfidence,
  
  // Entry validation
  validateAndCleanEntries,
  
  // Aggregate stats detection
  AGGREGATE_PATTERNS,
  detectAggregateStats,
  filterAggregateStats,
  
  // Website name detection
  KNOWN_WEBSITE_NAMES,
  looksLikeWebsiteName,
  validateUsernameNotWebsite
};
