/**
 * UI Interaction Strategy Module - Leaderboard Discovery & Navigation Layer
 *
 * RESPONSIBILITY:
 * - Detect leaderboard tabs/buttons (heuristic: leaderboard, ranking, standings)
 * - Detect pagination controls
 * - Detect "show N entries" dropdowns (native <select> AND custom div-based)
 * - Max-rows selection logic (select largest option; fallback to Show All button)
 * - Leaderboard readiness detection (stable DOM, network idle, row count stabilization)
 * - Retry logic for UI actions
 *
 * CORE REQUIREMENT: Always select maximum number of users/entries before scraping
 * to avoid partial data (e.g. 10 of 500). Tries: native select → custom dropdown → Show All.
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
  /\busers?\b/i,           // BetJuicy: "Show X users"
  /\bper\s*page\b/i,
  /\bdisplay\b/i,
  /\bview\s*\d+/i,
  /\bamount\s*of\b/i,      // "amount of users"
  /\bpage\s*size\b/i,
  /\blimit\b/i
];

const PAGINATION_PATTERNS = [
  /\b(next|more|load\s*more|show\s*more|view\s*all)\b/i,
  /\bpage\s*\d+\b/i,
  /\b\d+\s*-\s*\d+\s*of\b/i,
  /[<>]\s*$/  // next/prev arrows
];

/** Max option value we accept (some leaderboards have 5000+ entries) */
const MAX_ROW_OPTION_CEILING = 10000;

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
// DETECTION: Show N entries dropdown (native <select>)
// ============================================================================

/**
 * Detect native <select> dropdowns that control "show N entries" / "rows per page".
 * Parses both option value AND option text (some sites use text="100" with value="100" or different).
 * @param {import('playwright').Page} page
 * @returns {Promise<{found: boolean, options: number[], element?: Object}>}
 */
async function detectRowCountDropdown(page) {
  const result = await page.evaluate(({ rowPatterns, maxCeiling }) => {
    const regexes = rowPatterns.map(p => new RegExp(p.source, p.flags));
    const selects = document.querySelectorAll('select');
    for (const select of selects) {
      const label = (select.getAttribute('aria-label') || select.name || '').toLowerCase();
      const parentText = (select.closest('label')?.textContent || select.parentElement?.textContent || '').toLowerCase();
      const combined = `${label} ${parentText}`;
      if (!regexes.some(r => r.test(combined))) continue;

      const options = new Set();
      for (const opt of select.querySelectorAll('option')) {
        const val = opt.value;
        const text = (opt.textContent || '').trim();
        const numFromVal = parseInt(val, 10);
        const numFromText = parseInt(text.replace(/[^\d]/g, ''), 10);
        if (!isNaN(numFromVal) && numFromVal > 0 && numFromVal <= maxCeiling) options.add(numFromVal);
        if (!isNaN(numFromText) && numFromText > 0 && numFromText <= maxCeiling) options.add(numFromText);
      }
      const sorted = [...options].sort((a, b) => a - b);
      if (sorted.length > 0) {
        return {
          found: true,
          options: sorted,
          element: { tag: 'select', name: select.name, id: select.id }
        };
      }
    }
    return { found: false, options: [] };
  }, {
    rowPatterns: ROW_SELECTOR_PATTERNS.map(p => ({ source: p.source, flags: p.flags })),
    maxCeiling: MAX_ROW_OPTION_CEILING
  });

  if (result.found) {
    log('UI', `Row count dropdown (native): options [${result.options.join(', ')}]`);
  }
  return result;
}

// ============================================================================
// DETECTION: Custom dropdown (div-based, MUI, Ant Design, Chakra, etc.)
// ============================================================================

/**
 * Detect custom div-based dropdowns that control row count.
 * Looks for: role=combobox, role=listbox, [class*="Select"], [class*="dropdown"] with number options.
 * Scopes to leaderboard area (near "Challengers", "leaderboard", table).
 * @param {import('playwright').Page} page
 * @returns {Promise<{found: boolean, options: number[], triggerSelector?: string}>}
 */
