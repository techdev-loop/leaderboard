/**
 * Cross-Validator Module
 *
 * RESPONSIBILITY: Compare extraction results from multiple strategies
 * - Normalize entries for comparison
 * - Calculate agreement scores between sources
 * - Detect discrepancies and conflicts
 * - Determine recommended source
 *
 * Used by: data-fusion.js
 */

const { log, cleanUsername } = require('../shared/utils');

// ============================================================================
// CONSTANTS
// ============================================================================

const WAGER_TOLERANCE = 0.05; // 5% tolerance for wager comparison
const RANK_TOLERANCE = 1;     // Allow +/- 1 rank difference

// ============================================================================
// ENTRY NORMALIZATION
// ============================================================================

/**
 * Normalize username for comparison
 * @param {string} username - Username to normalize
 * @returns {string} - Normalized username
 */
function normalizeUsername(username) {
  if (!username || typeof username !== 'string') return '';

  return username
    .toLowerCase()
    .trim()
    .replace(/[*]+/g, '')    // Remove censoring asterisks
    .replace(/\s+/g, '')     // Remove whitespace
    .replace(/[_-]+/g, '');  // Normalize separators
}

/**
 * Build a lookup map from entries
 * Uses rank as primary key since:
 * - Rank is unique per leaderboard
 * - Different sources may have different wagers for same rank (e.g., XP vs actual wager)
 * - Username masking can vary between sources (e.g., "0**i***" vs "**i***")
 *
 * Falls back to username + wager for entries without rank
 * @param {Array} entries - Entries to map
 * @returns {Map} - Map of rank or (username|wager) -> entry
 */
function buildEntryMap(entries) {
  const map = new Map();
  if (!entries || !Array.isArray(entries)) return map;

  for (const entry of entries) {
    if (entry) {
      // Primary key: rank only (most reliable for matching across sources)
      // Note: Don't include wager in key because different sources may parse
      // different values (e.g., XP vs wagerAmount) for the same rank
      if (entry.rank && entry.rank > 0) {
        const key = `rank${entry.rank}`;
        map.set(key, entry);
      } else if (entry.username) {
        // Fallback: username + wager (for entries without rank)
        const wager = Math.round(entry.wager || 0);
        const normalizedName = normalizeUsername(entry.username);
        const key = `${normalizedName}|${wager}`;
        if (key) {
          map.set(key, entry);
        }
      }
    }
  }

  return map;
}

// ============================================================================
// COMPARISON FUNCTIONS
// ============================================================================

/**
 * Compare two wager values with tolerance
 * @param {number} w1 - First wager
 * @param {number} w2 - Second wager
 * @returns {boolean} - True if within tolerance
 */
function wagersMatch(w1, w2) {
  if (w1 === w2) return true;
  if (!w1 || !w2) return false;

  const diff = Math.abs(w1 - w2);
  const tolerance = Math.max(w1, w2) * WAGER_TOLERANCE;

  return diff <= tolerance;
}

/**
 * Compare two rank values with tolerance
 * @param {number} r1 - First rank
 * @param {number} r2 - Second rank
 * @returns {boolean} - True if within tolerance
 */
function ranksMatch(r1, r2) {
  if (r1 === r2) return true;
  if (!r1 || !r2) return false;

  return Math.abs(r1 - r2) <= RANK_TOLERANCE;
}

/**
 * Compare two entries for agreement
 * @param {Object} e1 - First entry
 * @param {Object} e2 - Second entry
 * @returns {Object} - { match, fieldMatches, fieldMismatches }
 */
