/**
 * Markdown Extraction Strategy
 *
 * RESPONSIBILITY: Extract leaderboard entries from markdown content
 * - Uses multiple parsing methods to handle different site formats
 * - Leverages existing parsers from shared/extraction.js
 * - Deduplicates and sorts entries by rank
 *
 * Priority: 1.5 (after API, before DOM)
 *
 * Site formats handled:
 * - Tables: | User | Wager | Prize |
 * - Lists: **#** 4 ... foxzaayy ... $30 ... 783,116
 * - Podium: Username\nWagered: $X\n$Prize
 * - Headers: ### username
 */

const { log } = require('../shared/utils');
const fs = require('fs');
const path = require('path');
const {
  parseMarkdownTables,
  parseMarkdownPodium,
  parseMarkdownList,
  parseMarkdownHeaderEntries
} = require('../shared/extraction');

// Debug flag - set to true to save markdown for analysis
// Can also be enabled per-site by passing siteName containing 'devlrewards' or 'packdraw'
const DEBUG_SAVE_MARKDOWN = process.env.DEBUG_MARKDOWN === 'true';
const DEBUG_SITES = ['devlrewards', 'packdraw', 'goatgambles', 'csgogem', 'spencerrewards', 'chips']; // Sites to always debug

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

const strategy = {
  name: 'markdown',
  priority: 1.5,

  /**
   * Check if this strategy can extract from the given input
   * @param {Object} input - Extraction input
   * @returns {boolean}
   */
  canExtract(input) {
    // Only try if we have substantial markdown content
    return input.markdown && input.markdown.length > 1000;
  },

  /**
   * Extract leaderboard entries from markdown content
   * @param {Object} input - Extraction input
   * @returns {Promise<Object|null>} - Extraction result or null
   */
  async extract(input) {
    const { markdown } = input;
    log('MD-EXTRACT', 'Trying markdown extraction strategy...');

    // Debug: save markdown to file for analysis
    const shouldDebug = DEBUG_SAVE_MARKDOWN || (input.siteName && DEBUG_SITES.some(s => input.siteName.toLowerCase().includes(s)));
    if (shouldDebug) {
      try {
        const debugDir = path.join(__dirname, '..', 'debug');
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const siteName = input.siteName || 'unknown';
        const debugFile = path.join(debugDir, `markdown-${siteName}-${timestamp}.txt`);
        fs.writeFileSync(debugFile, markdown);
        log('MD-EXTRACT', `DEBUG: Saved markdown (${markdown.length} bytes) to ${debugFile}`);
      } catch (e) {
        log('MD-EXTRACT', `DEBUG: Failed to save markdown: ${e.message}`);
      }
    }

    // Try multiple parsing methods since sites vary in format
    const listOptions = input._prizeBeforeWager !== undefined
      ? { prizeBeforeWager: !!input._prizeBeforeWager }
      : {};
    const methods = [
      { name: 'tables', fn: (md) => parseMarkdownTables(md) },
      { name: 'list', fn: (md) => parseMarkdownList(md, listOptions) },
      { name: 'podium', fn: (md) => parseMarkdownPodium(md) },
      { name: 'headers', fn: (md) => parseMarkdownHeaderEntries(md) }
    ];

    let allEntries = [];

    for (const method of methods) {
      try {
        const entries = method.fn(markdown);
        if (entries && entries.length > 0) {
          log('MD-EXTRACT', `${method.name}: found ${entries.length} entries`);
          // Debug: show first few entries with prizes
          if (shouldDebug) {
            const withPrizes = entries.filter(e => e.prize > 0);
            const sample = entries.slice(0, 5);
            log('MD-EXTRACT', `  DEBUG ${method.name} sample: ${JSON.stringify(sample.map(e => ({ r: e.rank, u: e.username?.substring(0, 8), w: e.wager, p: e.prize })))}`);
            log('MD-EXTRACT', `  DEBUG ${method.name} entries with prizes: ${withPrizes.length}`);
          }
          allEntries = [...allEntries, ...entries];
        } else if (shouldDebug) {
          log('MD-EXTRACT', `  DEBUG ${method.name}: no entries found`);
        }
      } catch (e) {
        log('MD-EXTRACT', `${method.name} error: ${e.message}`);
      }
    }

    // Separate podium entries (ranks 1-3, determined by prize) from list entries (ranks 4+)
    const podiumEntries = allEntries.filter(e => e.source === 'markdown-podium');
    const listEntries = allEntries.filter(e => e.source !== 'markdown-podium');

    // For podium entries, use the rank detected from image paths if available
    // Otherwise determine rank by prize OR wager amount (highest = rank 1)
    // On many sites, podium shows: #2 | #1 | #3 (center is #1)
    if (podiumEntries.length > 0) {
      // Check if we have ranks detected from images (e.g., rank1-hex.svg)
      // The _rankFromImage flag is set by parseMarkdownPodium when rank comes from image path
      const hasDetectedRanks = podiumEntries.some(e => e._rankFromImage === true);

      if (!hasDetectedRanks) {
        // No detected ranks from images - sort by PRIZE amount (highest prize = rank 1)
        // This handles center-podium layouts (#2 | #1 | #3) where the visual center
        // gets the highest prize but parsing order would be wrong.
        // If prizes are equal or missing, fall back to wager amount.
        //
        // This is "common sense" - the player with the highest prize IS rank 1
        podiumEntries.sort((a, b) => {
          // Primary sort: by prize (descending - highest prize = rank 1)
          const prizeA = a.prize || 0;
          const prizeB = b.prize || 0;
          if (prizeA !== prizeB) {
            return prizeB - prizeA;  // Higher prize = lower rank number
          }
          // Secondary sort: by wager (descending) as tiebreaker
          const wagerA = a.wager || 0;
          const wagerB = b.wager || 0;
          return wagerB - wagerA;  // Higher wager = lower rank number
        });

        log('MD-EXTRACT', `Sorted podium by prize: ${podiumEntries.map(e => `${e.username}=$${e.prize}`).join(', ')}`);
        podiumEntries.forEach((entry, i) => {
          entry.rank = i + 1;
        });
      } else {
        // Use detected ranks from images - just sort by rank
        podiumEntries.sort((a, b) => a.rank - b.rank);
        log('MD-EXTRACT', `Using detected ranks from images: ${podiumEntries.map(e => e.rank).join(', ')}`);
      }

      // Clean up internal flag before returning
      podiumEntries.forEach(e => delete e._rankFromImage);
    }

    // Combine: podium first (sorted by rank), then list entries (already have correct ranks)
    const combined = [...podiumEntries, ...listEntries];

    // Smart deduplication: group by username, prefer entries with wager data
    // This handles cases where the same user appears in both podium (with wager) and list (with 0 wager)
    // For true duplicates (same username + same wager), keep the first occurrence
    // For entries with same username but different wagers: if one has wager and one doesn't, merge them
    const byUsername = new Map();
    for (const entry of combined) {
      if (!entry.username) continue;
      const usernameKey = entry.username.toLowerCase();

      if (!byUsername.has(usernameKey)) {
        byUsername.set(usernameKey, [entry]);
      } else {
        byUsername.get(usernameKey).push(entry);
      }
    }

    const unique = [];
    for (const [usernameKey, entries] of byUsername) {
      if (entries.length === 1) {
        unique.push(entries[0]);
      } else {
        // Multiple entries with same username - merge intelligently
        // Separate entries with wager from entries without
        const withWager = entries.filter(e => e.wager > 0);
        const withoutWager = entries.filter(e => !e.wager || e.wager === 0);

        if (withWager.length === 0) {
          // All entries have 0 wager - keep first one
          unique.push(entries[0]);
        } else if (withWager.length === 1) {
          // Only one entry has wager - use it (it's the authoritative one)
          unique.push(withWager[0]);
        } else {
          // Multiple entries with wagers - these might be truly different users (e.g., Anonymous)
          // or duplicates from different parsing methods with slightly different wager values
          // Group by rounded wager to catch parsing differences
          const byWager = new Map();
          for (const e of withWager) {
            const wagerKey = Math.round(e.wager / 10) * 10; // Round to nearest 10
            if (!byWager.has(wagerKey)) {
              byWager.set(wagerKey, e);
            }
          }
          // Add all distinct wager entries
          for (const e of byWager.values()) {
            unique.push(e);
          }
        }
      }
    }

    // Sort by rank
    unique.sort((a, b) => (a.rank || 999) - (b.rank || 999));

    if (unique.length >= 3) {
      // Calculate confidence based on data quality
      const confidence = calculateMarkdownConfidence(unique);
      log('MD-EXTRACT', `Found ${unique.length} total entries (confidence: ${confidence})`);

      return {
        entries: unique,
        prizes: [],
        confidence,
        metadata: {
          totalParsed: allEntries.length,
          uniqueEntries: unique.length,
          methodsUsed: methods.filter(m => {
            try { return m.fn(markdown)?.length > 0; } catch { return false; }
          }).map(m => m.name)
        }
      };
    }

    log('MD-EXTRACT', `Only ${unique.length} entries, not enough`);
    return null;
  }
};

