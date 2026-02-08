/**
 * UI Interaction Strategy Module - Leaderboard Discovery & Navigation Layer
 *
 * RESPONSIBILITY:
 * - Detect leaderboard tabs/buttons (heuristic: leaderboard, ranking, standings)
 * - Detect pagination controls
 * - Detect "show N entries" dropdowns
 * - Max-rows selection logic (select largest option; fallback to pagination)
 * - Leaderboard readiness detection (stable DOM, network idle, row count stabilization)
 * - Retry logic for UI actions
 *
 * Avoids fixed selectors; uses heuristic text matching.
 */

const { log } = require('./utils');

// ============================================================================
// HEURISTIC PATTERNS
// ============================================================================

const LEADERBOARD_BUTTON_PATTERNS = [
  /\bleaderboard(s)?\b/i,
  /\branking(s)?\b/i,
  /\bstandings?\b/i,
  /\btop\s*players?\b/i,
  /\bwager\s*race\b/i
];

const ROW_SELECTOR_PATTERNS = [
  /\bshow\b/i,
  /\bentries?\b/i,
  /\brows?\b/i,
  /\bper\s*page\b/i,
  /\bdisplay\b/i,
  /\bview\s*\d+/i
];

const PAGINATION_PATTERNS = [
  /\b(next|more|load\s*more|show\s*more|view\s*all)\b/i,
  /\bpage\s*\d+\b/i,
  /\b\d+\s*-\s*\d+\s*of\b/i,
  /[<>]\s*$/  // next/prev arrows
];

// ============================================================================
// DETECTION: Leaderboard tabs/buttons
// ============================================================================

/**
 * Detect clickable elements that look like leaderboard tabs/buttons
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{text: string, selector: string, tag: string}>>}
 */
