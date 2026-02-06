/**
 * Dataset Validation & Reliability Layer
 *
 * RESPONSIBILITY: The scraper must know when it is wrong.
 * - Dataset completeness: ranks sequential, no duplicates, minimum row threshold
 * - Data sanity: wager >= 0, prize >= 0, usernames non-empty
 * - Strategy agreement: if two strategies disagree → mark low confidence
 *
 * Example: if max(rank) != row_count → dataset_incomplete
 */

const { log } = require('./utils');

// ============================================================================
// COMPLETENESS CHECKS
// ============================================================================

/**
 * Validate dataset completeness
 * @param {Array<{rank: number, username: string, wager: number, prize: number}>} entries
 * @param {Object} options - { minRows?: number, requireSequential?: boolean }
 * @returns {Object} - { valid: boolean, issues: string[], maxRank: number, rowCount: number }
 */
function validateDatasetCompleteness(entries, options = {}) {
  const { minRows = 2, requireSequential = true } = options;
  const issues = [];

  if (!entries || !Array.isArray(entries)) {
    return { valid: false, issues: ['no_entries'], maxRank: 0, rowCount: 0 };
  }

  const rowCount = entries.length;
  const ranks = entries.map(e => e.rank).filter(r => typeof r === 'number' && r > 0);
  const maxRank = ranks.length ? Math.max(...ranks) : 0;

  if (rowCount < minRows) {
    issues.push(`below_min_rows: ${rowCount} < ${minRows}`);
  }

  if (maxRank > 0 && rowCount > 0 && maxRank !== rowCount) {
    issues.push(`rank_count_mismatch: max(rank)=${maxRank} != row_count=${rowCount} (dataset_incomplete)`);
  }

  if (requireSequential && ranks.length > 0) {
    const sorted = [...new Set(ranks)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        issues.push(`rank_gap: missing rank(s) between ${sorted[i - 1]} and ${sorted[i]}`);
        break;
      }
    }
  }

  const duplicateRanks = new Map();
  for (const e of entries) {
    if (e.rank) {
      const k = e.rank;
      duplicateRanks.set(k, (duplicateRanks.get(k) || 0) + 1);
    }
  }
  const dupes = [...duplicateRanks.entries()].filter(([, c]) => c > 1);
  if (dupes.length > 0) {
    issues.push(`duplicate_ranks: ${dupes.map(([r]) => r).join(', ')}`);
  }

  const valid = issues.length === 0;
  if (!valid) {
    log('VALIDATE', `Dataset completeness: ${issues.join('; ')}`);
  }
  return { valid, issues, maxRank, rowCount };
}

/**
 * Data sanity checks: wager >= 0, prize >= 0, usernames non-empty
 * @param {Array<{rank: number, username: string, wager: number, prize: number}>} entries
 * @returns {Object} - { valid: boolean, issues: string[] }
 */
function validateDataSanity(entries) {
  const issues = [];

  if (!entries || !Array.isArray(entries)) {
    return { valid: false, issues: ['no_entries'] };
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (typeof e.wager === 'number' && (e.wager < 0 || isNaN(e.wager))) {
      issues.push(`entry ${i + 1}: wager < 0 or NaN`);
    }
    if (typeof e.prize === 'number' && (e.prize < 0 || isNaN(e.prize))) {
      issues.push(`entry ${i + 1}: prize < 0 or NaN`);
    }
    if (!e.username || String(e.username).trim() === '') {
      if (e.username !== '[hidden]') {
        issues.push(`entry ${i + 1}: empty username`);
      }
    }
  }

  const valid = issues.length === 0;
  if (!valid) {
    log('VALIDATE', `Data sanity: ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? '...' : ''}`);
  }
  return { valid, issues };
}

/**
 * Strategy agreement check: if two strategies disagree, mark as low confidence.
 * (Called from fusion layer; here we only define the rule.)
 * @param {Object} crossValidation - { overallAgreement: number, discrepancies: Array }
 * @param {number} threshold - Agreement threshold below which confidence is reduced
 * @returns {Object} - { lowConfidence: boolean, reason?: string }
 */
function checkStrategyAgreement(crossValidation, threshold = 0.7) {
  if (!crossValidation || crossValidation.overallAgreement === undefined) {
    return { lowConfidence: false };
  }
  if (crossValidation.overallAgreement < threshold) {
    return {
      lowConfidence: true,
      reason: `strategy_agreement_below_${threshold}: ${(crossValidation.overallAgreement * 100).toFixed(0)}%`
    };
  }
  return { lowConfidence: false };
}

/**
 * Run all dataset validations and return a single result
 * @param {Array} entries
 * @param {Object} options - { minRows?: number, crossValidation?: Object }
 * @returns {Object} - { valid: boolean, completeness: Object, sanity: Object, strategyAgreement: Object, confidencePenalty: number }
 */
function validateDataset(entries, options = {}) {
  const { minRows = 2, crossValidation = null } = options;

  const completeness = validateDatasetCompleteness(entries, { minRows });
  const sanity = validateDataSanity(entries);
  const strategyAgreement = checkStrategyAgreement(crossValidation, 0.7);

  let confidencePenalty = 0;
  if (!completeness.valid) confidencePenalty += 15;
  if (!sanity.valid) confidencePenalty += 10;
  if (strategyAgreement.lowConfidence) confidencePenalty += 20;

  const valid = completeness.valid && sanity.valid && !strategyAgreement.lowConfidence;
  return {
    valid,
    completeness,
    sanity,
    strategyAgreement,
    confidencePenalty
  };
}

module.exports = {
  validateDatasetCompleteness,
  validateDataSanity,
  checkStrategyAgreement,
  validateDataset
};
