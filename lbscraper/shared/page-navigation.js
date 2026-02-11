/**
 * Navigation Module for Leaderboard Scraper
 * 
 * Handles page navigation, challenge bypass integration, and leaderboard discovery
 */

const { log } = require('./utils');

// Standard leaderboard paths to try
const LEADERBOARD_PATHS = [
  '/leaderboards',
  '/leaderboard',
  '/affiliate/leaderboard',
  '/rewards/leaderboard',
  '/promo/leaderboard',
  '/lb',
  '/rankings',
  '/race',
  '/competition',
  '/top'
];

// ============================================================================
// CHALLENGE BYPASS INTEGRATION
// ============================================================================

let challengeBypass = null;

/**
 * Initialize challenge bypass module
 * @param {Object} bypassModule - The challenge-bypass module
 */
function initChallengeBypass(bypassModule) {
  challengeBypass = bypassModule;
}

/**
 * Handle Cloudflare and other challenges
 * @param {Page} page - Playwright page instance
 * @returns {Object} - Result of challenge handling
 */
async function handleChallenge(page) {
  if (!challengeBypass) {
    return { success: true, type: 'none', method: 'no_bypass_module' };
  }
  return await challengeBypass.handleChallenge(page);
}

/**
 * Check if page has a challenge
 * @param {Page} page - Playwright page instance
 * @returns {boolean} - True if challenge detected
 */
async function hasChallenge(page) {
  if (!challengeBypass) {
    return false;
  }
  return await challengeBypass.hasChallenge(page);
}

/**
 * Check and bypass challenge if present
 * @param {Page} page - Playwright page instance
 * @returns {boolean} - True if no challenge or bypass succeeded
 */
async function checkAndBypassChallenge(page) {
  const blocked = await hasChallenge(page);
  
  if (blocked) {
    log('CLICK', 'Challenge detected, attempting bypass...');
    const result = await handleChallenge(page);
    
    if (result.success) {
      log('CLICK', `Challenge bypassed via: ${result.method}`);
      return true;
    } else {
      log('ERR', `Challenge bypass failed: ${result.error}`);
      return false;
    }
  }
  
  return true;
}

// ============================================================================
// NAVIGATION WITH BYPASS
// ============================================================================

/**
 * Navigate to URL with challenge bypass
 * @param {Page} page - Playwright page instance
 * @param {string} url - URL to navigate to
 * @param {Object} options - Navigation options
 * @returns {Object} - Navigation result
 */
async function navigateWithBypass(page, url, options = {}) {
  const {
    timeout = 15000,
    maxRetries = 3,
    retryDelayMs = 2000,
    waitAfterLoad = 3000,  // Extra wait time for JS rendering after page load
    waitForSelector = null  // Optional: proceed as soon as this selector appears (PDF: waitForSelector on key element)
  } = options;

  // PDF: use domcontentloaded then wait for key element to proceed as soon as possible
  const leaderboardSelectors = waitForSelector || 'table, [class*="leaderboard"], [class*="ranking"], [class*="challenger"], [class*="table"]';

  log('CLICK', `Navigating to: ${url}`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      } catch (navError) {
        const currentUrl = page.url();
        if (currentUrl && currentUrl !== 'about:blank' && currentUrl.startsWith('http')) {
          log('CLICK', 'Navigation incomplete but page loaded, continuing...');
        } else {
          throw navError;
        }
      }
      
      // PDF: short initial wait, then wait for leaderboard-like element (proceed as soon as possible)
      await page.waitForTimeout(800);
      try {
        await page.waitForSelector(leaderboardSelectors, { timeout: 10000 });
        log('CLICK', 'Leaderboard content detected, proceeding');
      } catch (e) {
        // No matching element; continue with challenge check and network wait
      }
      
      const challengeResult = await handleChallenge(page);
      
      if (challengeResult.success) {
        if (challengeResult.type !== 'none') {
          log('CLICK', `Challenge bypassed (${challengeResult.type}) via: ${challengeResult.method}`);
        }
        
        // Wait for network to settle (API calls, lazy loading, etc.)
        try {
          await page.waitForLoadState('networkidle', { timeout: 15000 });
        } catch (e) {
          await page.waitForTimeout(3000);
        }
        
        // Extra wait for JavaScript rendering (React, Vue, etc. SPA content)
        await page.waitForTimeout(waitAfterLoad);
        log('CLICK', `Page loaded, waited ${waitAfterLoad}ms for content rendering`);
        
        return { success: true, url: page.url(), challengeBypassed: challengeResult.type !== 'none' };
      } else {
        log('CLICK', `Challenge bypass failed (attempt ${attempt}/${maxRetries}): ${challengeResult.error}`);
        
        if (attempt < maxRetries) {
          const context = page.context();
          await context.clearCookies();
          await page.waitForTimeout(retryDelayMs);
        }
      }
    } catch (error) {
      log('ERR', `Navigation error (attempt ${attempt}/${maxRetries}): ${error.message}`);
      
      if (attempt < maxRetries) {
        await page.waitForTimeout(retryDelayMs);
      }
    }
  }
  
  return { success: false, error: 'Failed to navigate/bypass after all attempts' };
}

