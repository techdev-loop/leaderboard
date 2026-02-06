/**
 * DOM Extraction Strategy
 *
 * RESPONSIBILITY: Extract leaderboard entries from HTML DOM structure
 * - Parse table structures (tr, td)
 * - Parse list structures (li, div containers)
 * - Extract podium cards (top 3 winners)
 * - Handle various CSS class naming patterns
 *
 * Priority: 2 (second choice after API)
 */

const { log, parseNum, validateUsername, cleanUsername } = require('../shared/utils');

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

const strategy = {
  name: 'dom',
  priority: 2,

  /**
   * Check if this strategy can extract from the given input
   * @param {Object} input - Extraction input
   * @returns {boolean}
   */
  canExtract(input) {
    return input.page != null || (input.html && input.html.length > 500);
  },

  /**
   * Extract leaderboard entries from DOM
   * @param {Object} input - Extraction input
   * @returns {Promise<Object|null>} - Extraction result or null
   */
  async extract(input) {
    const { page, _podiumLayout } = input;
    log('DOM-EXTRACT', 'Trying DOM extraction strategy...');

    if (!page) {
      log('DOM-EXTRACT', 'No page available for DOM extraction');
      return null;
    }

    try {
      const entries = await scrapeDOMLeaderboard(page, _podiumLayout);

      if (entries && entries.length >= 3) {
        const confidence = calculateDomConfidence(entries);
        log('DOM-EXTRACT', `Found ${entries.length} entries (confidence: ${confidence})`);

        return {
          entries,
          prizes: [],
          confidence,
          metadata: {
            method: 'dom',
            podiumLayout: _podiumLayout || 'unknown'
          }
        };
      }

      log('DOM-EXTRACT', `Only found ${entries?.length || 0} entries, not enough`);
      return null;

    } catch (e) {
      log('DOM-EXTRACT', `DOM extraction error: ${e.message}`);
      return null;
    }
  }
};

// ============================================================================
// MAIN DOM EXTRACTION
// ============================================================================

/**
 * Scrape leaderboard data from DOM containers
 * @param {import('playwright').Page} page - Playwright page instance
 * @param {string} [podiumLayout] - Vision-learned podium layout: "center_first" | "left_to_right" | "no_podium"
 * @returns {Promise<Array>} - Array of entry objects
 */