// ============================================================================
// CONFIDENCE CALCULATION
// ============================================================================

/**
 * Calculate confidence score for markdown-extracted entries
 * @param {Array} entries - Extracted entries
 * @returns {number} - Confidence score (0-100)
 */
function calculateMarkdownConfidence(entries) {
  if (!entries || entries.length === 0) return 0;

  let confidence = 50; // Base confidence for markdown (between API and DOM)

  // More entries = higher confidence
  confidence += Math.min(15, entries.length * 1.5);

  // Valid usernames = higher confidence
  const validUsernames = entries.filter(e =>
    e.username &&
    e.username.length >= 3 &&
    e.username.length <= 30 &&
    /[a-zA-Z]/.test(e.username) // Must contain at least one letter
  );
  confidence += Math.min(10, (validUsernames.length / entries.length) * 10);

  // Has wagers = higher confidence
  const withWagers = entries.filter(e => e.wager > 0);
  confidence += Math.min(15, (withWagers.length / entries.length) * 15);

  // Has prizes = bonus confidence
  const withPrizes = entries.filter(e => e.prize > 0);
  confidence += Math.min(5, (withPrizes.length / entries.length) * 5);

  // Sequential ranks = higher confidence
  let hasSequentialRanks = true;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].rank && entries[i - 1].rank) {
      if (entries[i].rank !== entries[i - 1].rank + 1) {
        hasSequentialRanks = false;
        break;
      }
    }
  }
  if (hasSequentialRanks) confidence += 5;

  return Math.min(90, Math.round(confidence)); // Cap at 90 (API is more reliable)
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  strategy,
  calculateMarkdownConfidence
};