async function detectCustomRowDropdown(page) {
  const result = await page.evaluate(({ rowPatterns, maxCeiling }) => {
    const regexes = rowPatterns.map(p => new RegExp(p.source, p.flags));

    function parseNumber(text) {
      const m = (text || '').match(/\d+/);
      return m ? parseInt(m[0], 10) : NaN;
    }

    function isInLeaderboardContext(el) {
      const body = document.body.innerHTML.toLowerCase();
      if (!body.includes('leaderboard') && !body.includes('challenger') && !body.includes('ranking')) return true;
      const root = el.closest('[class*="leaderboard"], [class*="ranking"], [class*="table"], [class*="challenger"]') || document.body;
      return root && root.querySelector('[class*="leaderboard"], [class*="ranking"], [class*="challenger"], table');
    }

    const candidates = [];

    // 1. role=combobox or role=listbox
    const combos = document.querySelectorAll('[role="combobox"], [role="listbox"], [role="button"][aria-haspopup="listbox"]');
    for (const el of combos) {
      const ctx = el.closest('label, div, [class*="select"], [class*="dropdown"], [class*="picker"]') || el.parentElement;
      const text = (ctx?.textContent || el.textContent || '').toLowerCase();
      if (!regexes.some(r => r.test(text))) continue;
      const num = parseNumber(el.textContent || el.getAttribute('aria-label') || '');
      if (!isNaN(num) && num > 0 && num <= maxCeiling) candidates.push({ el, num, type: 'combobox' });
    }

    // 2. Elements with "Show X" / "X users" pattern in leaderboard area
    const allClickables = document.querySelectorAll(
      'div[class*="select"], div[class*="dropdown"], div[class*="picker"], [class*="Select"], [class*="Dropdown"], [class*="menu"]'
    );
    const PAGE_SIZE_VALUES = new Set([10, 20, 25, 30, 50, 100, 250, 500, 1000, 5000]);
    for (const el of allClickables) {
      if (!isInLeaderboardContext(el)) continue;
      const parent = el.closest('div, label') || el;
      const text = (parent.textContent || el.textContent || '').toLowerCase();
      if (!regexes.some(r => r.test(text))) continue;

      const nums = [...(parent.textContent || '').matchAll(/\b(\d+)\b/g)].map(m => parseInt(m[1], 10))
        .filter(n => !isNaN(n) && n > 0 && n <= maxCeiling && (PAGE_SIZE_VALUES.has(n) || n >= 50));
      if (nums.length > 0) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          candidates.push({ el, options: [...new Set(nums)], type: 'custom' });
        }
      }
    }

    // 3. BetJuicy-style: "Show" + number + "User" - container or number element
    const containers = document.querySelectorAll('div, span, [role="button"]');
    for (const el of containers) {
      const text = (el.textContent || '').trim();
      if (text.length > 5 && text.length < 100 && /show\s*\d+\s*(user|entry|row)/i.test(text)) {
        const nums = [...text.matchAll(/\b(\d+)\b/g)].map(m => parseInt(m[1], 10))
          .filter(n => n >= 10 && n <= maxCeiling);
        if (nums.length > 0) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 15) {
            candidates.push({ el, options: [...new Set(nums)], type: 'show_user' });
          }
        }
      }
    }

    // 4. Sibling pattern: "Show" | "10" | "User" or "Show" | "50" (BetJuicy - SHOW + number box)
    const all = document.querySelectorAll('div, span, button, [role="button"]');
    for (const el of all) {
      const parent = el.parentElement;
      if (!parent) continue;
      const sibText = Array.from(parent.children).map(c => (c.textContent || '').trim()).join(' ');
      const num = parseInt((el.textContent || '').replace(/[^\d]/g, '').trim(), 10);
      const isPageSize = !isNaN(num) && num >= 10 && num <= maxCeiling && (PAGE_SIZE_VALUES.has(num) || num <= 100);
      if (isPageSize) {
        const matchShowUser = /show\s+\d+\s+user/i.test(sibText) || /show\s+\d+\s+entr/i.test(sibText);
        const matchShowNum = /show/i.test(sibText) && /\d+/.test(sibText) && sibText.split(/\s+/).some(w => /^\d+$/.test(w));
        if (matchShowUser || matchShowNum) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 5 && rect.height > 5) {
            const opts = [...new Set([num, 10, 20, 30, 50, 100].filter(n => n >= 10 && n <= maxCeiling))];
            candidates.push({ el, options: opts, type: 'sibling_show', triggerParent: parent });
          }
        }
      }
    }

    // 5. BetJuicy SHOW + number box: parent has "show" and "challenger", child shows single number
    const challengerSection = document.querySelector('[class*="challenger"], [class*="Challenger"]') || document.body;
    const nearChallenger = challengerSection.querySelectorAll('div, span, button, [role="button"]');
    for (const el of nearChallenger) {
      const text = (el.textContent || '').trim().replace(/[^\d]/g, '');
      const num = parseInt(text, 10);
      if (!isNaN(num) && PAGE_SIZE_VALUES.has(num)) {
        const ancestor = el.closest('div');
        if (ancestor && /show/i.test(ancestor.textContent || '')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 10 && rect.height > 10) {
            candidates.push({ el, options: [10, 20, 30, 50].filter(n => n <= maxCeiling), type: 'betjuicy_show', triggerParent: ancestor });
          }
        }
      }
    }

    if (candidates.length === 0) return { found: false, options: [] };

    // Prefer specific trigger (number element) over container - smaller rect = more specific
    const best = candidates.sort((a, b) => {
      const ra = a.el.getBoundingClientRect();
      const rb = b.el.getBoundingClientRect();
      const areaA = ra.width * ra.height;
      const areaB = rb.width * rb.height;
      const preferA = ['betjuicy_show', 'sibling_show'].includes(a.type);
      const preferB = ['betjuicy_show', 'sibling_show'].includes(b.type);
      if (preferA && !preferB) return -1;
      if (!preferA && preferB) return 1;
      return areaA - areaB;
    })[0];
    const options = best.options || (best.num != null ? [best.num] : []);
    if (options.length === 0) return { found: false, options: [] };

    const sorted = [...new Set(options)].sort((a, b) => a - b);
    const rect = best.el.getBoundingClientRect();
    const triggerCoords = rect.width > 0 && rect.height > 0
      ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      : null;
    // For BetJuicy/sibling: return parent container coords so we click the full dropdown trigger, not just the number
    let triggerParentCoords = null;
    const parentEl = best.triggerParent || (best.el.parentElement && /show/i.test((best.el.parentElement.textContent || '')) ? best.el.parentElement : null);
    if (parentEl && (best.type === 'betjuicy_show' || best.type === 'sibling_show')) {
      const pr = parentEl.getBoundingClientRect();
      if (pr.width > 20 && pr.height > 10) triggerParentCoords = { x: pr.x + pr.width / 2, y: pr.y + pr.height / 2 };
    }
    return {
      found: true,
      options: sorted,
      triggerSelector: best.el.id ? `#${best.el.id}` : null,
      triggerCoords,
      triggerParentCoords,
      candidateType: best.type
    };
  }, {
    rowPatterns: ROW_SELECTOR_PATTERNS.map(p => ({ source: p.source, flags: p.flags })),
    maxCeiling: MAX_ROW_OPTION_CEILING
  });

  if (result.found) {
    log('UI', `Row count dropdown (custom): options [${result.options.join(', ')}]`);
  }
  return result;
}

