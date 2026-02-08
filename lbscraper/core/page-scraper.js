/**
 * Page Scraper - Core Module
 *
 * RESPONSIBILITY: Collect raw data from a leaderboard page
 * - Get HTML content
 * - Intercept and capture API calls
 * - Take screenshots
 * - Convert HTML to markdown for analysis
 *
 * INPUT:  { page, url, networkData, config }
 * OUTPUT: { html, markdown, apiCalls[], screenshot, rawJsonResponses[], metadata }
 *
 * This module does NOT parse/extract entries - it only collects raw data.
 */

const TurndownService = require('turndown');
const { log } = require('../shared/utils');
const { setupNetworkCapture } = require('../shared/network-capture');
const { navigateWithBypass, checkAndBypassChallenge } = require('../shared/page-navigation');

// Initialize Turndown for HTML to Markdown conversion
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
});

// Add table rules for proper markdown table conversion
// This is critical for sites with HTML tables (like packdraw)
turndownService.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: function (content, node) {
    return ' ' + content.trim() + ' |';
  }
});

turndownService.addRule('tableRow', {
  filter: 'tr',
  replacement: function (content, node) {
    return '|' + content + '\n';
  }
});

// Remove style and script tags - they create garbage text
turndownService.addRule('removeStyles', {
  filter: ['style', 'script', 'noscript', 'link', 'meta'],
  replacement: function () {
    return '';
  }
});

// Remove SVG elements (they produce garbage)
turndownService.addRule('removeSvg', {
  filter: 'svg',
  replacement: function () {
    return '';
  }
});

// Remove hidden elements
turndownService.addRule('removeHidden', {
  filter: function (node) {
    const style = node.getAttribute && node.getAttribute('style');
    if (style && /display\s*:\s*none/i.test(style)) return true;
    if (node.getAttribute && node.getAttribute('hidden') !== null) return true;
    return false;
  },
  replacement: function () {
    return '';
  }
});

// ============================================================================
// TYPES (JSDoc for clarity)
// ============================================================================

/**
 * @typedef {Object} ScraperInput
 * @property {import('playwright').Page} page - Playwright page instance
 * @property {string} url - URL to scrape
 * @property {Object} networkData - Network capture object (from setupNetworkCapture)
 * @property {Object} config - Scraper configuration
 */

/**
 * @typedef {Object} ScraperOutput
 * @property {string} html - Raw HTML content
 * @property {string} markdown - Markdown conversion of content
 * @property {Array} apiCalls - Captured API calls
 * @property {Buffer|null} screenshot - Screenshot buffer
 * @property {Array} rawJsonResponses - Raw JSON API responses
 * @property {Object} metadata - Page metadata
 * @property {string[]} errors - Any errors encountered
 */

// ============================================================================
// MAIN SCRAPE FUNCTION
// ============================================================================

/**
 * Scrape raw data from a leaderboard page
 *
 * @param {ScraperInput} input - Scraper input
 * @returns {Promise<ScraperOutput>} - Scraped data
 */
async function scrapePageData(input) {
  const { page, url, networkData, config = {} } = input;
  const { takeScreenshot = true, scrollPage = true, waitForContent = 3000 } = config;

  const result = {
    html: '',
    markdown: '',
    apiCalls: [],
    screenshot: null,
    rawJsonResponses: [],
    metadata: {
      url,
      scrapedAt: new Date().toISOString(),
      viewport: null
    },
    errors: []
  };

  try {
    log('SCRAPER', `Scraping page data from ${url}`);

    // Get viewport size
    const viewport = page.viewportSize();
    result.metadata.viewport = viewport;

    // Wait for initial content to load
    await page.waitForTimeout(waitForContent);

    // Scroll page to trigger lazy loading if enabled
    if (scrollPage) {
      if (config.scrollUntilStable) {
        await scrollUntilStable(page, config.scrollUntilStableOptions || {});
      } else {
        await scrollToLoadContent(page);
      }
    }

    // Capture HTML content
    result.html = await page.content();
    log('SCRAPER', `Captured ${result.html.length} bytes of HTML`);

    // Convert to markdown for easier analysis
    result.markdown = await convertToMarkdown(page);
    log('SCRAPER', `Converted to ${result.markdown.length} bytes of markdown`);

    // Capture API calls from network data
    if (networkData) {
      result.apiCalls = networkData.capturedUrls || [];
      result.rawJsonResponses = networkData.rawJsonResponses || [];
      log('SCRAPER', `Captured ${result.rawJsonResponses.length} API responses`);
    }

    // Take screenshot if enabled
    if (takeScreenshot) {
      try {
        result.screenshot = await page.screenshot({
          fullPage: false,
          type: 'png'
        });
        log('SCRAPER', 'Screenshot captured');
      } catch (e) {
        log('SCRAPER', `Screenshot failed: ${e.message}`);
        result.errors.push(`Screenshot failed: ${e.message}`);
      }
    }

    // Extract page metadata
    result.metadata.title = await page.title();
    result.metadata.currentUrl = page.url();

  } catch (error) {
    log('ERR', `Page scrape error: ${error.message}`);
    result.errors.push(error.message);
  }

  return result;
}

