/**
 * Leaderboard Crawler - Core Module
 *
 * RESPONSIBILITY: Discover leaderboards on a website
 * - Find site switchers (buttons, tabs, dropdowns)
 * - Click switchers to navigate between leaderboards
 * - Discover all leaderboard URLs on a site
 * - Find historical/previous leaderboard paths
 *
 * INPUT:  { page, baseUrl, keywords, config }
 * OUTPUT: { leaderboardUrls[], switchers[], historicalPaths[], errors[] }
 *
 * This module does NOT extract data - it only discovers what exists.
 */

const { log } = require('../shared/utils');
const {
  findSiteSwitchers,
  groupSwitchersBySpatialProximity,
  findBestSwitcherForKeyword,
  validateCoordinates,
  generateContentFingerprint,
  waitForContentChange,
  detectAllSiteNames
} = require('../shared/site-detection');
const {
  navigateWithBypass,
  checkAndBypassChallenge,
  findLeaderboardPage
} = require('../shared/page-navigation');

// ============================================================================
// TYPES (JSDoc for clarity)
// ============================================================================

/**
 * @typedef {Object} CrawlerInput
 * @property {import('playwright').Page} page - Playwright page instance
 * @property {string} baseUrl - Base URL of the site
 * @property {string[]} keywords - Known site/provider keywords
 * @property {Object} config - Crawler configuration
 */

/**
 * @typedef {Object} CrawlerOutput
 * @property {Array<{name: string, url: string, method: string}>} leaderboardUrls - Discovered leaderboard URLs
 * @property {Array<{keyword: string, coordinates: Object, priority: number}>} switchers - Found switchers
 * @property {string[]} historicalPaths - Paths to historical/previous leaderboards
 * @property {string[]} errors - Any errors encountered
 */

/**
 * @typedef {Object} SwitcherClickResult
 * @property {boolean} success - Whether the click was successful
 * @property {number} clickTimestamp - When the click occurred
 * @property {boolean} contentChanged - Whether page content changed
 * @property {string} [error] - Error message if failed
 */

// ============================================================================
// MAIN DISCOVERY FUNCTION
// ============================================================================

/**
 * Discover all leaderboards on a website
 *
 * @param {CrawlerInput} input - Crawler input
 * @returns {Promise<CrawlerOutput>} - Discovery results
 */
async function discoverLeaderboards(input) {
  const { page, baseUrl, keywords = [], config = {} } = input;

  const result = {
    leaderboardUrls: [],
    switchers: [],
    historicalPaths: [],
    errors: []
  };

  try {
    log('CRAWLER', `Starting leaderboard discovery for ${baseUrl}`);

    // Step 1: Find all site switchers on the page
    const rawSwitchers = await findSiteSwitchers(page, keywords);
    log('CRAWLER', `Found ${rawSwitchers.length} raw switchers`);

    // Step 2: Group and validate switchers
    const validSwitchers = groupSwitchersBySpatialProximity(rawSwitchers);
    result.switchers = validSwitchers;
    log('CRAWLER', `${validSwitchers.length} valid switchers after grouping`);

    // Step 3: Detect site names from page content
    const detectedSites = await detectAllSiteNames(page, keywords);
    log('CRAWLER', `Detected ${detectedSites.length} site names on page`);

    // Step 4: Build leaderboard URLs from switchers and detected sites
    for (const switcher of validSwitchers) {
      result.leaderboardUrls.push({
        name: switcher.keyword,
        url: baseUrl, // Same URL, different switcher click
        method: 'switcher-click',
        switcherData: {
          coordinates: switcher.coordinates,
          priority: switcher.priority,
          inMainGroup: switcher.inMainGroup
        }
      });
    }

    // Step 5: Add any detected sites not covered by switchers
    // VALIDATION: Check for clickable elements OR URLs that reference the site
    for (const site of detectedSites) {
      const hasSwitcher = result.leaderboardUrls.some(
        lb => lb.name.toLowerCase() === site.toLowerCase()
      );

      if (!hasSwitcher) {
        // Check if there's evidence this site has a leaderboard:
        // 1. Clickable element with the site name
        // 2. Link that includes the site name in the URL
        // 3. Images/logos with site name in src
        const hasEvidence = await page.evaluate((siteName) => {
          // Check for clickable elements
          const clickables = document.querySelectorAll('button, a, [role="button"], [role="tab"], [onclick], [class*="tab"], [class*="switch"], [class*="selector"]');
          for (const el of clickables) {
            const text = (el.textContent || '').toLowerCase().trim();
            const href = (el.href || '').toLowerCase();
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            const dataValue = (el.getAttribute('data-value') || el.getAttribute('data-site') || '').toLowerCase();

            const sitePattern = new RegExp(`\\b${siteName}\\b`, 'i');
            if (sitePattern.test(text) || sitePattern.test(ariaLabel) || sitePattern.test(dataValue)) {
              return { found: true, reason: 'clickable-element' };
            }
            if (href && (href.includes(`/${siteName}`) || href.includes(`=${siteName}`) || href.includes(`-${siteName}`))) {
              return { found: true, reason: 'url-link' };
            }
          }

          // Check for images/logos with site name (common pattern for site switchers)
          // NOTE: Only check src and alt, NOT className - className often contains
          // generic styling classes like "clash-image" that don't indicate the actual site
          const images = document.querySelectorAll('img, svg');
          for (const img of images) {
            const src = (img.src || img.getAttribute('xlink:href') || '').toLowerCase();
            const alt = (img.alt || '').toLowerCase();
            // Only match if siteName appears in src or alt (not className)
            // src check: look for siteName as a path segment or filename
            // e.g., /assets/shuffle.png should match "shuffle" but not "shuff"
            const srcHasSite = src.includes('/' + siteName + '.') ||
                               src.includes('/' + siteName + '/') ||
                               src.includes('/' + siteName + '-') ||
                               src.includes('-' + siteName + '.') ||
                               src.endsWith('/' + siteName);
            const altHasSite = alt.includes(siteName);
            if (srcHasSite || altHasSite) {
              return { found: true, reason: 'image-reference' };
            }
          }

          // Check for any link to a leaderboard page with this site name
          const links = document.querySelectorAll('a[href]');
          for (const link of links) {
            const href = link.href.toLowerCase();
            if (href.includes('/leaderboard') && href.includes(siteName)) {
              return { found: true, reason: 'leaderboard-link' };
            }
          }

          // Check for headings that contain both site name and "leaderboard"
          // This catches single-site pages like "$5 000 STAKE LEADERBOARD"
          const headings = document.querySelectorAll('h1, h2, h3, [class*="title"], [class*="header"]');
          for (const heading of headings) {
            const text = (heading.textContent || '').toLowerCase();
            if (text.includes('leaderboard') && text.includes(siteName)) {
              return { found: true, reason: 'heading-title' };
            }
          }

          return { found: false, reason: 'no-evidence' };
        }, site.toLowerCase());

        if (hasEvidence.found) {
          result.leaderboardUrls.push({
            name: site,
            url: baseUrl,
            method: 'detected-name',
            switcherData: null
          });
          log('CRAWLER', `Added "${site}" via ${hasEvidence.reason}`);
        } else {
          log('CRAWLER', `Skipping "${site}" - no evidence of actual leaderboard (likely false positive)`);
        }
      }
    }

    log('CRAWLER', `Discovery complete: ${result.leaderboardUrls.length} leaderboards found`);

  } catch (error) {
    log('ERR', `Crawler error: ${error.message}`);
    result.errors.push(error.message);
  }

  return result;
}