// ============================================================================
// LEADERBOARD PAGE DISCOVERY
// ============================================================================

/**
 * Find leaderboard page by trying standard paths
 * @param {Page} page - Playwright page instance
 * @param {string} baseDomain - Base domain URL
 * @returns {string|null} - Leaderboard URL or null if not found
 */
async function findLeaderboardPage(page, baseDomain) {
  log('CLICK', 'Checking standard leaderboard paths...');
  
  console.log(`   📍 Loading base domain: ${baseDomain}`);
  try {
    await page.goto(baseDomain, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
  } catch (e) {
    console.log(`   ⚠️ Base domain load incomplete, continuing...`);
  }
  
  console.log(`   ⏳ Waiting for page to render...`);
  await page.waitForTimeout(4000);
  
  console.log(`   🔍 Checking for Cloudflare...`);
  const challengeResult = await handleChallenge(page);
  
  if (challengeResult.type !== 'none') {
    if (challengeResult.success) {
      console.log(`   ✅ Cloudflare bypassed (${challengeResult.type})`);
    } else {
      console.log(`   ⚠️ Cloudflare detected but bypass reported failure, continuing anyway...`);
    }
    await page.waitForTimeout(3000);
  } else {
    console.log(`   ✅ No Cloudflare detected`);
  }
  
  console.log(`   🔎 Checking leaderboard paths...`);
  
  for (const lbPath of LEADERBOARD_PATHS) {
    const testUrl = baseDomain + lbPath;
    console.log(`   Testing: ${testUrl}`);
    
    try {
      const response = await page.goto(testUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      
      const status = response?.status() || 0;
      
      if (status === 404) {
        console.log(`   ❌ ${lbPath} - 404 Not Found`);
        continue;
      }
      
      console.log(`   ⏳ Waiting for content to load...`);
      await page.waitForTimeout(4000);
      
      try {
        await page.waitForLoadState('networkidle', { timeout: 8000 });
      } catch (e) {
        // Continue anyway
      }
      
      const isLeaderboard = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        const html = document.documentElement.innerHTML.toLowerCase();
        
        const hasLeaderboardWord = text.includes('leaderboard') || html.includes('leaderboard');
        const hasRankings = text.includes('wagered') || text.includes('wager') ||
                           text.includes('prize') || text.includes('reward');
        const hasRankNumbers = /#\d+|rank\s*\d+|1st|2nd|3rd/i.test(text);
        
        return hasLeaderboardWord || (hasRankings && hasRankNumbers);
      });
      
      if (isLeaderboard) {
        log('CLICK', `Found leaderboard at: ${testUrl}`);
        return testUrl;
      } else {
        console.log(`   ❌ ${lbPath} exists but doesn't look like a leaderboard`);
      }
    } catch (e) {
      const errorMsg = e.message.split('\n')[0];
      if (errorMsg.includes('timeout')) {
        console.log(`   ❌ ${lbPath} - Timeout`);
      } else {
        console.log(`   ❌ ${lbPath} - ${errorMsg}`);
      }
    }
  }
  
  console.log('   ❌ No standard leaderboard path found');
  return null;
}