// ============================================================================
// DETECTION: "Show All" / "View All" button
// ============================================================================

const SHOW_ALL_PATTERNS = [
  /\bshow\s*all\b/i,
  /\bview\s*all\b/i,
  /\bdisplay\s*all\b/i,
  /\bload\s*all\b/i
];

/**
 * Find a "Show All" / "View All" button that expands the full leaderboard.
 * @param {import('playwright').Page} page
 * @returns {Promise<{found: boolean, text?: string}>}
 */
async function detectShowAllButton(page) {
  const result = await page.evaluate((patterns) => {
    const regexes = patterns.map(p => new RegExp(p.source, p.flags));
    const buttons = document.querySelectorAll('button, a, [role="button"], [class*="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.length < 4 || text.length > 30) continue;
      if (regexes.some(r => r.test(text))) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 10) {
          return { found: true, text };
        }
      }
    }
    return { found: false };
  }, SHOW_ALL_PATTERNS.map(p => ({ source: p.source, flags: p.flags })));

  if (result.found) {
    log('UI', `Show All button found: "${result.text}"`);
  }
  return result;
}

// ============================================================================
// MAX-ROWS SELECTION: Native <select>
// ============================================================================

const ROW_DROPDOWN_SELECTORS = [
  'select[aria-label*="show" i], select[aria-label*="entries" i], select[aria-label*="rows" i]',
  'select[name*="limit" i], select[name*="size" i], select[name*="per" i]',
  'label:has-text("show"), label:has-text("entries"), label:has-text("rows")'
];