async function scrapeDOMLeaderboard(page, podiumLayout) {
  log('DOM-EXTRACT', `Starting DOM extraction... (podiumLayout: ${podiumLayout || 'unknown'})`);

  const data = await page.evaluate((layoutHint) => {
    // Helper: Check if text is garbage
    function isGarbageEntry(str) {
      if (!str || str.length < 2 || str.length > 30) return true;

      const lower = str.toLowerCase().trim();
      const garbageWords = [
        'other', 'leaders', 'total', 'prize', 'pool', 'bonus', 'bonuses',
        'all', 'view', 'more', 'remaining', 'wagered', 'reward', 'rewards',
        'leaderboard', 'leaderboards', 'rank', 'status', 'active', 'inactive',
        'tournament', 'tournaments', 'free', 'login', 'register', 'browse',
        'join', 'enter', 'vip', 'premium', 'loading', 'home', 'menu',
        'history', 'past', 'results', 'competition', 'race', 'challenge',
        'gamdom', 'packdraw', 'shuffle', 'stake', 'roobet', 'rollbit',
        'csgoroll', 'clash', 'hypedrop', 'csgopolygon'
      ];

      if (garbageWords.includes(lower)) return true;
      if (/^other\s+(leaders?|players?)/i.test(str)) return true;
      if (/^[$€£]?\s*[\d,]+\.?\d*$/.test(str)) return true;

      return false;
    }

    // Helper: Parse number
    function parseNumInBrowser(str) {
      if (!str) return 0;
      if (typeof str === 'number') return str;
      let s = str.toString().trim();
      s = s.replace(/[$€£¥₹฿₿◆♦\s]/g, '');
      let mult = 1;
      if (/m$/i.test(s)) { mult = 1000000; s = s.replace(/m$/i, ''); }
      else if (/k$/i.test(s)) { mult = 1000; s = s.replace(/k$/i, ''); }
      if (s.includes(',') && s.includes('.')) {
        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        if (lastDot > lastComma) s = s.replace(/,/g, '');
        else s = s.replace(/\./g, '').replace(',', '.');
      } else if (s.includes(',')) {
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length <= 2) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
      }
      const num = parseFloat(s);
      return isNaN(num) ? 0 : num * mult;
    }

    // Helper: Extract from a single container
    function extractFromContainer(container) {
      const text = container.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);

      let username = null;
      let wager = 0;
      let prize = 0;
      let rank = 0;
      const moneyAmounts = [];
      let lastLabel = null;

      // Special handling for custom-reward elements (e.g., wrewards.com HUNT)
      // These divs contain special prize amounts like "$30,000" that should NOT be treated as wager
      const customReward = container.querySelector('[class*="custom-reward"], [class*="CustomReward"]');
      if (customReward) {
        const rewardText = customReward.innerText || '';
        const moneyMatch = rewardText.match(/\$\s*([\d,]+(?:\.\d+)?)/);
        if (moneyMatch) {
          prize = parseNumInBrowser(moneyMatch[0]);
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const upperLine = line.toUpperCase();

        // Track wager/prize labels
        if (['WAGERED', 'WAGER'].includes(upperLine)) {
          lastLabel = 'wager';
          continue;
        }
        if (['PRIZE', 'REWARD', 'BONUS'].includes(upperLine)) {
          lastLabel = 'prize';
          continue;
        }

        // Handle rank
        const rankMatch = line.match(/^#?(\d+)(?:st|nd|rd|th)?$/i);
        if (rankMatch && parseInt(rankMatch[1]) <= 20) {
          rank = parseInt(rankMatch[1]);
          continue;
        }

        // Handle money amounts
        if (/^[$◆♦€£]?\s*[\d,.]+/.test(line)) {
          const amount = parseNumInBrowser(line);
          if (amount > 0) {
            if (lastLabel === 'wager') {
              wager = amount;
              lastLabel = null;
            } else if (lastLabel === 'prize') {
              prize = amount;
              lastLabel = null;
            } else {
              moneyAmounts.push(amount);
            }
          }
          continue;
        }

        // Handle username
        if (!username && !isGarbageEntry(line)) {
          const hasLetterOrAsterisk = /[a-zA-Z*]/.test(line);
          if (hasLetterOrAsterisk && line.length >= 2 && line.length <= 30) {
            username = line.replace(/^\d+[.)\s]+/, '').trim();
          }
        }
      }

      // Fallback: use moneyAmounts if labels didn't work
      if (moneyAmounts.length >= 1) {
        moneyAmounts.sort((a, b) => b - a);
        // If prize was already set from custom-reward, filter it out to get correct wager
        const amountsForWager = prize > 0
          ? moneyAmounts.filter(a => Math.abs(a - prize) > 0.01)  // Exclude the prize amount
          : moneyAmounts;
        if (wager === 0 && amountsForWager.length >= 1) wager = amountsForWager[0];
        if (prize === 0 && moneyAmounts.length >= 2) prize = moneyAmounts[1];
      }

      return { username, wager, prize, rank };
    }

    // Try podium cards first
    function extractPodiumCards() {
      const podiumSelectors = [
        // Try specific place selectors first (most reliable for individual cards)
        '[class*="place-1"], [class*="place-2"], [class*="place-3"]',
        // Then try generic winner/podium selectors
        '[class*="WinnerCard"]',
        '[class*="winner-card"]',
        '[class*="podium"]',
        '[class*="top-3"]'
      ];

      for (const selector of podiumSelectors) {
        try {
          const cards = document.querySelectorAll(selector);
          if (cards.length >= 3) {
            const extracted = [];
            for (const card of cards) {
              const result = extractFromContainer(card);
              if (result.username && result.wager > 0) {
                extracted.push(result);
              }
            }
            if (extracted.length >= 3) {
              // Use Vision-learned podium layout hint for correct rank assignment
              // "center_first" means: #2 | #1 | #3 visually (center is highest)
              // The key insight: highest PRIZE = rank 1 (not highest wager)
              // This works for both center_first and left_to_right since prize always determines rank
              if (layoutHint === 'center_first' || layoutHint === 'left_to_right') {
                // Sort by PRIZE descending (highest prize = rank 1)
                // Prize is the definitive indicator of rank
                extracted.sort((a, b) => {
                  const prizeA = a.prize || 0;
                  const prizeB = b.prize || 0;
                  if (prizeA !== prizeB) return prizeB - prizeA;
                  // Fallback to wager if prizes are equal
                  return (b.wager || 0) - (a.wager || 0);
                });
              } else {
                // Default: sort by wager (old behavior)
                extracted.sort((a, b) => b.wager - a.wager);
              }
              for (let i = 0; i < Math.min(extracted.length, 3); i++) {
                extracted[i].rank = i + 1;
                extracted[i].source = 'dom-podium';
              }
              return extracted;
            }
          }
        } catch (e) {}
      }
      return [];
    }

    // Try list/table rows
    function extractListEntries() {
      const listSelectors = [
        '[class*="leaderboard"] [class*="row"]',
        '[class*="leaderboard"] tr',
        '[class*="ranking"] [class*="item"]',
        '[class*="leaders"] li',
        'table tbody tr',
        '[class*="entry"]',
        '[class*="player-row"]'
      ];

      for (const selector of listSelectors) {
        try {
          const rows = document.querySelectorAll(selector);
          if (rows.length >= 3) {
            const extracted = [];
            for (const row of rows) {
              const result = extractFromContainer(row);
              if (result.username && (result.wager > 0 || result.prize > 0)) {
                extracted.push(result);
              }
            }
            if (extracted.length >= 3) {
              // Assign ranks if missing
              extracted.forEach((e, i) => {
                if (!e.rank) e.rank = i + 1;
                e.source = 'dom-list';
              });
              return extracted;
            }
          }
        } catch (e) {}
      }
      return [];
    }

    // Combine podium and list
    const podium = extractPodiumCards();
    const list = extractListEntries();

    // Merge results
    const allEntries = [...podium];
    const existingUsernames = new Set(podium.map(e => e.username?.toLowerCase()));

    for (const entry of list) {
      if (entry.username && !existingUsernames.has(entry.username.toLowerCase())) {
        allEntries.push(entry);
        existingUsernames.add(entry.username.toLowerCase());
      }
    }

    // Re-number ranks
    allEntries.sort((a, b) => {
      if (a.rank && b.rank) return a.rank - b.rank;
      return b.wager - a.wager;
    });
    allEntries.forEach((e, i) => e.rank = i + 1);

    return allEntries;
  }, podiumLayout);

  return data || [];
}