// ============================================================================
// LEADERBOARD PAGE DETECTION
// ============================================================================

/**
 * Check if we're still on a leaderboard page
 * @param {Page} page - Playwright page instance
 * @param {string|null} expectedUrl - Expected leaderboard URL
 * @returns {boolean} - True if current page appears to be a leaderboard
 */
async function isOnLeaderboardPage(page, expectedUrl = null) {
  const currentUrl = page.url().toLowerCase();
  const pageContent = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    return {
      hasLeaderboardIndicators: 
        text.includes('wagered') || 
        text.includes('leaderboard') || 
        text.includes('prize pool') ||
        text.includes('ranking') ||
        /\$[\d,]+/.test(text),
      hasNavigationIndicators:
        text.includes('games') && text.includes('bonuses') && text.includes('news'),
      title: document.title,
      textLength: text.length
    };
  });
  
  // Check URL
  const urlIndicatesLeaderboard = 
    currentUrl.includes('leaderboard') || 
    currentUrl.includes('ranking') ||
    currentUrl.includes('/lb');
  
  // If URL changed away from expected leaderboard URL
  if (expectedUrl) {
    try {
      const expectedPath = new URL(expectedUrl).pathname;
      if (!currentUrl.includes(expectedPath)) {
        log('NAV', `URL changed from expected: ${expectedUrl} → ${currentUrl}`);
        return false;
      }
    } catch (e) {}
  }
  
  // If page content looks like navigation menu rather than leaderboard
  if (pageContent.hasNavigationIndicators && !pageContent.hasLeaderboardIndicators) {
    log('NAV', 'Page content looks like navigation menu, not leaderboard');
    return false;
  }
  
  return pageContent.hasLeaderboardIndicators || urlIndicatesLeaderboard;
}

/**
 * Recovery function - go back to leaderboard page
 * @param {Page} page - Playwright page instance
 * @param {string} leaderboardUrl - URL to recover to
 * @param {Object} networkData - Network data (for context)
 * @returns {boolean} - True if recovery succeeded
 */
async function recoverToLeaderboard(page, leaderboardUrl, networkData) {
  log('NAV', `Recovering to leaderboard: ${leaderboardUrl}`);
  
  // Try browser back first
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 });
    await page.waitForTimeout(1000);
    
    if (await isOnLeaderboardPage(page, leaderboardUrl)) {
      log('NAV', 'Recovery successful via browser back');
      return true;
    }
  } catch (e) {
    log('NAV', 'Browser back failed, navigating directly');
  }
  
  // Navigate directly
  const navResult = await navigateWithBypass(page, leaderboardUrl);
  if (navResult.success) {
    await page.waitForTimeout(2000);
    log('NAV', 'Recovery successful via direct navigation');
    return true;
  }
  
  log('NAV', 'Recovery failed');
  return false;
}

// ============================================================================
// URL PATTERN DETECTION
// ============================================================================

/**
 * Detect URL patterns for leaderboard navigation
 * Looks for patterns like /leaderboard/{keyword} in page links
 * 
 * @param {Page} page - Playwright page instance
 * @param {Array} keywords - Keywords to search for
 * @param {string} basePath - Base path (e.g., /leaderboard)
 * @returns {Object} - { hasPattern, pattern, examples }
 */
