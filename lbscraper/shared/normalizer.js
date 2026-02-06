/**
 * Leaderboard Data Normalization Layer
 *
 * Goal: Standard schema regardless of site.
 * Schema: rank, username, wager, prize, timestamp, leaderboard_type
 *
 * Handles: masked usernames, rank formats ("#1", "1.", "01"), currency formats,
 * missing values, inconsistent column ordering (handled in extraction; here we coerce types).
 */

const { log } = require('./utils');

// Rank format patterns for string→number
const RANK_PATTERNS = [
  /^#?\s*(\d+)\s*\.?$/,
  /^(\d+)\.\s*$/,
  /^0*(\d+)$/
];

/**
 * Normalize rank to a number
 * @param {number|string} rank
 * @returns {number}
 */
function normalizeRank(rank) {
  if (typeof rank === 'number' && !isNaN(rank) && rank >= 0) {
    return Math.floor(rank);
  }
  if (typeof rank === 'string') {
    const trimmed = rank.trim().replace(/^#\s*/, '');
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 0) return num;
    for (const re of RANK_PATTERNS) {
      const m = trimmed.match(re);
      if (m) return parseInt(m[1], 10);
    }
  }
  return 0;
}

/**
 * Normalize username (preserve masked/censored; trim)
 * @param {string} username
 * @returns {string}
 */
function normalizeUsername(username) {
  if (username == null) return '[hidden]';
  const s = String(username).trim();
  return s.length > 0 ? s : '[hidden]';
}

/**
 * Normalize monetary value (wager/prize) to number >= 0
 * @param {number|string} value
 * @returns {number}
 */
function normalizeAmount(value) {
  if (typeof value === 'number') {
    if (isNaN(value)) return 0;
    return Math.max(0, value);
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.,]/g, '').replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : Math.max(0, num);
  }
  return 0;
}

/**
 * Normalize a single leaderboard entry to standard schema
 * @param {Object} entry - { rank, username, wager, prize, ... }
 * @param {Object} options - { leaderboardType?: string, timestamp?: string }
 * @returns {Object} - { rank, username, wager, prize, timestamp, leaderboard_type }
 */
function normalizeEntry(entry, options = {}) {
  if (!entry || typeof entry !== 'object') {
    return {
      rank: 0,
      username: '[hidden]',
      wager: 0,
      prize: 0,
      timestamp: options.timestamp || new Date().toISOString(),
      leaderboard_type: options.leaderboardType || 'current'
    };
  }
  const timestamp = entry.extractedAt || options.timestamp || new Date().toISOString();
  return {
    rank: normalizeRank(entry.rank),
    username: normalizeUsername(entry.username),
    wager: normalizeAmount(entry.wager),
    prize: normalizeAmount(entry.prize),
    timestamp,
    extractedAt: timestamp,
    leaderboard_type: options.leaderboardType || 'current',
    ...(entry.id !== undefined && { id: entry.id }),
    ...(entry._fusion && { _fusion: entry._fusion })
  };
}

/**
 * Normalize an array of entries to standard schema; sort by rank
 * @param {Array} entries
 * @param {Object} options - { leaderboardType?: string }
 * @returns {Array}
 */
function normalizeEntries(entries, options = {}) {
  if (!Array.isArray(entries)) return [];
  const ts = options.timestamp || new Date().toISOString();
  const normalized = entries.map(e => normalizeEntry(e, { ...options, timestamp: ts }));
  normalized.sort((a, b) => a.rank - b.rank);
  return normalized;
}

module.exports = {
  normalizeRank,
  normalizeUsername,
  normalizeAmount,
  normalizeEntry,
  normalizeEntries
};