// ============================================================================
// CONTENT SCROLLING
// ============================================================================

/**
 * Scroll page to trigger lazy-loaded content
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {Object} options - Scroll options
 */
async function scrollToLoadContent(page, options = {}) {
  const { maxScrolls = 15, scrollDelay = 400 } = options;  // Increased from 5 to 15 for 100+ entry leaderboards

  try {
    for (let i = 0; i < maxScrolls; i++) {
      await page.evaluate((scrollIndex) => {
        window.scrollBy(0, window.innerHeight * 0.8);
      }, i);

      await page.waitForTimeout(scrollDelay);

      // Check if we've reached the bottom
      const atBottom = await page.evaluate(() => {
        return (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100;
      });

      if (atBottom) {
        log('SCRAPER', `Reached bottom after ${i + 1} scrolls`);
        break;
      }
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

  } catch (e) {
    log('SCRAPER', `Scroll error: ${e.message}`);
  }
}

/**
 * Scroll until row count (or content metric) stabilizes — full dataset capture.
 * Stops when the same count is observed for stablePolls consecutive polls.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {Object} options - { maxScrolls?: number, scrollDelay?: number, stablePolls?: number, pollDelay?: number }
 * @returns {Promise<{stableCount: number, scrolls: number}>}
 */
async function scrollUntilStable(page, options = {}) {
  const { maxScrolls = 25, scrollDelay = 500, stablePolls = 3, pollDelay = 600 } = options;

  let lastCount = 0;
  let stableRuns = 0;
  let scrolls = 0;

  try {
    for (let s = 0; s < maxScrolls; s++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
      scrolls++;
      await page.waitForTimeout(scrollDelay);

      const count = await page.evaluate(() => {
        // Broad selectors to capture various leaderboard layouts
        const rowSelectors = [
          'tr[class*="row"]', 'tr[class*="entry"]', 'tr[class*="player"]', 'tr[class*="item"]',
          '[class*="leaderboard"] tbody tr', '[class*="ranking"] tbody tr', '[class*="leaders"] tbody tr',
          '[class*="leaderboard"] [class*="row"]', '[class*="leaderboard"] [class*="entry"]',
          '[class*="leaderboard"] [class*="player"]', '[class*="ranking"] [class*="entry"]',
          '[class*="leaderboard-entry"]', '[class*="leaderboard-row"]',
          'table[class*="leaderboard"] tr', 'table[class*="ranking"] tr',
          'li[class*="entry"]', 'li[class*="player"]', '[data-rank]', '[data-position]'
        ];
        const seen = new Set();
        for (const sel of rowSelectors) {
          try {
            document.querySelectorAll(sel).forEach(el => seen.add(el));
          } catch (e) {}
        }
        return seen.size;
      });

      if (count === lastCount && count > 0) {
        stableRuns++;
        if (stableRuns >= stablePolls) {
          log('SCRAPER', `Scroll-until-stable: count ${count} stable after ${scrolls} scrolls`);
          break;
        }
      } else {
        stableRuns = 0;
      }
      lastCount = count;

      const atBottom = await page.evaluate(() => {
        return (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100;
      });
      if (atBottom) break;
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  } catch (e) {
    log('SCRAPER', `scrollUntilStable error: ${e.message}`);
  }
  return { stableCount: lastCount, scrolls };
}

// ============================================================================
// HTML TO MARKDOWN CONVERSION
// ============================================================================

/**
 * Convert page content to markdown
 *
 * Extracts full body HTML with noise elements removed, then converts to markdown.
 * This produces rich, parseable markdown similar to Firecrawl output.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @returns {Promise<string>} - Markdown content (max 1MB)
 */
async function convertToMarkdown(page) {
  try {
    // Get full body HTML with noise elements removed
    const contentHtml = await page.evaluate(() => {
      // Clone body to avoid modifying the actual page
      const clone = document.body.cloneNode(true);

      // Remove noise elements that don't contain leaderboard data
      const noiseSelectors = [
        'script', 'style', 'noscript', 'iframe',
        'nav', 'footer', 'header',
        '[class*="cookie"]', '[class*="popup"]', '[class*="modal"]',
        '[class*="advertisement"]', '[class*="sidebar"]',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'
      ];

      for (const selector of noiseSelectors) {
        try {
          clone.querySelectorAll(selector).forEach(el => el.remove());
        } catch (e) {
          // Ignore invalid selector errors
        }
      }

      return clone.innerHTML;
    });

    // Convert to markdown
    let markdown = turndownService.turndown(contentHtml);

    // Clean up excessive whitespace
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    // 1MB limit to prevent memory issues (we extract data then discard)
    if (markdown.length > 1000000) {
      markdown = markdown.substring(0, 1000000);
      log('SCRAPER', 'Markdown truncated to 1MB limit');
    }

    return markdown;

  } catch (e) {
    log('SCRAPER', `Markdown conversion error: ${e.message}`);
    return '';
  }
}

// ============================================================================
// DIRECT API FETCHING
// ============================================================================

/**
 * Make a direct API request using browser context (preserves cookies/auth)
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {string} url - API URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise<{success: boolean, data: any, error?: string}>}
 */
async function fetchApiInBrowser(page, url, options = {}) {
  const { method = 'GET', headers = {}, timeout = 10000 } = options;

  try {
    log('SCRAPER', `Fetching API: ${url}`);

    const result = await page.evaluate(async ({ url, method, headers, timeout }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method,
          headers,
          credentials: 'include',
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          return {
            success: false,
            status: response.status,
            error: `HTTP ${response.status}`
          };
        }

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
          const data = await response.json();
          return { success: true, data, contentType };
        } else {
          const text = await response.text();
          return { success: true, data: text, contentType };
        }

      } catch (e) {
        clearTimeout(timeoutId);
        return { success: false, error: e.message };
      }
    }, { url, method, headers, timeout });

    return result;

  } catch (error) {
    log('ERR', `API fetch error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// NETWORK DATA HELPERS
// ============================================================================

/**
 * Find API responses for a specific site/keyword
 *
 * @param {Array} rawJsonResponses - Raw JSON responses
 * @param {string} siteName - Site name to search for
 * @param {number} afterTimestamp - Only responses after this timestamp
 * @returns {Array} - Matching responses
 */
function findApiResponsesForSite(rawJsonResponses, siteName, afterTimestamp = 0) {
  const siteNameLower = siteName.toLowerCase();

  return rawJsonResponses.filter(response => {
    // Filter by timestamp
    if (afterTimestamp > 0 && response.timestamp < afterTimestamp) {
      return false;
    }

    // Check URL for site name
    const urlLower = response.url.toLowerCase();
    if (urlLower.includes(siteNameLower)) {
      return true;
    }

    // Check response data for site name
    const dataStr = JSON.stringify(response.data).toLowerCase();
    if (dataStr.includes(siteNameLower)) {
      return true;
    }

    return false;
  });
}

/**
 * Get the most recent API response
 *
 * @param {Array} rawJsonResponses - Raw JSON responses
 * @returns {Object|null} - Most recent response
 */
function getMostRecentApiResponse(rawJsonResponses) {
  if (!rawJsonResponses || rawJsonResponses.length === 0) {
    return null;
  }

  return rawJsonResponses.reduce((latest, current) => {
    return current.timestamp > latest.timestamp ? current : latest;
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main scraping
  scrapePageData,

  // Content helpers
  scrollToLoadContent,
  scrollUntilStable,
  convertToMarkdown,

  // API fetching
  fetchApiInBrowser,

  // Network data helpers
  findApiResponsesForSite,
  getMostRecentApiResponse
};