async function detectUrlPattern(page, keywords, basePath) {
  try {
    // Wrap arguments in a single object for page.evaluate
    const args = { kws: keywords, base: basePath };
    
    const patternInfo = await page.evaluate((params) => {
      const { kws } = params;
      const links = Array.from(document.querySelectorAll('a[href]'));
      const patterns = [];
      const examples = [];
      
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const fullHref = link.href || '';
        
        // Check if link contains base path and a keyword
        for (const kw of kws) {
          const kwLower = kw.toLowerCase();
          const hrefLower = href.toLowerCase();
          
          // Pattern: /leaderboard/keyword or /leaderboards/keyword
          if (hrefLower.includes('/leaderboard/') && hrefLower.includes(kwLower)) {
            const pattern = '/leaderboard/{keyword}';
            if (!patterns.includes(pattern)) {
              patterns.push(pattern);
            }
            examples.push({ keyword: kw, url: fullHref || href });
          }
          else if (hrefLower.includes('/leaderboards/') && hrefLower.includes(kwLower)) {
            const pattern = '/leaderboards/{keyword}';
            if (!patterns.includes(pattern)) {
              patterns.push(pattern);
            }
            examples.push({ keyword: kw, url: fullHref || href });
          }
          // Pattern: /lb/keyword
          else if (hrefLower.includes('/lb/') && hrefLower.includes(kwLower)) {
            const pattern = '/lb/{keyword}';
            if (!patterns.includes(pattern)) {
              patterns.push(pattern);
            }
            examples.push({ keyword: kw, url: fullHref || href });
          }
          // Pattern with query param: ?site=keyword or ?provider=keyword
          else if ((hrefLower.includes('site=') || hrefLower.includes('provider=')) && hrefLower.includes(kwLower)) {
            const paramMatch = hrefLower.match(/[?&](site|provider)=/);
            if (paramMatch) {
              const pattern = `?${paramMatch[1]}={keyword}`;
              if (!patterns.includes(pattern)) {
                patterns.push(pattern);
              }
              examples.push({ keyword: kw, url: fullHref || href });
            }
          }
        }
      }
      
      return {
        patterns,
        examples: examples.slice(0, 5) // Limit examples
      };
    }, args);
    
    if (patternInfo.patterns.length > 0) {
      return {
        hasPattern: true,
        pattern: patternInfo.patterns[0], // Use first detected pattern
        allPatterns: patternInfo.patterns,
        examples: patternInfo.examples
      };
    }
    
    return { hasPattern: false, pattern: null, examples: [] };
  } catch (err) {
    log('NAV', `URL pattern detection error: ${err.message}`);
    return { hasPattern: false, pattern: null, examples: [] };
  }
}

/**
 * Infer URL pattern based on best path
 * If the best path is /leaderboard, assume /leaderboard/{keyword} pattern
 * 
 * @param {string} bestPathName - Name of the best path (e.g., 'leaderboard')
 * @param {string} baseUrl - Base URL of the site
 * @returns {Object|null} - URL pattern info or null
 */
function inferUrlPattern(bestPathName, baseUrl) {
  // Infer pattern based on which path worked best
  if (bestPathName === 'leaderboard') {
    return {
      hasPattern: true,
      pattern: '/leaderboard/{keyword}',
      baseUrl: baseUrl,
      inferred: true
    };
  } else if (bestPathName === 'leaderboards') {
    return {
      hasPattern: true,
      pattern: '/leaderboards/{keyword}',
      baseUrl: baseUrl,
      inferred: true
    };
  }
  return null;
}

/**
 * Construct URL from pattern and keyword
 * @param {string} baseUrl - Base URL (e.g., https://example.com)
 * @param {string} pattern - Pattern (e.g., /leaderboard/{keyword})
 * @param {string} keyword - Keyword to substitute
 * @returns {string} - Constructed URL
 */
function constructPatternUrl(baseUrl, pattern, keyword) {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  
  if (pattern.startsWith('?')) {
    // Query param pattern
    return `${normalizedBase}/leaderboard${pattern.replace('{keyword}', keyword.toLowerCase())}`;
  } else {
    // Path pattern
    return `${normalizedBase}${pattern.replace('{keyword}', keyword.toLowerCase())}`;
  }
}

// ============================================================================
// MULTI-PATH KEYWORD SCANNING
// ============================================================================

