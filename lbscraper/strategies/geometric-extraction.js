/**
 * Geometric Extraction Strategy
 *
 * RESPONSIBILITY: Extract entries using visual/spatial analysis
 * - Detect repeating patterns by element size/position
 * - Identify "3+7" podium+list structure
 * - Group elements by size similarity
 * - Use positional relationships to find entries
 *
 * Priority: 3 (fallback when DOM parsing fails)
 */

const { log, parseNum, validateUsername, cleanUsername } = require('../shared/utils');

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

const strategy = {
  name: 'geometric',
  priority: 3,

  /**
   * Check if this strategy can extract from the given input
   * @param {Object} input - Extraction input
   * @returns {boolean}
   */
  canExtract(input) {
    return input.page != null;
  },

  /**
   * Extract leaderboard entries using geometric analysis
   * @param {Object} input - Extraction input
   * @returns {Promise<Object|null>} - Extraction result or null
   */
  async extract(input) {
    const { page } = input;
    log('GEO-EXTRACT', 'Trying geometric extraction strategy...');

    if (!page) {
      log('GEO-EXTRACT', 'No page available for geometric extraction');
      return null;
    }

    try {
      // Step 1: Extract element geometry
      const elements = await extractElementGeometry(page);
      log('GEO-EXTRACT', `Found ${elements.length} potential elements`);

      if (elements.length < 5) {
        log('GEO-EXTRACT', 'Not enough elements for geometric analysis');
        return null;
      }

      // Step 2: Group by size similarity
      const groups = groupBySizeSimilarity(elements);
      log('GEO-EXTRACT', `Found ${groups.length} size-similar groups`);

      if (groups.length === 0) {
        log('GEO-EXTRACT', 'No valid groups found');
        return null;
      }

      // Step 3: Detect podium+list structure
      const structure = detectPodiumAndList(groups);

      if (!structure || structure.listElements.length < 3) {
        log('GEO-EXTRACT', 'Could not detect leaderboard structure');
        return null;
      }

      log('GEO-EXTRACT', `Detected structure: ${structure.podiumElements.length} podium + ${structure.listElements.length} list elements`);

      // Step 4: Extract entries from structure
      const entries = await extractFromGeometricStructure(page, structure);

      if (entries.length >= 3) {
        const confidence = Math.round(structure.confidence * 70 + 10); // Max ~80
        log('GEO-EXTRACT', `Found ${entries.length} entries (confidence: ${confidence})`);

        return {
          entries,
          prizes: [],
          confidence,
          metadata: {
            podiumCount: structure.podiumElements.length,
            listCount: structure.listElements.length,
            structureConfidence: structure.confidence
          }
        };
      }

      log('GEO-EXTRACT', `Only found ${entries.length} entries, not enough`);
      return null;

    } catch (e) {
      log('GEO-EXTRACT', `Geometric extraction error: ${e.message}`);
      return null;
    }
  }
};

// ============================================================================
// GEOMETRY EXTRACTION
// ============================================================================

/**
 * Extract geometric data for all potential leaderboard elements
 * @param {import('playwright').Page} page - Playwright page instance
 * @returns {Promise<Array>} - Array of element geometry data
 */
async function extractElementGeometry(page) {
  return await page.evaluate(() => {
    const selectors = 'li, tr, article, div, section, [class*="item"], [class*="rank"], [class*="entry"], [class*="player"], [class*="user"], [class*="row"]';
    const elements = document.querySelectorAll(selectors);
    const results = [];

    for (const el of elements) {
      const rect = el.getBoundingClientRect();

      // Filter out too small/large elements
      if (rect.width < 50 || rect.height < 20) continue;
      if (rect.width > window.innerWidth * 0.95) continue;
      if (rect.height > 300) continue;

      const text = el.innerText?.trim() || '';
      if (text.length < 5 || text.length > 500) continue;

      results.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        area: rect.width * rect.height,
        centerX: rect.x + rect.width / 2,
        centerY: rect.y + rect.height / 2,
        text: text.substring(0, 300),
        childCount: el.children.length,
        tagName: el.tagName.toLowerCase(),
        className: (el.className || '').toString().substring(0, 100)
      });
    }

    return results;
  });
}