/**
 * Select the maximum rows option in a native <select> dropdown.
 */
async function selectMaxRowsNative(page, options = {}) {
  const { maxRetries = 2 } = options;
  const dropdown = await detectRowCountDropdown(page);
  if (!dropdown.found || dropdown.options.length === 0) {
    return { success: false, method: 'no_dropdown' };
  }

  const maxOption = Math.max(...dropdown.options);
  if (maxOption <= 0) return { success: false, method: 'no_valid_options' };

  const patternSources = ROW_SELECTOR_PATTERNS.map(p => p.source);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const selected = await page.evaluate(({ maxVal, patterns, maxCeiling }) => {
        const regexes = patterns.map(s => new RegExp(s, 'i'));
        const selects = document.querySelectorAll('select');
        for (const select of selects) {
          const label = (select.getAttribute('aria-label') || select.name || '').toLowerCase();
          const parentText = (select.closest('label')?.textContent || select.parentElement?.textContent || '').toLowerCase();
          const combined = `${label} ${parentText}`;
          if (!regexes.some(r => r.test(combined))) continue;

          const opts = Array.from(select.querySelectorAll('option'));
          const values = opts.flatMap(o => {
            const v = parseInt(o.value, 10);
            const t = parseInt((o.textContent || '').replace(/[^\d]/g, ''), 10);
            return [v, t].filter(n => !isNaN(n) && n > 0 && n <= maxCeiling);
          });
          const uniq = [...new Set(values)];
          if (uniq.length === 0) continue;
          const maxAvailable = Math.max(...uniq);
          const targetVal = uniq.includes(maxVal) ? maxVal : maxAvailable;
          select.value = String(targetVal);
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
          return { success: true, value: targetVal };
        }
        return { success: false };
      }, { maxVal: maxOption, patterns: patternSources, maxCeiling: MAX_ROW_OPTION_CEILING });

      if (selected.success) {
        log('UI', `Selected max rows (native): ${selected.value}`);
        await page.waitForTimeout(1500);
        return { success: true, selectedValue: selected.value, method: 'native_select' };
      }
    } catch (e) {
      log('UI', `Native select attempt ${attempt} failed: ${e.message}`);
    }
  }
  return { success: false, method: 'native_select_failed' };
}

// ============================================================================
// MAX-ROWS SELECTION: Custom dropdown (click trigger → click max option)
// ============================================================================

/**
 * Select max rows in a custom div-based dropdown.
 * Uses multiple strategies: coords click, elementFromPoint, Playwright locators, keyboard nav.
 */