async function detectLeaderboardTabs(page) {
  return await page.evaluate((patterns) => {
    const results = [];
    const regexes = patterns.map(p => new RegExp(p.source, p.flags));
    const clickables = document.querySelectorAll(
      'button, a, [role="button"], [role="tab"], [class*="tab"], [class*="nav"]'
    );
    for (const el of clickables) {
      const text = (el.textContent || '').trim();
      if (text.length < 2 || text.length > 80) continue;
      if (regexes.some(r => r.test(text))) {
        results.push({
          text: text.substring(0, 50),
          tag: el.tagName.toLowerCase(),
          selector: el.id ? `#${el.id}` : (el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/)[0]}` : '')
        });
      }
    }
    return results.slice(0, 20);
  }, LEADERBOARD_BUTTON_PATTERNS.map(p => ({ source: p.source, flags: p.flags })));
}

// ============================================================================
// DETECTION: Pagination controls
// ============================================================================

/**
 * Detect pagination controls (next, load more, page 2, etc.)
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{type: string, text: string, visible: boolean}>>}
 */
async function detectPaginationControls(page) {
  return await page.evaluate((patterns) => {
    const results = [];
    const regexes = patterns.map(p => new RegExp(p.source, p.flags));
    const candidates = document.querySelectorAll(
      'button, a, [role="button"], [class*="pagination"], [class*="page"], [class*="load-more"], [class*="show-more"]'
    );
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (regexes.some(r => r.test(text))) {
        const rect = el.getBoundingClientRect();
        results.push({
          type: /next|more|load|show\s*more/i.test(text) ? 'load_more' : 'pagination',
          text: text.substring(0, 40),
          visible: rect.width > 0 && rect.height > 0
        });
      }
    }
    return results.slice(0, 10);
  }, PAGINATION_PATTERNS.map(p => ({ source: p.source, flags: p.flags })));
}

// ============================================================================
// DETECTION: Show N entries dropdown
// ============================================================================

/**
 * Detect dropdowns that control "show N entries" / "rows per page"
 * @param {import('playwright').Page} page
 * @returns {Promise<{found: boolean, options: number[], element?: Object}>}
 */
async function detectRowCountDropdown(page) {
  const result = await page.evaluate((rowPatterns) => {
    const regexes = rowPatterns.map(p => new RegExp(p.source, p.flags));
    const selects = document.querySelectorAll('select');
    for (const select of selects) {
      const label = (select.getAttribute('aria-label') || select.name || '').toLowerCase();
      const parentText = (select.closest('label')?.textContent || select.parentElement?.textContent || '').toLowerCase();
      const combined = `${label} ${parentText}`;
      if (!regexes.some(r => r.test(combined))) continue;

      const options = [];
      for (const opt of select.querySelectorAll('option')) {
        const val = opt.value;
        const num = parseInt(val, 10);
        if (!isNaN(num) && num > 0 && num <= 500) options.push(num);
      }
      if (options.length > 0) {
        return {
          found: true,
          options: [...new Set(options)].sort((a, b) => a - b),
          element: { tag: 'select', name: select.name, id: select.id }
        };
      }
    }
    return { found: false, options: [] };
  }, ROW_SELECTOR_PATTERNS.map(p => ({ source: p.source, flags: p.flags })));

  if (result.found) {
    log('UI', `Row count dropdown: options [${result.options.join(', ')}]`);
  }
  return result;
}

// ============================================================================
// MAX-ROWS SELECTION
// ============================================================================

const ROW_DROPDOWN_SELECTORS = [
  'select[aria-label*="show" i], select[aria-label*="entries" i], select[aria-label*="rows" i]',
  'select[name*="limit" i], select[name*="size" i], select[name*="per" i]',
  'label:has-text("show"), label:has-text("entries"), label:has-text("rows")'
];

/**
 * Select the maximum rows/entries option in a dropdown if present.
 * @param {import('playwright').Page} page
 * @param {Object} options - { maxRetries: number }
 * @returns {Promise<{success: boolean, selectedValue?: number, method: string}>}
 */
async function selectMaxRows(page, options = {}) {
  const { maxRetries = 2 } = options;

  const dropdown = await detectRowCountDropdown(page);
  if (!dropdown.found || dropdown.options.length === 0) {
    return { success: false, method: 'no_dropdown' };
  }

  const maxOption = Math.max(...dropdown.options);
  if (maxOption <= 0) return { success: false, method: 'no_valid_options' };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const selected = await page.evaluate((maxVal) => {
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          const opts = Array.from(select.querySelectorAll('option'));
          const values = opts.map(o => parseInt(o.value, 10)).filter(n => !isNaN(n) && n > 0);
          if (values.length === 0) continue;
          const maxAvailable = Math.max(...values);
          if (maxAvailable < maxVal) continue;
          const targetVal = values.includes(maxVal) ? maxVal : maxAvailable;
          select.value = String(targetVal);
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, value: targetVal };
        }
        return { success: false };
      }, maxOption);

      if (selected.success) {
        log('UI', `Selected max rows: ${selected.value} (attempt ${attempt})`);
        await page.waitForTimeout(800);
        return { success: true, selectedValue: selected.value, method: 'dropdown' };
      }
    } catch (e) {
      log('UI', `Max-rows select attempt ${attempt} failed: ${e.message}`);
    }
  }
  return { success: false, method: 'select_failed' };
}

// ============================================================================
// LEADERBOARD READINESS DETECTION
// ============================================================================

/**
 * Wait for leaderboard-ready state: stable DOM, optional network idle, row count stable.
 * @param {import('playwright').Page} page
 * @param {Object} options - { networkIdleMs?: number, rowStablePolls?: number, rowStableDelayMs?: number }
 * @returns {Promise<{ready: boolean, rowCount?: number, waitedMs: number}>}
 */
async function waitForLeaderboardReady(page, options = {}) {
  const {
    networkIdleMs = 2000,
    rowStablePolls = 3,
    rowStableDelayMs = 600
  } = options;

  const start = Date.now();

  try {
    if (networkIdleMs > 0) {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(Math.min(networkIdleMs, 3000));
    }
  } catch (e) {
    // ignore
  }

  let lastCount = 0;
  let stableCount = 0;
  let rowCount = 0;

  for (let i = 0; i < rowStablePolls; i++) {
    await page.waitForTimeout(rowStableDelayMs);
    const count = await page.evaluate(() => {
      const rowSelectors = [
        'tr[class*="row"]', 'tr[class*="entry"]', 'tr[class*="player"]',
        '[class*="leaderboard"] tr', '[class*="ranking"] tbody tr', '[class*="leaderboard"] [class*="entry"]',
        '[class*="leaderboard-entry"]', '[class*="player-row"]', '[data-rank]'
      ];
      const seen = new Set();
      for (const sel of rowSelectors) {
        try {
          document.querySelectorAll(sel).forEach(el => seen.add(el));
        } catch (e) {}
      }
      return seen.size;
    });
    rowCount = count;
    if (count === lastCount && count > 0) {
      stableCount++;
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
    }
    lastCount = count;
  }

  const ready = rowCount >= 0 && (stableCount >= 2 || rowStablePolls < 2);
  log('UI', `Leaderboard ready: ${ready}, rowCount≈${rowCount}, waited ${Date.now() - start}ms`);
  return { ready, rowCount, waitedMs: Date.now() - start };
}

// ============================================================================
// RETRY WRAPPER FOR UI ACTIONS
// ============================================================================

/**
 * Execute a UI action with retry
 * @param {Function} action - async () => Promise<{success: boolean}>
 * @param {Object} options - { maxRetries: number, delayMs: number }
 * @returns {Promise<{success: boolean, attempts: number}>}
 */
async function withUiRetry(action, options = {}) {
  const { maxRetries = 3, delayMs = 500 } = options;
  let lastResult = { success: false };
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      lastResult = await action();
      if (lastResult.success) return { success: true, attempts: attempt };
    } catch (e) {
      log('UI', `UI action attempt ${attempt} failed: ${e.message}`);
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, delayMs));
  }
  return { success: false, attempts: maxRetries };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  detectLeaderboardTabs,
  detectPaginationControls,
  detectRowCountDropdown,
  selectMaxRows,
  waitForLeaderboardReady,
  withUiRetry,
  LEADERBOARD_BUTTON_PATTERNS,
  ROW_SELECTOR_PATTERNS,
  PAGINATION_PATTERNS
};