/**
 * Scan keywords on multiple paths (original URL + /leaderboard + /leaderboards)
 * Each path is loaded fully before moving to the next
 * Also detects URL patterns for direct navigation
 * 
 * @param {Page} page - Playwright page instance
 * @param {string} baseUrl - Base URL from websites.txt
 * @param {Array} keywords - Keywords to search for
 * @param {Function} findSiteSwitchers - Function to find site switchers
 * @param {Object} options - Additional options
 * @returns {Object} - { allSwitchers, pathResults, bestPath, screenshots, urlPattern }
 */
async function scanAllPathsForKeywords(page, baseUrl, keywords, findSiteSwitchers, options = {}) {
  const { waitAfterLoad = 4000, takeScreenshots = false } = options;
  
  log('NAV', 'Starting multi-path keyword scan...');
  
  // Normalize base URL
  const normalizedBase = baseUrl.replace(/\/+$/, ''); // Remove trailing slashes
  
  // Paths to scan
  const pathsToScan = [
    { path: '', name: 'original', url: normalizedBase },
    { path: '/leaderboard', name: 'leaderboard', url: `${normalizedBase}/leaderboard` },
    { path: '/leaderboards', name: 'leaderboards', url: `${normalizedBase}/leaderboards` }
  ];
  
  const pathResults = [];
  const allSwitchersMap = new Map(); // Use map for deduplication
  const screenshots = {};
  
  for (const pathInfo of pathsToScan) {
    log('NAV', `Scanning path: ${pathInfo.url}`);
    
    try {
      // Navigate to the path
      const response = await page.goto(pathInfo.url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      
      const status = response?.status() || 0;
      
      // Skip 404 pages
      if (status === 404) {
        log('NAV', `Path ${pathInfo.path || '/'} returned 404, skipping`);
        pathResults.push({
          path: pathInfo.path || '/',
          name: pathInfo.name,
          url: pathInfo.url,
          status: 404,
          switchersFound: 0,
          switchers: []
        });
        continue;
      }
      
      // Wait for page to fully load
      log('NAV', `Waiting ${waitAfterLoad}ms for page to render...`);
      await page.waitForTimeout(waitAfterLoad);
      
      // Try to wait for network idle (but don't fail if it times out)
      try {
        await page.waitForLoadState('networkidle', { timeout: 8000 });
      } catch (e) {
        log('NAV', 'Network idle timeout, continuing...');
      }
      
      // Check for and handle Cloudflare
      const challengeResult = await handleChallenge(page);
      if (challengeResult.type !== 'none') {
        log('NAV', `Challenge detected on ${pathInfo.name}: ${challengeResult.type}`);
        await page.waitForTimeout(3000);
      }
      
      // Take screenshot if requested
      if (takeScreenshots) {
        try {
          const screenshot = await page.screenshot({ type: 'png', fullPage: false });
          screenshots[pathInfo.name] = screenshot.toString('base64');
        } catch (e) {
          log('NAV', `Screenshot failed for ${pathInfo.name}: ${e.message}`);
        }
      }
      
      // Scan for keywords using findSiteSwitchers
      const switchers = await findSiteSwitchers(page, keywords);
      
      log('NAV', `Found ${switchers.length} switchers on ${pathInfo.name} path`);
      
      // Add switchers to map (deduplicated by keyword)
      for (const switcher of switchers) {
        const key = switcher.keyword.toLowerCase();
        
        // Keep the one with higher priority or valid coordinates
        if (!allSwitchersMap.has(key)) {
          allSwitchersMap.set(key, { ...switcher, foundOnPath: pathInfo.name });
        } else {
          const existing = allSwitchersMap.get(key);
          // Prefer switchers with coordinates over those without
          if (!existing.coordinates && switcher.coordinates) {
            allSwitchersMap.set(key, { ...switcher, foundOnPath: pathInfo.name });
          }
          // Prefer higher priority
          else if (switcher.priority > existing.priority) {
            allSwitchersMap.set(key, { ...switcher, foundOnPath: pathInfo.name });
          }
        }
      }
      
      pathResults.push({
        path: pathInfo.path || '/',
        name: pathInfo.name,
        url: pathInfo.url,
        status,
        switchersFound: switchers.length,
        switchers: switchers.map(s => s.keyword)
      });
      
    } catch (err) {
      log('NAV', `Error scanning ${pathInfo.name}: ${err.message}`);
      pathResults.push({
        path: pathInfo.path || '/',
        name: pathInfo.name,
        url: pathInfo.url,
        status: 0,
        error: err.message,
        switchersFound: 0,
        switchers: []
      });
    }
  }
  
  // Determine best path (most switchers with coordinates)
  const bestPath = pathResults.reduce((best, current) => {
    if (current.status === 404 || current.error) return best;
    if (!best) return current;
    if (current.switchersFound > best.switchersFound) return current;
    return best;
  }, null);
  
  const allSwitchers = Array.from(allSwitchersMap.values());
  
  log('NAV', `Multi-path scan complete: ${allSwitchers.length} unique switchers found`);
  log('NAV', `Best path: ${bestPath?.name || 'none'} with ${bestPath?.switchersFound || 0} switchers`);
  
  // Detect URL patterns for direct navigation
  let urlPattern = null;
  try {
    // Navigate to the best path to detect patterns
    if (bestPath && bestPath.url) {
      await page.goto(bestPath.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
      
      const allKeywords = allSwitchers.map(s => s.keyword);
      const patternResult = await detectUrlPattern(page, allKeywords, bestPath.path || '/leaderboard');
      
      if (patternResult.hasPattern) {
        urlPattern = {
          pattern: patternResult.pattern,
          examples: patternResult.examples,
          baseUrl: normalizedBase
        };
        log('NAV', `Detected URL pattern from links: ${patternResult.pattern}`);
        if (patternResult.examples.length > 0) {
          log('NAV', `Example URLs: ${patternResult.examples.slice(0, 3).map(e => e.url).join(', ')}`);
        }
      }
    }
  } catch (err) {
    log('NAV', `URL pattern detection failed: ${err.message}`);
  }
  
  // FALLBACK: If no pattern detected but we have a /leaderboard or /leaderboards path,
  // infer that the site uses /leaderboard/{keyword} pattern
  if (!urlPattern && bestPath && (bestPath.name === 'leaderboard' || bestPath.name === 'leaderboards')) {
    urlPattern = inferUrlPattern(bestPath.name, normalizedBase);
    if (urlPattern) {
      log('NAV', `Inferred URL pattern: ${urlPattern.pattern} (based on best path: ${bestPath.name})`);
    }
  }
  
  return {
    allSwitchers,
    pathResults,
    bestPath: bestPath?.url || baseUrl,
    bestPathName: bestPath?.name || 'original',
    screenshots,
    urlPattern
  };
}

// ============================================================================
// ADAPTIVE LEADERBOARD NAVIGATION
// ============================================================================

/**
 * Check if current page has leaderboard content
 * @param {Page} page - Playwright page
 * @returns {Promise<boolean>} - True if page appears to have leaderboard content
 */
async function checkForLeaderboardContent(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    const indicators = ['wagered', 'wager', 'prize pool', 'ranking', 'leaderboard'];
    const hasNumbers = /\$[\d,]+|\d+\s*(st|nd|rd|th)/i.test(text);
    return indicators.some(i => text.includes(i)) && hasNumbers;
  });
}