async function selectMaxRowsCustom(page, options = {}) {
  const { maxRetries = 3 } = options;

  const dropdown = await detectCustomRowDropdown(page);
  if (!dropdown.found || dropdown.options.length === 0) {
    return { success: false, method: 'no_custom_dropdown' };
  }

  const maxOption = Math.max(...dropdown.options);
  if (maxOption <= 0) return { success: false, method: 'no_valid_options' };

  await page.waitForSelector('[class*="challenger"], [class*="Challenger"], [class*="leaderboard"]', { state: 'visible', timeout: 3000 }).catch(() => {});

  const scrollToDropdownArea = async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[class*="challenger"], [class*="Challenger"], [class*="leaderboard"]');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await page.waitForTimeout(200);
  };

  const openTrigger = async () => {
    await scrollToDropdownArea();

    // PDF: wait for dropdown to be visible before clicking
    await page.waitForSelector('[class*="challenger"], [class*="Challenger"], [class*="leaderboard"], [class*="select"], [class*="dropdown"]', { state: 'visible', timeout: 2000 }).catch(() => {});

    // Prefer parent container click for BetJuicy-style dropdowns (opens the actual trigger, not just the value)
    const coordsToUse = dropdown.triggerParentCoords && dropdown.triggerParentCoords.x > 0
      ? dropdown.triggerParentCoords
      : dropdown.triggerCoords;
    if (coordsToUse && coordsToUse.x > 0 && coordsToUse.y > 0) {
      log('UI', `Clicking dropdown trigger at (${Math.round(coordsToUse.x)}, ${Math.round(coordsToUse.y)})${dropdown.triggerParentCoords ? ' (parent container)' : ''}`);
      const triggerClick = async (c) => {
        const clicked = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (el) {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.click();
            return true;
          }
          return false;
        }, c);
        if (clicked) return true;
        await page.mouse.move(c.x, c.y);
        await page.mouse.down();
        await page.waitForTimeout(50);
        await page.mouse.up();
        return true;
      };
      await triggerClick(coordsToUse);
      return true;
    }

    const coords = await page.evaluate(({ maxCeiling }) => {
      const PAGE_SIZE = new Set([10, 20, 25, 30, 50, 100]);
      const inTable = (el) => el.closest('tr, tbody');
      const nearShow = (el) => {
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          if (/show\s*\d*\s*(user|entr|row)?/i.test((p.textContent || '').slice(0, 200))) return true;
        }
        return false;
      };
      const roots = document.querySelectorAll('[class*="challenger"], [class*="Challenger"], [class*="leaderboard"], [class*="table"]');
      const scope = roots.length ? roots[roots.length - 1] : document.body;
      const all = scope.querySelectorAll('div, span, button, [role="button"], [tabindex]');
      for (const el of all) {
        if (inTable(el)) continue;
        const raw = (el.textContent || '').trim();
        const num = parseInt(raw.replace(/[^\d]/g, ''), 10);
        if (!PAGE_SIZE.has(num) || num > maxCeiling) continue;
        if (!nearShow(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 6 || rect.height < 4) continue;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    }, { maxCeiling: MAX_ROW_OPTION_CEILING });

    if (coords && coords.x > 0) {
      const clicked = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el) { el.click(); return true; }
        return false;
      }, coords);
      if (clicked) return true;
      await page.mouse.click(coords.x, coords.y);
      return true;
    }

    const challengerScope = page.locator('[class*="challenger"], [class*="Challenger"], [class*="leaderboard"]').first();
    for (const n of [50, 100, 30, 25, 20, 10]) {
      if (n > maxOption) continue;
      try {
        const loc = challengerScope.getByText(String(n), { exact: true }).first();
        if (await loc.isVisible({ timeout: 150 }).catch(() => false)) {
          await loc.click({ force: true });
          return true;
        }
      } catch (e) {}
      const simple = page.getByText(String(n), { exact: true }).first();
      if (await simple.isVisible({ timeout: 100 }).catch(() => false)) {
        const box = await simple.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          return true;
        }
      }
    }

    const combobox = page.getByRole('combobox').filter({ hasText: /show|^\d+$|user|entr/i }).first();
    if (await combobox.isVisible({ timeout: 200 }).catch(() => false)) {
      await combobox.click({ force: true });
      return true;
    }
    const listboxTrigger = challengerScope.locator('[aria-haspopup="listbox"]').first();
    if (await listboxTrigger.isVisible({ timeout: 200 }).catch(() => false)) {
      await listboxTrigger.click({ force: true });
      return true;
    }
    return false;
  };

  const selectMaxOption = async () => {
    // PDF: wait for dropdown options to appear before clicking
    try {
      await page.waitForSelector('[role="listbox"], [role="menu"], [role="option"], [class*="dropdown"] [role="option"], [class*="menu"]', { state: 'visible', timeout: 2000 });
    } catch (e) {
      await page.waitForTimeout(500);
    }

    // First: try role=option (dropdown option) for max value – most reliable for Radix/custom selects
    try {
      const optionByRole = page.getByRole('option', { name: String(maxOption) }).first();
      if (await optionByRole.isVisible({ timeout: 600 }).catch(() => false)) {
        await optionByRole.click({ force: true });
        return maxOption;
      }
    } catch (e) {}
    // Fallback: any visible exact text match for maxOption (e.g. "100") not inside a table
    try {
      const visibleOption = page.getByText(String(maxOption), { exact: true }).first();
      if (await visibleOption.isVisible({ timeout: 400 }).catch(() => false)) {
        const inTable = await visibleOption.evaluate((el) => !!el.closest('table')).catch(() => false);
        if (!inTable) {
          await visibleOption.click({ force: true });
          return maxOption;
        }
      }
    } catch (e) {}

    const optionCoords = await page.evaluate(({ targetVal }) => {
      const panelSel = '[role="listbox"], [role="menu"], [class*="dropdown"], [class*="menu"], [class*="options"], [class*="option"], [data-radix-popper-content-wrapper], [data-radix-select-content], [class*="content"][role="listbox"]';
      let panels = document.querySelectorAll(panelSel);
      if (panels.length === 0) {
        panels = document.querySelectorAll('[data-radix-portal] [role="listbox"], [data-radix-portal] [role="menu"], body > div [role="listbox"]');
      }
      for (const panel of panels) {
        const s = window.getComputedStyle(panel);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
        const rect = panel.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) continue;
        const items = panel.querySelectorAll('[role="option"], [role="menuitem"], li, div, span');
        let best = null, bestNum = 0;
        for (const item of items) {
          const raw = (item.textContent || '').trim();
          const t = raw.replace(/[^\d]/g, '');
          const n = parseInt(t, 10);
          const exactMatch = raw === String(targetVal) || t === String(targetVal);
          if ((n >= targetVal && n > bestNum) || exactMatch) { bestNum = Math.max(bestNum, n); best = item; }
          if (/all/i.test(item.textContent || '')) { best = item; bestNum = 99999; break; }
        }
        if (best) {
          const r = best.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      const allWithNum = document.querySelectorAll('div, span, li, [role="option"], [role="menuitem"]');
      for (const el of allWithNum) {
        const raw = (el.textContent || '').trim();
        if (raw === String(targetVal) && !el.closest('table')) {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          if (r.width > 5 && r.height > 5 && r.top >= 0 && r.left >= 0 && s.visibility !== 'hidden' && s.display !== 'none') return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, { targetVal: maxOption });

    if (optionCoords && optionCoords.x > 0) {
      const didClick = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el) { el.click(); return true; }
        return false;
      }, optionCoords);
      if (didClick) return maxOption;
      await page.mouse.click(optionCoords.x, optionCoords.y);
      return maxOption;
    }

    for (const role of ['listbox', 'menu']) {
      const loc = page.getByRole(role).getByText(String(maxOption), { exact: true }).first();
      if (await loc.isVisible({ timeout: 200 }).catch(() => false)) {
        await loc.click({ force: true });
        return maxOption;
      }
    }
    const panel = page.locator('[class*="dropdown"], [class*="menu"], [class*="options"]').filter({ has: page.getByText(String(maxOption), { exact: true }) }).first();
    if (await panel.isVisible({ timeout: 200 }).catch(() => false)) {
      await panel.getByText(String(maxOption), { exact: true }).first().click({ force: true });
      return maxOption;
    }

    return null;
  };

  const tryKeyboardNav = async () => {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(80);
      const focused = await page.evaluate(() => (document.activeElement?.textContent || '').trim());
      if (/^\d+$/.test(focused) && [10, 20, 30, 50, 100].includes(parseInt(focused, 10))) {
        await page.keyboard.press('Space');
        await page.waitForTimeout(500);
        const arrows = maxOption === 100 ? 4 : maxOption === 50 ? 3 : maxOption === 30 ? 2 : maxOption === 20 ? 1 : 0;
        for (let a = 0; a < arrows; a++) {
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(50);
        }
        await page.keyboard.press('Enter');
        return maxOption;
      }
    }
    return null;
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const opened = await openTrigger();
      if (!opened) continue;

      await page.waitForTimeout(700);
      await page.waitForSelector('[role="listbox"], [role="menu"], [class*="dropdown"], [class*="menu"], [class*="options"], [data-radix-popper-content-wrapper], [data-radix-select-content], [data-state="open"]', { state: 'visible', timeout: 4000 }).catch(() => {});

      let selected = await selectMaxOption();
      if (!selected && attempt === 1) selected = await tryKeyboardNav();
      // If still no selection, try opening with keyboard (ArrowDown on trigger) then select again
      if (!selected && (dropdown.triggerParentCoords || dropdown.triggerCoords)) {
        const k = dropdown.triggerParentCoords || dropdown.triggerCoords;
        await page.mouse.click(k.x, k.y);
        await page.waitForTimeout(300);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(500);
        selected = await selectMaxOption();
      }

      if (selected) {
        log('UI', `Selected max rows (custom): ${selected}`);
        await page.waitForTimeout(1500);
        return { success: true, selectedValue: selected, method: 'custom_dropdown' };
      }

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } catch (e) {
      log('UI', `Custom dropdown attempt ${attempt} failed: ${e.message}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  return { success: false, method: 'custom_dropdown_failed' };
}

// ============================================================================
// MAX-ROWS SELECTION: "Show All" button
// ============================================================================

/**
 * Click "Show All" / "View All" button if present.
 */
async function clickShowAllButton(page, options = {}) {
  const { maxRetries = 2 } = options;
  const detected = await detectShowAllButton(page);
  if (!detected.found) return { success: false, method: 'no_show_all_button' };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const clicked = await page.click(`button:has-text("Show All"), button:has-text("View All"), button:has-text("Display All"), a:has-text("Show All"), a:has-text("View All")`, { timeout: 2000 }).then(() => true).catch(() => false);
      if (clicked) {
        log('UI', 'Clicked Show All / View All button');
        await page.waitForTimeout(1500);
        return { success: true, method: 'show_all_button' };
      }
    } catch (e) {
      log('UI', `Show All click attempt ${attempt} failed: ${e.message}`);
    }
  }
  return { success: false, method: 'show_all_failed' };
}

// ============================================================================
// MAIN: Select maximum entries (orchestrates all strategies)
// ============================================================================

/**
 * ALWAYS select the maximum number of users/entries before scraping.
 * Prevents partial data (e.g. 10 of 500).
 *
 * Strategy order:
 * 1. Native <select> dropdown → select largest option
 * 2. Custom div-based dropdown (MUI, Ant Design, etc.) → click trigger, select max
 * 3. "Show All" / "View All" button → click
 *
 * @param {import('playwright').Page} page
 * @param {Object} options - { maxRetries?: number }
 * @returns {Promise<{success: boolean, method: string, selectedValue?: number}>}
 */
async function selectMaximumEntries(page, options = {}) {
  const { maxRetries = 2 } = options;
  log('UI', 'Selecting maximum entries (required for full leaderboard capture)...');

  const strategies = [
    { name: 'native_select', fn: () => selectMaxRowsNative(page, { maxRetries }) },
    { name: 'custom_dropdown', fn: () => selectMaxRowsCustom(page, { maxRetries }) },
    { name: 'show_all', fn: () => clickShowAllButton(page, { maxRetries }) }
  ];

  for (const s of strategies) {
    const result = await s.fn();
    if (result.success) {
      log('UI', `Maximum entries selected via ${result.method}`);
      return result;
    }
  }

  log('UI', 'No row-count dropdown or Show All button found (page may show full list by default)');
  return { success: false, method: 'none_found' };
}

/**
 * Legacy alias for selectMaximumEntries.
 * @deprecated Use selectMaximumEntries for full strategy chain.
 */
async function selectMaxRows(page, options = {}) {
  return selectMaximumEntries(page, options);
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
  detectCustomRowDropdown,
  detectShowAllButton,
  selectMaxRows,
  selectMaximumEntries,
  selectMaxRowsNative,
  selectMaxRowsCustom,
  clickShowAllButton,
  waitForLeaderboardReady,
  withUiRetry,
  LEADERBOARD_BUTTON_PATTERNS,
  ROW_SELECTOR_PATTERNS,
  PAGINATION_PATTERNS,
  MAX_ROW_OPTION_CEILING
};