function compareEntries(e1, e2) {
  const fieldMatches = [];
  const fieldMismatches = [];

  // Username (should already match by lookup)
  if (normalizeUsername(e1.username) === normalizeUsername(e2.username)) {
    fieldMatches.push('username');
  } else {
    fieldMismatches.push({ field: 'username', v1: e1.username, v2: e2.username });
  }

  // Rank
  if (ranksMatch(e1.rank, e2.rank)) {
    fieldMatches.push('rank');
  } else {
    fieldMismatches.push({ field: 'rank', v1: e1.rank, v2: e2.rank });
  }

  // Wager
  if (wagersMatch(e1.wager, e2.wager)) {
    fieldMatches.push('wager');
  } else {
    fieldMismatches.push({ field: 'wager', v1: e1.wager, v2: e2.wager });
  }

  // Prize (if both have it)
  if (e1.prize && e2.prize) {
    if (wagersMatch(e1.prize, e2.prize)) {
      fieldMatches.push('prize');
    } else {
      fieldMismatches.push({ field: 'prize', v1: e1.prize, v2: e2.prize });
    }
  }

  // Calculate match score
  const totalFields = fieldMatches.length + fieldMismatches.length;
  const matchScore = totalFields > 0 ? fieldMatches.length / totalFields : 0;

  return {
    match: matchScore >= 0.75, // Consider match if 3/4 fields agree
    matchScore,
    fieldMatches,
    fieldMismatches
  };
}

// ============================================================================
// MAIN CROSS-VALIDATION
// ============================================================================

/**
 * Cross-validate results from multiple extraction strategies
 * @param {Object} results - Map of strategy name -> extraction result
 * @returns {Object} - Cross-validation report
 */
function crossValidate(results) {
  const report = {
    overallAgreement: 0,
    entryAgreement: {},
    fieldAgreement: {
      username: 0,
      rank: 0,
      wager: 0,
      prize: 0
    },
    discrepancies: [],
    recommendedSource: null,
    confidenceAdjustment: 0,
    sourceStats: {},
    entryCoverage: {}
  };

  // Get sources that have results
  const sources = Object.entries(results)
    .filter(([_, r]) => r && r.entries && r.entries.length > 0)
    .map(([name, r]) => ({
      name,
      entries: r.entries,
      confidence: r.confidence || 50,
      map: buildEntryMap(r.entries)
    }));

  if (sources.length === 0) {
    log('CROSS-VAL', 'No valid sources to cross-validate');
    return report;
  }

  if (sources.length === 1) {
    log('CROSS-VAL', `Only one source (${sources[0].name}), no cross-validation possible`);
    report.recommendedSource = sources[0].name;
    report.confidenceAdjustment = -5; // Penalty for single source
    return report;
  }

  log('CROSS-VAL', `Cross-validating ${sources.length} sources: ${sources.map(s => s.name).join(', ')}`);

  // Calculate source stats
  for (const source of sources) {
    report.sourceStats[source.name] = {
      entryCount: source.entries.length,
      confidence: source.confidence,
      hasWagers: source.entries.filter(e => e.wager > 0).length,
      hasPrizes: source.entries.filter(e => e.prize > 0).length
    };
  }

  // Collect all unique usernames across sources
  const allUsernames = new Set();
  for (const source of sources) {
    for (const key of source.map.keys()) {
      allUsernames.add(key);
    }
  }

  // Analyze each username
  let totalComparisons = 0;
  let agreements = 0;
  const fieldCounts = { username: 0, rank: 0, wager: 0, prize: 0 };
  const fieldMatches = { username: 0, rank: 0, wager: 0, prize: 0 };

  for (const username of allUsernames) {
    // Find which sources have this user
    const entriesForUser = [];
    for (const source of sources) {
      const entry = source.map.get(username);
      if (entry) {
        entriesForUser.push({ source: source.name, entry });
      }
    }

    // Track coverage
    report.entryCoverage[username] = entriesForUser.map(e => e.source);

    // Compare pairs of sources
    for (let i = 0; i < entriesForUser.length - 1; i++) {
      for (let j = i + 1; j < entriesForUser.length; j++) {
        const s1 = entriesForUser[i];
        const s2 = entriesForUser[j];

        const comparison = compareEntries(s1.entry, s2.entry);
        totalComparisons++;

        if (comparison.match) {
          agreements++;
        } else {
          // Record discrepancy
          report.discrepancies.push({
            username,
            sources: [s1.source, s2.source],
            fieldMismatches: comparison.fieldMismatches
          });
        }

        // Track field-level agreement
        for (const field of comparison.fieldMatches) {
          fieldCounts[field]++;
          fieldMatches[field]++;
        }
        for (const mismatch of comparison.fieldMismatches) {
          fieldCounts[mismatch.field]++;
        }
      }
    }

    // Track single-source entries (no comparison possible)
    if (entriesForUser.length === 1) {
      report.entryAgreement[username] = {
        status: 'single_source',
        sources: [entriesForUser[0].source]
      };
    } else {
      const allAgree = entriesForUser.every((e, i, arr) => {
        if (i === 0) return true;
        return compareEntries(arr[0].entry, e.entry).match;
      });

      report.entryAgreement[username] = {
        status: allAgree ? 'agreed' : 'disputed',
        sources: entriesForUser.map(e => e.source)
      };
    }
  }

  // Calculate overall agreement
  report.overallAgreement = totalComparisons > 0 ? agreements / totalComparisons : 0;

  // Calculate field-level agreement
  for (const field of Object.keys(fieldCounts)) {
    if (fieldCounts[field] > 0) {
      report.fieldAgreement[field] = fieldMatches[field] / fieldCounts[field];
    }
  }

  // Determine recommended source
  report.recommendedSource = determineRecommendedSource(sources, report);

  // Calculate confidence adjustment
  report.confidenceAdjustment = calculateConfidenceAdjustment(report);

  log('CROSS-VAL', `Agreement: ${(report.overallAgreement * 100).toFixed(1)}%, Discrepancies: ${report.discrepancies.length}, Recommended: ${report.recommendedSource}`);

  return report;
}