/**
 * Try to click a "Leaderboards" navigation element (for SPAs)
 * @param {Page} page - Playwright page
 * @returns {Promise<Object>} - { success: boolean, selector?: string }
 */
async function tryClickLeaderboardNav(page) {
  const clickableSelectors = [
    'button:has-text("Leaderboard")',
    'a:has-text("Leaderboard")',
    '[role="tab"]:has-text("Leaderboard")',
    '[role="button"]:has-text("Leaderboard")',
    '.nav-item:has-text("Leaderboard")',
    '[class*="tab"]:has-text("Leaderboard")'
  ];

  for (const selector of clickableSelectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        await element.click();
        await page.waitForTimeout(2000);

        // Check if content changed to leaderboard
        const hasLeaderboard = await checkForLeaderboardContent(page);
        if (hasLeaderboard) {
          return { success: true, selector };
        }
      }
    } catch (e) {
      // Try next selector
    }
  }
  return { success: false };
}

/**
 * Navigate to the main leaderboard section of a site
 *
 * Strategy order:
 * 1. Use site profile's known leaderboardPath if available
 * 2. Look for main nav link containing "leaderboard"
 * 3. Try clicking a "Leaderboards" element (for SPAs)
 * 4. Try standard paths (/leaderboards, /leaderboard, /lb)
 * 5. If all fail, stay on current page
 *
 * @param {Page} page - Playwright page
 * @param {string} baseUrl - Base domain URL
 * @param {Object|null} siteProfile - Site profile if available
 * @returns {Promise<Object>} - { success: boolean, method: string, finalUrl: string }
 */