// ============================================================================
// ELEMENT GROUPING
// ============================================================================

/**
 * Group elements by size similarity
 * @param {Array} elements - Array of element geometry data
 * @param {number} tolerance - Size tolerance (0-1)
 * @returns {Array} - Array of groups (min 3 elements each)
 */
function groupBySizeSimilarity(elements, tolerance = 0.15) {
  const groups = [];

  for (const el of elements) {
    let foundGroup = false;

    for (const group of groups) {
      const ref = group[0];
      const widthDiff = Math.abs(el.width - ref.width) / ref.width;
      const heightDiff = Math.abs(el.height - ref.height) / ref.height;

      if (widthDiff <= tolerance && heightDiff <= tolerance) {
        group.push(el);
        foundGroup = true;
        break;
      }
    }

    if (!foundGroup) {
      groups.push([el]);
    }
  }

  // Only return groups with 3+ elements
  return groups.filter(g => g.length >= 3);
}

// ============================================================================
// STRUCTURE DETECTION
// ============================================================================

/**
 * Detect the "3+7" podium+list structure
 * @param {Array} groups - Array of element groups
 * @param {number} xAlignmentTolerance - X-axis alignment tolerance in pixels
 * @returns {Object|null} - Structure with podiumElements, listElements, confidence
 */
function detectPodiumAndList(groups, xAlignmentTolerance = 10) {
  if (groups.length === 0) return null;

  // Sort groups by size (largest first)
  groups.sort((a, b) => b.length - a.length);

  let listGroup = null;
  let podiumGroup = null;

  // Find the main list group (5+ vertically aligned elements)
  for (const group of groups) {
    if (group.length >= 5) {
      const xCoords = group.map(el => el.x);
      const avgX = xCoords.reduce((a, b) => a + b, 0) / xCoords.length;
      const xAligned = xCoords.every(x => Math.abs(x - avgX) <= xAlignmentTolerance);

      if (xAligned) {
        // Sort by Y position
        group.sort((a, b) => a.y - b.y);
        listGroup = group;
        break;
      }
    }
  }

  // Find podium group (2-4 larger elements above the list)
  if (listGroup) {
    const listTopY = Math.min(...listGroup.map(el => el.y));
    const listMedianArea = listGroup.map(el => el.area).sort((a, b) => a - b)[Math.floor(listGroup.length / 2)];

    for (const group of groups) {
      if (group === listGroup) continue;

      if (group.length >= 2 && group.length <= 4) {
        const allAbove = group.every(el => el.y < listTopY);
        const avgArea = group.reduce((s, el) => s + el.area, 0) / group.length;

        // Podium cards should be larger than list items
        if (allAbove && avgArea > listMedianArea * 1.2) {
          // Sort by X position (left to right)
          group.sort((a, b) => a.x - b.x);
          podiumGroup = group;
          break;
        }
      }
    }
  }

  // Calculate confidence
  let confidence = 0;
  if (listGroup) {
    confidence += 0.4;
    if (listGroup.length >= 7) confidence += 0.2;
  }
  if (podiumGroup) {
    confidence += 0.3;
    if (podiumGroup.length === 3) confidence += 0.1;
  }

  return {
    podiumElements: podiumGroup || [],
    listElements: listGroup || [],
    confidence
  };
}

// ============================================================================
// ENTRY EXTRACTION
// ============================================================================

/**
 * Extract entries from geometrically identified structure
 * @param {import('playwright').Page} page - Playwright page instance
 * @param {Object} structure - Structure with podiumElements and listElements
 * @returns {Promise<Array>} - Array of entry objects
 */