// ============================================================================
// SWITCHER CLICKING
// ============================================================================

/**
 * Click a site switcher and verify content changed
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} keyword - Keyword to click
 * @param {Object} switcherData - Switcher data with coordinates
 * @param {Object} options - Click options
 * @returns {Promise<SwitcherClickResult>} - Click result
 */
async function clickSwitcher(page, keyword, switcherData = null, options = {}) {
  const { timeout = 12000, minUsernameChanges = 2 } = options;

  log('CRAWLER', `Clicking switcher for "${keyword}"...`);

  try {
    // Get pre-click fingerprint
    const preFingerprint = await generateContentFingerprint(page);
    const clickTimestamp = Date.now();

    // Validate coordinates if provided
    if (switcherData?.coordinates) {
      const validation = validateCoordinates(switcherData.coordinates);
      if (!validation.valid) {
        log('CRAWLER', `Invalid coordinates for ${keyword}: ${validation.reason}`);
        switcherData = null;
      }
    }

    let clicked = false;

    // Strategy 1: Try to find and click element with image/logo containing the keyword
    // This handles sites like wrewards.com where tabs have logo images
    try {
      const imageClickResult = await page.evaluate((kw) => {
        const kwLower = kw.toLowerCase();
        // Find images with the keyword in src, alt, or parent element
        const images = document.querySelectorAll('img');
        for (const img of images) {
          const src = (img.src || '').toLowerCase();
          const alt = (img.alt || '').toLowerCase();
          if (src.includes(kwLower) || alt.includes(kwLower)) {
            // Find clickable parent (button, a, or element with onclick)
            const clickable = img.closest('button, a, [role="button"], [role="tab"], [onclick], [class*="tab"], [class*="switch"]');
            if (clickable) {
              // Scroll into view first
              clickable.scrollIntoView({ block: 'center', behavior: 'instant' });
              clickable.click();
              return { success: true, method: 'image-parent-click' };
            }
            // Click the image directly
            img.click();
            return { success: true, method: 'image-direct-click' };
          }
        }
        return { success: false };
      }, keyword);

      if (imageClickResult.success) {
        clicked = true;
        log('CRAWLER', `Clicked ${keyword} via ${imageClickResult.method}`);
        await page.waitForTimeout(500); // Brief wait after JS click
      }
    } catch (e) {
      log('CRAWLER', `Image-based click failed: ${e.message}`);
    }

    // Strategy 2: Use coordinates if available and not yet clicked
    if (!clicked && switcherData?.coordinates) {
      try {
        // Scroll the element into view first
        await page.evaluate((coords) => {
          window.scrollTo({
            top: Math.max(0, coords.y - 200),
            behavior: 'instant'
          });
        }, switcherData.coordinates);
        await page.waitForTimeout(300);

        await page.mouse.click(
          switcherData.coordinates.x,
          switcherData.coordinates.y
        );
        clicked = true;
        log('CRAWLER', `Clicked ${keyword} at (${Math.round(switcherData.coordinates.x)}, ${Math.round(switcherData.coordinates.y)})`);
      } catch (e) {
        log('CRAWLER', `Coordinate click failed: ${e.message}`);
      }
    }

    // Strategy 3: Fall back to text-based selectors
    if (!clicked) {
      const selectors = [
        `button:has-text("${keyword}")`,
        `[role="tab"]:has-text("${keyword}")`,
        `a:has-text("${keyword}")`,
        `.tab:has-text("${keyword}")`,
        `[data-site="${keyword}"]`,
        `[data-provider="${keyword}"]`
      ];

      for (const selector of selectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            await element.scrollIntoViewIfNeeded();
            await element.click();
            clicked = true;
            log('CRAWLER', `Clicked ${keyword} via selector: ${selector}`);
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }
    }

    if (!clicked) {
      return {
        success: false,
        clickTimestamp,
        contentChanged: false,
        error: `No clickable element found for "${keyword}"`
      };
    }

    // Wait for content change
    const changeResult = await waitForContentChange(
      page,
      preFingerprint,
      timeout,
      { minUsernameChanges }
    );

    return {
      success: changeResult.changed,
      clickTimestamp,
      contentChanged: changeResult.changed,
      newFingerprint: changeResult.newFingerprint,
      usernameChanges: changeResult.usernameChanges
    };

  } catch (error) {
    log('ERR', `Click error for ${keyword}: ${error.message}`);
    return {
      success: false,
      clickTimestamp: Date.now(),
      contentChanged: false,
      error: error.message
    };
  }
}