async function navigateToLeaderboardSection(page, baseUrl, siteProfile = null) {
  const url = new URL(baseUrl);
  let currentUrl = page.url();

  log('NAV', `Finding leaderboard section for ${url.hostname}`);

  // Strategy 0: If page is blank or on different domain, navigate to baseUrl first
  // This ensures we have a page to search for navigation elements
  if (currentUrl === 'about:blank' || !currentUrl.includes(url.hostname)) {
    log('NAV', `Page not on target domain, navigating to ${baseUrl}`);
    const initNav = await navigateWithBypass(page, baseUrl, { maxRetries: 2 });
    if (!initNav.success) {
      log('NAV', `Failed to navigate to ${baseUrl}`);
      return { success: false, method: 'failed-initial-nav', finalUrl: currentUrl };
    }
    currentUrl = page.url();
    await page.waitForTimeout(1000); // Allow page to settle
  }

  // Strategy 0.5: Check if we're ALREADY on a leaderboard URL
  // If the current URL contains /leaderboard or /leaderboards (but NOT /prev-leaderboard),
  // we're already where we need to be - don't navigate elsewhere!
  const currentPath = new URL(currentUrl).pathname.toLowerCase();
  const isAlreadyOnLeaderboard = (
    (currentPath.includes('/leaderboard') || currentPath.includes('/leaderboards')) &&
    !currentPath.includes('prev-') &&
    !currentPath.includes('previous-') &&
    !currentPath.includes('past-') &&
    !currentPath.includes('history') &&
    !currentPath.includes('archive')
  );

  if (isAlreadyOnLeaderboard) {
    log('NAV', `Already on leaderboard URL: ${currentUrl}, no navigation needed`);
    return { success: true, method: 'already-on-leaderboard-url', finalUrl: currentUrl };
  }

  // Strategy 1: Use site profile's known path
  if (siteProfile?.navigation?.leaderboardPath) {
    const knownPath = siteProfile.navigation.leaderboardPath;
    log('NAV', `Site profile has leaderboardPath: ${knownPath}`);

    // Extract just the path part for comparison
    const pathOnly = knownPath.startsWith('http')
      ? new URL(knownPath).pathname
      : knownPath;

    // Only navigate if not already on that path
    if (!currentUrl.includes(pathOnly)) {
      const targetUrl = knownPath.startsWith('http') ? knownPath : url.origin + knownPath;
      const navResult = await navigateWithBypass(page, targetUrl, { maxRetries: 2 });
      if (navResult.success) {
        return { success: true, method: 'site-profile', finalUrl: page.url() };
      }
    } else {
      log('NAV', 'Already on leaderboard path');
      return { success: true, method: 'already-on-path', finalUrl: currentUrl };
    }
  }

  // Strategy 2: Find main navigation link for "Leaderboards"
  const navLink = await page.evaluate(() => {
    // Look in common nav containers
    const navSelectors = [
      'nav a', 'header a', '[role="navigation"] a',
      '.nav a', '.navbar a', '.menu a', '.sidebar a',
      'a[href*="leaderboard"]'
    ];

    // Patterns that indicate historical/previous leaderboards - we want CURRENT ones
    // Check both URL and link text for these patterns
    const historicalPatterns = [
      'prev-leaderboard', 'prev_leaderboard', 'previous-leaderboard', 'previous_leaderboard',
      'past-leaderboard', 'past_leaderboard', 'history', 'archive', 'old-leaderboard',
      'previous leaderboard', 'past leaderboard', 'old leaderboard', 'prev leaderboard'
    ];

    // Helper to check if URL or text indicates a historical leaderboard
    const isHistorical = (href, text) => {
      const hrefLower = href.toLowerCase();
      const textLower = text.toLowerCase();
      return historicalPatterns.some(pattern =>
        hrefLower.includes(pattern) || textLower.includes(pattern)
      );
    };

    // Collect all matching links, then prioritize current over historical
    const candidateLinks = [];

    for (const selector of navSelectors) {
      try {
        const links = document.querySelectorAll(selector);
        for (const link of links) {
          const text = (link.textContent || '').toLowerCase().trim();
          const href = link.href || '';

          // Match "Leaderboards", "Leaderboard", etc.
          if (text.includes('leaderboard') || href.toLowerCase().includes('leaderboard')) {
            candidateLinks.push({
              href: link.href,
              text: text,
              isHistorical: isHistorical(href, text)
            });
          }
        }
      } catch (e) {
        // Selector failed, continue
      }
    }

    // Prioritize: prefer current leaderboard links over historical ones
    // First try to find a current (non-historical) link
    const currentLink = candidateLinks.find(l => !l.isHistorical);
    if (currentLink) {
      return { href: currentLink.href, text: currentLink.text, found: true };
    }

    // Fallback to historical if that's all we have
    if (candidateLinks.length > 0) {
      return { href: candidateLinks[0].href, text: candidateLinks[0].text, found: true };
    }

    return { found: false };
  });

  if (navLink.found && navLink.href) {
    log('NAV', `Found nav link: "${navLink.text}" -> ${navLink.href}`);
    const navResult = await navigateWithBypass(page, navLink.href, { maxRetries: 2 });
    if (navResult.success) {
      return { success: true, method: 'nav-link-click', finalUrl: page.url() };
    }
  }

  // Strategy 3: Try clicking a "Leaderboards" element (for SPAs)
  const clickResult = await tryClickLeaderboardNav(page);
  if (clickResult.success) {
    return { success: true, method: 'nav-element-click', finalUrl: page.url() };
  }

  // Strategy 4: Try standard paths
  for (const path of ['/leaderboards', '/leaderboard', '/lb', '/rankings']) {
    const testUrl = url.origin + path;
    try {
      const response = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (response?.status() !== 404) {
        await page.waitForTimeout(2000);
        const hasLeaderboardContent = await checkForLeaderboardContent(page);
        if (hasLeaderboardContent) {
          return { success: true, method: 'standard-path', finalUrl: page.url() };
        }
      }
    } catch (e) {
      // Path doesn't exist, try next
    }
  }

  // No leaderboard section found - stay on current page
  log('NAV', 'No leaderboard section found, using current page');
  return { success: false, method: 'none', finalUrl: currentUrl };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  LEADERBOARD_PATHS,

  // Challenge bypass
  initChallengeBypass,
  handleChallenge,
  hasChallenge,
  checkAndBypassChallenge,

  // Navigation
  navigateWithBypass,
  findLeaderboardPage,
  isOnLeaderboardPage,
  recoverToLeaderboard,
  navigateToLeaderboardSection,

  // Multi-path scanning
  scanAllPathsForKeywords,

  // URL pattern utilities
  detectUrlPattern,
  constructPatternUrl,
  inferUrlPattern,

  // Content checking
  checkForLeaderboardContent
};