async function extractFromGeometricStructure(page, structure) {
  const allElements = [
    ...structure.podiumElements.map((el, i) => ({ ...el, isPodium: true, podiumRank: i + 1 })),
    ...structure.listElements.map((el, i) => ({ ...el, isPodium: false, listIndex: i }))
  ];

  const entries = await page.evaluate((elements) => {
    function parseNumInBrowser(str) {
      if (!str) return 0;
      if (typeof str === 'number') return str;
      let s = str.toString().trim();
      s = s.replace(/[$€£¥₹฿₿◆♦\s]/g, '');
      let mult = 1;
      if (/m$/i.test(s)) { mult = 1000000; s = s.replace(/m$/i, ''); }
      else if (/k$/i.test(s)) { mult = 1000; s = s.replace(/k$/i, ''); }
      s = s.replace(/,/g, '');
      const num = parseFloat(s);
      return isNaN(num) ? 0 : num * mult;
    }

    function isGarbageEntry(str) {
      if (!str || str.length < 2 || str.length > 30) return true;
      const lower = str.toLowerCase().trim();
      const garbageWords = [
        'other', 'leaders', 'total', 'prize', 'pool', 'bonus',
        'leaderboard', 'rank', 'wagered', 'reward', 'view', 'more'
      ];
      return garbageWords.includes(lower) || /^[$€£]?\s*[\d,]+\.?\d*$/.test(str);
    }

    const results = [];

    for (const elData of elements) {
      // Find the actual DOM element at this position
      const el = document.elementFromPoint(elData.centerX, elData.centerY);
      if (!el) continue;

      // Get the container element
      const container = el.closest('div, li, tr, article, section') || el;
      const text = container.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);

      let username = null;
      let wager = 0;
      let prize = 0;
      const numbers = [];

      for (const line of lines) {
        // Extract numbers
        if (/^[$◆♦€£]?\s*[\d,.]+/.test(line)) {
          const num = parseNumInBrowser(line);
          if (num > 0) numbers.push(num);
          continue;
        }

        // Extract username
        if (!username && !isGarbageEntry(line) && /[a-zA-Z*]/.test(line)) {
          username = line.replace(/^\d+[.)\s]+/, '').trim();
        }
      }

      // Assign wager/prize from numbers
      if (numbers.length >= 1) {
        numbers.sort((a, b) => b - a);
        wager = numbers[0];
        if (numbers.length >= 2) prize = numbers[1];
      }

      if (username && wager > 0) {
        results.push({
          username,
          wager,
          prize,
          isPodium: elData.isPodium,
          podiumRank: elData.podiumRank,
          listIndex: elData.listIndex,
          source: 'geometric'
        });
      }
    }

    return results;
  }, allElements);

  // Deduplicate and assign ranks
  const seen = new Set();
  const uniqueEntries = [];

  // Process podium first
  const podiumEntries = entries.filter(e => e.isPodium).sort((a, b) => a.podiumRank - b.podiumRank);
  for (const entry of podiumEntries) {
    const key = entry.username.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEntries.push({
        rank: entry.podiumRank,
        username: entry.username,
        wager: entry.wager,
        prize: entry.prize,
        source: 'geometric-podium'
      });
    }
  }

  // Then process list
  const listEntries = entries.filter(e => !e.isPodium).sort((a, b) => a.listIndex - b.listIndex);
  for (const entry of listEntries) {
    const key = entry.username.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEntries.push({
        rank: uniqueEntries.length + 1,
        username: entry.username,
        wager: entry.wager,
        prize: entry.prize,
        source: 'geometric-list'
      });
    }
  }

  // Final rank assignment
  uniqueEntries.sort((a, b) => a.rank - b.rank);
  uniqueEntries.forEach((e, i) => e.rank = i + 1);

  return uniqueEntries;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  strategy,

  // Helper functions (for testing/reuse)
  extractElementGeometry,
  groupBySizeSimilarity,
  detectPodiumAndList,
  extractFromGeometricStructure
};