// ============================================================================
// URL-BASED DISCOVERY
// ============================================================================

/**
 * Discover leaderboard via URL pattern navigation
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} baseUrl - Base URL
 * @param {string} siteName - Site name to try
 * @returns {Promise<{success: boolean, url: string}>}
 */
async function discoverViaUrlPattern(page, baseUrl, siteName) {
  const patterns = [
    `/${siteName.toLowerCase()}/`,
    `/leaderboard/${siteName.toLowerCase()}`,
    `?site=${siteName.toLowerCase()}`,
    `?provider=${siteName.toLowerCase()}`
  ];

  for (const pattern of patterns) {
    const testUrl = new URL(baseUrl);

    if (pattern.startsWith('?')) {
      testUrl.search = pattern;
    } else {
      testUrl.pathname = pattern;
    }

    try {
      const result = await navigateWithBypass(page, testUrl.toString(), {
        timeout: 10000,
        maxRetries: 1
      });

      if (result.success && !result.isError) {
        log('CRAWLER', `Found leaderboard at ${testUrl.toString()}`);
        return { success: true, url: testUrl.toString() };
      }
    } catch (e) {
      // Pattern didn't work, try next
    }
  }

  return { success: false, url: null };
}

// ============================================================================
// HISTORICAL DISCOVERY
// ============================================================================

/**
 * Discover paths to historical/previous leaderboards
 *
 * @param {import('playwright').Page} page - Playwright page
 * @returns {Promise<string[]>} - Historical paths found
 */
async function discoverHistoricalPaths(page) {
  const paths = [];

  try {
    const historicalElements = await page.evaluate(() => {
      const patterns = [
        /history|historical/i,
        /previous|past/i,
        /archive|archived/i,
        /old|older/i,
        /\d{4}[-\/]\d{2}/ // Date patterns like 2024-01 or 2024/01
      ];

      const found = [];
      const links = document.querySelectorAll('a[href], button, [role="tab"]');

      for (const el of links) {
        const text = el.textContent?.trim() || '';
        const href = el.getAttribute('href') || '';

        for (const pattern of patterns) {
          if (pattern.test(text) || pattern.test(href)) {
            found.push({
              text,
              href,
              tag: el.tagName
            });
            break;
          }
        }
      }

      return found;
    });

    for (const el of historicalElements) {
      if (el.href && !el.href.startsWith('javascript:')) {
        paths.push(el.href);
      }
    }

    log('CRAWLER', `Found ${paths.length} historical paths`);

  } catch (error) {
    log('ERR', `Historical discovery error: ${error.message}`);
  }

  return paths;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main discovery
  discoverLeaderboards,

  // Switcher operations
  clickSwitcher,

  // URL-based discovery
  discoverViaUrlPattern,

  // Historical discovery
  discoverHistoricalPaths
};