/**
 * Determine which source to recommend
 * @param {Array} sources - Source data
 * @param {Object} report - Current report
 * @returns {string} - Recommended source name
 */
function determineRecommendedSource(sources, report) {
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0].name;

  // Score each source
  const scores = sources.map(source => {
    let score = 0;

    // Base confidence
    score += source.confidence * 0.3;

    // Entry count (prefer more entries)
    score += Math.min(source.entries.length * 2, 30);

    // Has wager data
    const wagerPercent = source.entries.filter(e => e.wager > 0).length / source.entries.length;
    score += wagerPercent * 20;

    // Has prize data
    const prizePercent = source.entries.filter(e => e.prize > 0).length / source.entries.length;
    score += prizePercent * 10;

    // Agreement with other sources
    const agreedEntries = Object.values(report.entryAgreement)
      .filter(e => e.status === 'agreed' && e.sources.includes(source.name))
      .length;
    score += agreedEntries * 3;

    return { name: source.name, score };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores[0].name;
}

/**
 * Calculate confidence adjustment based on cross-validation
 * @param {Object} report - Cross-validation report
 * @returns {number} - Confidence adjustment (-20 to +20)
 */
function calculateConfidenceAdjustment(report) {
  let adjustment = 0;

  // High agreement bonus
  if (report.overallAgreement >= 0.9) {
    adjustment += 20;
  } else if (report.overallAgreement >= 0.7) {
    adjustment += 10;
  } else if (report.overallAgreement >= 0.5) {
    adjustment += 5;
  }

  // Low agreement penalty
  if (report.overallAgreement < 0.5) {
    adjustment -= 10;
  }
  if (report.overallAgreement < 0.3) {
    adjustment -= 15;
  }

  // Discrepancy penalty
  if (report.discrepancies.length > 10) {
    adjustment -= 10;
  } else if (report.discrepancies.length > 5) {
    adjustment -= 5;
  }

  return adjustment;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main function
  crossValidate,

  // Normalization
  normalizeUsername,
  buildEntryMap,

  // Comparison
  wagersMatch,
  ranksMatch,
  compareEntries,

  // Helpers
  determineRecommendedSource,
  calculateConfidenceAdjustment,

  // Constants
  WAGER_TOLERANCE,
  RANK_TOLERANCE
};