// ============================================================================
// CONFIDENCE CALCULATION
// ============================================================================

/**
 * Calculate confidence score for DOM-extracted entries
 * @param {Array} entries - Extracted entries
 * @returns {number} - Confidence score (0-100)
 */
function calculateDomConfidence(entries) {
  if (!entries || entries.length === 0) return 0;

  let confidence = 40; // Base confidence for DOM (lower than API)

  // More entries = higher confidence
  confidence += Math.min(20, entries.length * 2);

  // Valid usernames = higher confidence
  const validUsernames = entries.filter(e =>
    e.username &&
    e.username.length >= 3 &&
    e.username.length <= 20 &&
    /^[a-zA-Z0-9_.*-]+$/.test(e.username)
  );
  confidence += Math.min(15, (validUsernames.length / entries.length) * 15);

  // Has wagers = higher confidence
  const withWagers = entries.filter(e => e.wager > 0);
  confidence += Math.min(15, (withWagers.length / entries.length) * 15);

  // Has prizes = higher confidence
  const withPrizes = entries.filter(e => e.prize > 0);
  confidence += Math.min(10, (withPrizes.length / entries.length) * 10);

  return Math.min(90, Math.round(confidence)); // Cap at 90 for DOM
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  strategy,

  // Helper functions (for testing/reuse)
  scrapeDOMLeaderboard,
  calculateDomConfidence
};
