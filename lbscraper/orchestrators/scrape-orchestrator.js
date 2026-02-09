/**
 * Scrape Orchestrator
 *
 * RESPONSIBILITY: Coordinate the 3 pillars for a single site
 * 1. Leaderboard Crawler - Discover leaderboards
 * 2. Page Scraper - Collect raw data
 * 3. Data Extractor - Parse entries
 *
 * Also handles:
 * - Retry logic (3x exponential backoff)
 * - Circuit breaker (prevent hammering failed sites)
 * - Teacher Mode integration
 * - Database saving
 *
 * INPUT:  { page, baseUrl, config, networkData }
 * OUTPUT: { results[], errors[], metadata }
 */

const crypto = require('crypto');
const path = require('path');
const { log } = require('../shared/utils');
const { discoverLeaderboards, clickSwitcher } = require('../core/leaderboard-crawler');
const { scrapePageData } = require('../core/page-scraper');
const { extractLeaderboardData } = require('../core/data-extractor');
const { validateAndCleanEntries, clearGlobalEntriesTracker } = require('../shared/entry-validation');
const { navigateWithBypass, navigateToLeaderboardSection } = require('../shared/page-navigation');
const { clearNetworkData } = require('../shared/network-capture');
const {
  selectMaximumEntries,
  selectMaxRows,
  waitForLeaderboardReady,
  withUiRetry
} = require('../shared/ui-interaction');
const { validateDataset } = require('../shared/dataset-validation');
const { normalizeEntries } = require('../shared/normalizer');
const {
  shouldInvokeTeacherMode,
  evaluateWithTeacher,
  getSiteProfile
} = require('../shared/teacher');
const {
  getLearnedPatterns,
  recordSuccessfulExtraction
} = require('../shared/learned-patterns');

// ============================================================================
// TYPES (JSDoc for clarity)
// ============================================================================

/**
 * @typedef {Object} OrchestratorInput
 * @property {import('playwright').Page} page - Playwright page
 * @property {string} baseUrl - Base URL to scrape
 * @property {Object} networkData - Network capture data
 * @property {Object} config - Configuration
 * @property {Array<string>} keywords - Known site keywords
 */

/**
 * @typedef {Object} OrchestratorOutput
 * @property {Array} results - Scraped leaderboard results
 * @property {string[]} errors - Errors encountered
 * @property {Object} metadata - Orchestration metadata
 */

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

const circuitBreaker = {
  failures: new Map(), // domain -> { count, lastFailure }
  threshold: 3,        // failures before tripping
  resetTime: 300000,   // 5 minutes

  isOpen(domain) {
    const record = this.failures.get(domain);
    if (!record) return false;

    // Reset if enough time has passed
    if (Date.now() - record.lastFailure > this.resetTime) {
      this.failures.delete(domain);
      return false;
    }

    return record.count >= this.threshold;
  },

  recordFailure(domain) {
    const record = this.failures.get(domain) || { count: 0, lastFailure: 0 };
    record.count++;
    record.lastFailure = Date.now();
    this.failures.set(domain, record);
    log('CIRCUIT', `Failure recorded for ${domain}: ${record.count}/${this.threshold}`);
  },

  recordSuccess(domain) {
    this.failures.delete(domain);
  }
};

// ============================================================================
// RETRY LOGIC
// ============================================================================

/**
 * Execute with exponential backoff retry
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Retry options
 * @returns {Promise<any>} - Function result
 */
async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 10000 } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        log('RETRY', `All ${maxRetries} attempts failed: ${error.message}`);
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000,
        maxDelayMs
      );

      log('RETRY', `Attempt ${attempt}/${maxRetries} failed, retrying in ${Math.round(delay)}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError;
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Orchestrate scraping for a single site
 *
 * @param {OrchestratorInput} input - Orchestrator input
 * @returns {Promise<OrchestratorOutput>} - Orchestration result
 */
async function orchestrateScrape(input) {
  const { page, baseUrl, networkData, config = {}, keywords = [] } = input;

  const url = new URL(baseUrl);
  const domain = url.hostname;

  const extractionId = crypto.randomUUID();

  const result = {
    id: extractionId,  // Unique ID for this extraction run
    results: [],
    errors: [],
    metadata: {
      domain,
      startedAt: new Date().toISOString(),
      completedAt: null,
      leaderboardsDiscovered: 0,
      leaderboardsScraped: 0,
      strategiesUsed: []
    }
  };

  // Check circuit breaker
  if (circuitBreaker.isOpen(domain)) {
    log('CIRCUIT', `Circuit breaker OPEN for ${domain}, skipping`);
    result.errors.push(`Circuit breaker open for ${domain}`);
    return result;
  }

  try {
    log('ORCHESTRATE', `Starting scrape for ${domain}`);

    // Clear global entries tracker for clean slate
    clearGlobalEntriesTracker();

    // BetJuicy: Intercept API requests and force limit=50 (matches site dropdown max)
    const BETJUICY_API_LIMIT = 50;
    const isBetJuicy = /betjuicy\.com$/i.test(domain);
    let unrouteBetJuicy = () => {}; // no-op; set when route is active
    if (isBetJuicy) {
      unrouteBetJuicy = await page.route(/api\.betjuicy\.com/, async (route) => {
        const request = route.request();
        let url = request.url();
        const limitParams = ['limit', 'take', 'pageSize', 'size', 'per_page'];
        let modified = false;
        for (const param of limitParams) {
          const regex = new RegExp(`([?&])${param}=\\d+`, 'i');
          if (regex.test(url)) {
            url = url.replace(regex, `$1${param}=${BETJUICY_API_LIMIT}`);
            modified = true;
            break;
          }
        }
        if (!modified && (url.includes('?') || url.includes('&'))) {
          url += (url.includes('?') ? '&' : '?') + `limit=${BETJUICY_API_LIMIT}`;
          modified = true;
        } else if (!modified) {
          url += (url.includes('?') ? '&' : '?') + `limit=${BETJUICY_API_LIMIT}`;
          modified = true;
        }
        if (modified) {
          log('ORCHESTRATE', `BetJuicy: Rewriting API limit to ${BETJUICY_API_LIMIT}`);
          await route.continue({ url });
        } else {
          await route.continue();
        }
      });
    }

    // =========================================================================
    // STEP 0: NAVIGATE TO LEADERBOARD SECTION
    // =========================================================================
    log('ORCHESTRATE', 'Step 0: Finding leaderboard section...');

    // Get site profile if available
    // NOTE: basePath is the lbscraper root, NOT the data directory
    // getSiteProfile expects basePath and appends 'data/site-profiles' internally
    const basePath = config.paths?.basePath || path.join(__dirname, '..');
    let siteProfile = null;
    try {
      siteProfile = await getSiteProfile(basePath, domain);
    } catch (e) {
      // No profile yet, will create one
    }

    // Navigate to leaderboard section
    const navResult = await navigateToLeaderboardSection(page, baseUrl, siteProfile);
    log('ORCHESTRATE', `Leaderboard navigation: ${navResult.method} -> ${navResult.finalUrl}`);

    // If we found a new leaderboard path, save it to the profile
    // NOTE: updateSiteProfileNavigation expects the DATA directory (not lbscraper root)
    const dataDir = path.join(basePath, 'data');
    if (navResult.success && navResult.method !== 'site-profile' && navResult.method !== 'already-on-path') {
      try {
        const { updateSiteProfileNavigation } = require('../shared/teacher/site-profiles');
        await updateSiteProfileNavigation(dataDir, domain, navResult.finalUrl);
      } catch (e) {
        log('ORCHESTRATE', `Could not save navigation path: ${e.message}`);
      }
    }

    // =========================================================================
    // STEP 1: CHECK FOR URL-SPECIFIC LEADERBOARD OR DISCOVER
    // =========================================================================
    // If the URL contains a specific keyword (e.g., /leaderboard/csgogem),
    // only scrape that leaderboard instead of discovering all
    const urlPath = url.pathname.toLowerCase();
    let urlSpecificKeyword = null;

    // Check if the URL path ends with a keyword
    // Pattern: /leaderboard/{keyword} or /leaderboards/{keyword}
    const pathParts = urlPath.split('/').filter(p => p);
    if (pathParts.length >= 2) {
      const lastSegment = pathParts[pathParts.length - 1];
      const secondLast = pathParts[pathParts.length - 2];

      // Check if URL pattern matches /leaderboard(s)/{keyword}
      if ((secondLast === 'leaderboard' || secondLast === 'leaderboards') && lastSegment) {
        // Verify the last segment is a known keyword (case-insensitive)
        const matchedKeyword = keywords.find(k => k.toLowerCase() === lastSegment);
        if (matchedKeyword) {
          urlSpecificKeyword = matchedKeyword;
          log('ORCHESTRATE', `URL contains specific keyword: ${urlSpecificKeyword}`);
        }
      }
    }

    let discovery;
    if (urlSpecificKeyword) {
      // URL-specific leaderboard - skip discovery and only scrape this one
      log('ORCHESTRATE', `Step 1: Skipping discovery - URL specifies "${urlSpecificKeyword}" leaderboard`);
      discovery = {
        leaderboardUrls: [{
          name: urlSpecificKeyword,
          url: baseUrl,
          method: 'url-specified'
        }],
        switchers: [],
        historicalPaths: [],
        errors: []
      };
    } else {
      // Generic URL - run full discovery
      log('ORCHESTRATE', 'Step 1: Discovering leaderboards...');

      discovery = await withRetry(async () => {
        return await discoverLeaderboards({
          page,
          baseUrl,
          keywords,
          config: {
            waitAfterLoad: config.waitAfterLoad || 4000,
            takeScreenshots: config.takeScreenshots || false
          }
        });
      }, { maxRetries: 2 });
    }

    result.metadata.leaderboardsDiscovered = discovery.leaderboardUrls.length;
    log('ORCHESTRATE', `Discovered ${discovery.leaderboardUrls.length} leaderboards, ${discovery.switchers.length} switchers`);

    // Merge known leaderboards from site profile that weren't discovered
    // This handles cases where dropdown detection fails or leaderboards are hidden
    if (siteProfile?.extractionConfig?.leaderboards) {
      const discoveredNames = new Set(discovery.leaderboardUrls.map(lb => lb.name.toLowerCase()));
      const knownLeaderboards = Object.entries(siteProfile.extractionConfig.leaderboards);

      for (const [name, config] of knownLeaderboards) {
        if (!discoveredNames.has(name.toLowerCase()) && config.navigation?.url) {
          log('ORCHESTRATE', `Adding known leaderboard from profile: ${name}`);
          discovery.leaderboardUrls.push({
            name,
            url: config.navigation.url,
            method: 'profile-known',
            switcherData: null
          });
        }
      }

      if (discovery.leaderboardUrls.length > result.metadata.leaderboardsDiscovered) {
        log('ORCHESTRATE', `Added ${discovery.leaderboardUrls.length - result.metadata.leaderboardsDiscovered} leaderboards from profile`);
      }
    }

    if (discovery.leaderboardUrls.length === 0 && discovery.switchers.length === 0) {
      log('ORCHESTRATE', 'No leaderboards found');
      result.errors.push('No leaderboards discovered');
      return result;
    }

    // =========================================================================
    // STEP 2: SCRAPE EACH LEADERBOARD
    // =========================================================================
    log('ORCHESTRATE', 'Step 2: Scraping leaderboards...');

    // Use leaderboardUrls directly - crawler already packages them correctly
    // Methods: 'switcher-click' (has switcherData), 'detected-name' (no switcherData), 'profile-known', etc.
    const toScrape = discovery.leaderboardUrls;

    log('ORCHESTRATE', `Scraping ${toScrape.length} leaderboards...`);

    // Track which leaderboard we're currently on to avoid unnecessary navigation
    let currentLeaderboard = null;
    let isFirstLeaderboard = true; // Track if this is the first leaderboard (likely default view)

    for (const leaderboard of toScrape) {
      try {
        // Determine how to get to this leaderboard
        const method = leaderboard.method || 'url-navigation';
        const hasSwitcherData = leaderboard.switcherData &&
          leaderboard.switcherData.coordinates &&
          leaderboard.switcherData.coordinates.x != null;

        // Check if we're already on the target URL (url-specified mode)
        // In this case, don't clear network data - we captured API responses during initial navigation
        const alreadyOnTarget = method === 'url-specified' && leaderboard.url === page.url();

        // IMPORTANT: For the FIRST leaderboard with switcher-click method, preserve network data
        // This handles sites like wrewards.com where the default leaderboard (HUNT/WREWARDS)
        // has its API responses captured during initial page load.
        // Clearing network data would lose the prize API response that was already fetched.
        const isDefaultView = isFirstLeaderboard && method === 'switcher-click';

        if (alreadyOnTarget || isDefaultView) {
          log('ORCHESTRATE', `${isDefaultView ? 'Default view' : 'Already on target page'} for ${leaderboard.name}, preserving network data from initial navigation`);
        } else {
          // Clear network data BEFORE any navigation/click to capture fresh API responses
          clearNetworkData(networkData);
          log('ORCHESTRATE', `Cleared network data before navigating to ${leaderboard.name}`);
        }

        isFirstLeaderboard = false; // After first leaderboard, always clear

        if (method === 'switcher-click' && hasSwitcherData) {
          // Click the switcher to change leaderboard
          log('ORCHESTRATE', `Clicking switcher for ${leaderboard.name}`);
          const clickResult = await clickSwitcher(page, leaderboard.name, leaderboard.switcherData);
          if (!clickResult.success) {
            // Check if we're already on this leaderboard:
            // 1. URL contains the keyword
            // 2. This is the first/default leaderboard (isDefaultView was true before we set isFirstLeaderboard = false)
            // 3. The click element was found (clickResult.error is undefined or doesn't indicate "no element found")
            const currentUrl = page.url().toLowerCase();
            const keywordLower = leaderboard.name.toLowerCase();
            const urlContainsKeyword = currentUrl.includes(`/${keywordLower}`) || currentUrl.includes(`=${keywordLower}`);
            const wasDefaultView = isDefaultView; // This was set before isFirstLeaderboard was changed
            const clickFoundElement = !clickResult.error || !clickResult.error.includes('No clickable element');

            if (urlContainsKeyword) {
              log('ORCHESTRATE', `Already on ${leaderboard.name} page (URL: ${page.url()}), proceeding with extraction`);
            } else if (wasDefaultView && clickFoundElement) {
              // This is the default/first leaderboard and we clicked but content didn't change
              // This means the leaderboard is already displayed - proceed with extraction
              log('ORCHESTRATE', `Default view for ${leaderboard.name} - content already displayed, proceeding with extraction`);
            } else {
              result.errors.push(`Click failed for ${leaderboard.name}: ${clickResult.error}`);
              continue;
            }
          }
          currentLeaderboard = leaderboard.name;
        } else if (method === 'detected-name' && !hasSwitcherData) {
          // Detected name without coordinates - this usually means the leaderboard name
          // was detected in page content (e.g., heading like "STAKE LEADERBOARD")
          // The data might already be visible on the current page
          log('ORCHESTRATE', `Trying text-based click for ${leaderboard.name}`);
          const clickResult = await clickSwitcher(page, leaderboard.name, null);
          if (!clickResult.success) {
            // If click fails, try URL navigation with the keyword
            // Detect URL pattern from current URL (e.g., /leaderboard/diceblox -> /leaderboard/{site})
            const currentUrl = new URL(page.url());
            const pathParts = currentUrl.pathname.split('/').filter(p => p);

            // Try to find the pattern - replace last segment with the keyword
            let possibleUrl;
            if (pathParts.length >= 2) {
              // Replace last segment with the new keyword
              pathParts[pathParts.length - 1] = leaderboard.name.toLowerCase();
              possibleUrl = `${currentUrl.origin}/${pathParts.join('/')}`;
            } else {
              // Fallback: append to leaderboard path
              possibleUrl = `${currentUrl.origin}/leaderboard/${leaderboard.name.toLowerCase()}`;
            }

            log('ORCHESTRATE', `Click failed, trying URL pattern: ${possibleUrl}`);
            let urlNavigationSuccess = false;

            // Save the current URL before attempting URL navigation
            // This is the page where the leaderboard data is likely visible (e.g., /leaderboard)
            const urlBeforeNavAttempt = page.url();

            try {
              await navigateWithBypass(page, possibleUrl, {
                maxRetries: 1,
                waitAfterLoad: config.waitAfterLoad || 3000
              });
              // Check if we got a 404 page by looking for common 404 indicators
              const is404 = await page.evaluate(() => {
                const title = document.title.toLowerCase();
                const bodyText = document.body.innerText.toLowerCase();
                return title.includes('404') || title.includes('error') || title.includes('not found') ||
                       bodyText.includes('404') || bodyText.includes('page not found');
              });
              if (!is404) {
                urlNavigationSuccess = true;
              }
            } catch (navError) {
              // Navigation failed
            }

            // If both click and URL navigation failed (404), the leaderboard might already
            // be visible on the current page (single-leaderboard sites). Go back to the
            // original page and try to extract from there.
            if (!urlNavigationSuccess) {
              log('ORCHESTRATE', `URL navigation failed/404 for ${leaderboard.name}, checking if data is on original page`);
              // Go back to the previous URL where the leaderboard was detected
              await navigateWithBypass(page, urlBeforeNavAttempt, {
                maxRetries: 1,
                waitAfterLoad: config.waitAfterLoad || 3000
              });
              // Continue with extraction from the original page - the leaderboard data
              // might already be visible (single-leaderboard sites like scrapesgambles.com)
              log('ORCHESTRATE', `Will extract "${leaderboard.name}" from current page (detected-name, no navigation needed)`);
            }
          }
          currentLeaderboard = leaderboard.name;
        } else {
          // URL-based navigation (different URL for each leaderboard)
          if (leaderboard.url !== page.url()) {
            log('ORCHESTRATE', `Navigating to ${leaderboard.name}: ${leaderboard.url}`);
            await navigateWithBypass(page, leaderboard.url, {
              maxRetries: 2,
              waitAfterLoad: config.waitAfterLoad || 3000
            });
          }
          currentLeaderboard = leaderboard.name;
        }

        // Wait for content to load - need longer wait for SPA frameworks
        await page.waitForTimeout(config.waitAfterClick || 3000);
        // BetJuicy: extra wait after tab switch so "Show X users" dropdown is ready before we select 50
        if (isBetJuicy) await page.waitForTimeout(1500);

        // REQUIRED: Select maximum entries BEFORE waiting for readiness
        // Otherwise we only capture partial data (e.g. 10 of 500 users).
        // Tries: native select → custom dropdown → Show All button.
        await withUiRetry(async () => selectMaximumEntries(page, { maxRetries: 3 }), { maxRetries: 3 });
        await page.waitForTimeout(1200);

        // Leaderboard readiness: stable DOM, optional network idle
        await waitForLeaderboardReady(page, {
          networkIdleMs: 1500,
          rowStablePolls: 3,
          rowStableDelayMs: 500
        });

        // Try to wait for any loading spinners to disappear
        try {
          await page.waitForSelector('[class*="loading"], [class*="spinner"], [class*="skeleton"]', { state: 'hidden', timeout: 5000 }).catch(() => {});
        } catch (e) {
          // No loading indicator found, continue
        }

        // Click "Show More" / "Load More" buttons repeatedly until all entries are loaded
        // Many sites paginate with a "load more" button that needs to be clicked multiple times
        try {
          let loadMoreClicks = 0;
          const maxLoadMoreClicks = 25; // Allow more clicks for large leaderboards (500+ entries)

          while (loadMoreClicks < maxLoadMoreClicks) {
            const showMoreBtn = await page.$('button:has-text("Show More"), button:has-text("Load More"), button:has-text("View All"), button:has-text("Show all"), [class*="load-more"], [class*="show-more"]');
            if (!showMoreBtn) break;

            // Check if button is visible and clickable
            const isVisible = await showMoreBtn.isVisible();
            if (!isVisible) break;

            await showMoreBtn.click();
            loadMoreClicks++;
            log('ORCHESTRATE', `Clicked "Show More" for ${leaderboard.name} (${loadMoreClicks}x)`);
            await page.waitForTimeout(1000);

            // Check if the button is still present (might disappear after loading all)
            const stillPresent = await page.$('button:has-text("Show More"), button:has-text("Load More"), button:has-text("View All"), button:has-text("Show all")');
            if (!stillPresent) break;
          }

          if (loadMoreClicks > 0) {
            log('ORCHESTRATE', `Loaded additional content with ${loadMoreClicks} "Show More" clicks`);
          }
        } catch (e) {
          // No show more button, continue
        }

        // Wait for content to fully render after navigation/click
        await page.waitForTimeout(2000);

        // Scrape raw data (scroll-until-stable for full dataset capture)
        log('ORCHESTRATE', `Collecting raw data for ${leaderboard.name}`);
        const rawData = await scrapePageData({
          page,
          url: page.url(),
          networkData,
          config: {
            takeScreenshot: config.takeScreenshots || false,
            scrollPage: true,
            scrollUntilStable: true,
            scrollUntilStableOptions: { maxScrolls: 20, stablePolls: 3 },
            waitForContent: 2000
          }
        });

        // Debug logging for raw data sizes (helps diagnose extraction issues)
        log('ORCHESTRATE', `Raw data for ${leaderboard.name}: markdown=${rawData.markdown?.length || 0}b, apis=${rawData.apiCalls?.length || 0}, html=${rawData.html?.length || 0}b`);

        // Check for paginated APIs and fetch additional pages
        // Detects patterns like: ?limit=50&page=1, ?page=1&limit=100, etc.
        await fetchPaginatedApiPages(page, rawData, leaderboard.name);

        // Load learned patterns for this site/leaderboard
        // Note: getLearnedPatterns expects basePath (lbscraper root), not dataDir
        const learnedPatterns = getLearnedPatterns(basePath, domain, leaderboard.name);
        if (learnedPatterns) {
          log('ORCHESTRATE', `Using learned patterns for ${leaderboard.name} (preferred: ${learnedPatterns.preferredSource || 'any'})`);
        }

        // Extract entries using hybrid fusion
        log('ORCHESTRATE', `Extracting entries for ${leaderboard.name}`);
        // Collect all known leaderboard names for API filtering
        const knownKeywords = toScrape.map(lb => lb.name);
        const extraction = await extractLeaderboardData({
          html: rawData.html,
          markdown: rawData.markdown,
          apiCalls: rawData.apiCalls,
          rawJsonResponses: rawData.rawJsonResponses,
          screenshot: rawData.screenshot,
          page,
          siteName: leaderboard.name,
          config: {
            minConfidence: config.minConfidence || 50,
            useFusion: true,  // Enable hybrid extraction
            siteName: leaderboard.name,
            learnedPatterns,  // Pass learned patterns to extractor
            knownKeywords     // Pass all known leaderboard names for API filtering
          }
        });

        // Check if extraction succeeded with VALID data
        // Must have at least 2 entries (some leaderboards legitimately have only 2-3 participants)
        // Wager/prize check is optional for sites that don't expose this data
        const hasValidData = extraction.entries.length >= 2;

        if (hasValidData) {
          // Build prize lookup map for validation
          const prizeLookup = new Map();
          let maxPrizeRank = 0;
          if (extraction.prizes && Array.isArray(extraction.prizes)) {
            for (const p of extraction.prizes) {
              if (p.rank && p.prize >= 0) {
                prizeLookup.set(p.rank, p.prize);
                if (p.rank > maxPrizeRank) maxPrizeRank = p.rank;
              }
            }
          }

          // Add timestamps, validate prizes, then normalize to standard schema
          // Only allow prizes for ranks that have explicit prize data
          const entriesWithTimestamps = extraction.entries.map(entry => {
            let validatedPrize = entry.prize || 0;

            // If we have a prize table, validate the prize
            if (maxPrizeRank > 0) {
              if (entry.rank > maxPrizeRank) {
                validatedPrize = 0;
              } else if (prizeLookup.has(entry.rank)) {
                validatedPrize = prizeLookup.get(entry.rank);
              }
            }

            return {
              ...entry,
              prize: validatedPrize,
              extractedAt: new Date().toISOString()
            };
          });

          // Normalize to standard schema (rank, username, wager, prize, timestamp, leaderboard_type)
          const normalizedEntries = normalizeEntries(entriesWithTimestamps, {
            leaderboardType: 'current',
            timestamp: new Date().toISOString()
          });

          // Dataset validation: completeness, sanity, strategy agreement
          const datasetValidation = validateDataset(normalizedEntries, {
            minRows: 2,
            crossValidation: extraction.crossValidation
          });
          const confidencePenalty = datasetValidation.confidencePenalty || 0;
          const adjustedConfidence = Math.max(0, (extraction.confidence || 0) - confidencePenalty);

          // Calculate total wagered across all entries
          const totalWagered = normalizedEntries.reduce((sum, entry) => sum + (entry.wager || 0), 0);

          // Calculate totalPrizePool: prefer API metadata, fallback to sum of prizes
          let totalPrizePool = extraction.prizes?._totalPrizePool || 0;
          if (totalPrizePool === 0 && normalizedEntries.length > 0) {
            // Sum up prizes from entries that have valid prizes
            totalPrizePool = normalizedEntries.reduce((sum, entry) => sum + (entry.prize || 0), 0);
          }

          result.results.push({
            id: crypto.randomUUID(),           // Unique leaderboard result ID (ONE per leaderboard)
            extractionId: extractionId,        // Reference to parent run
            name: leaderboard.name,
            url: page.url(),
            type: 'current',
            source: extraction.extractionMethod,
            entryCount: normalizedEntries.length,
            entries: normalizedEntries,
            prizes: extraction.prizes,
            totalPrizePool: totalPrizePool,
            totalWagered: totalWagered,
            confidence: adjustedConfidence,
            scrapedAt: new Date().toISOString(),
            validation: {
              datasetComplete: datasetValidation.valid,
              completeness: datasetValidation.completeness,
              sanity: datasetValidation.sanity,
              strategyAgreement: datasetValidation.strategyAgreement,
              confidencePenalty
            }
          });

          result.metadata.leaderboardsScraped++;
          if (!result.metadata.strategiesUsed.includes(extraction.extractionMethod)) {
            result.metadata.strategiesUsed.push(extraction.extractionMethod);
          }

          // Record successful extraction for learning (use validation-adjusted confidence)
          // Note: recordSuccessfulExtraction expects basePath (lbscraper root), not dataDir
          if (adjustedConfidence >= 70) {
            try {
              recordSuccessfulExtraction(basePath, domain, leaderboard.name, extraction, {
                url: page.url(),
                method: leaderboard.method || 'url',
                requiresClick: leaderboard.method === 'click'
              });
            } catch (e) {
              log('ORCHESTRATE', `Failed to record learned patterns: ${e.message}`);
            }
          }

          // Log cross-validation details if available
          if (extraction.crossValidation) {
            const cv = extraction.crossValidation;
            log('ORCHESTRATE', `Cross-validation: ${(cv.overallAgreement * 100).toFixed(0)}% agreement, ${cv.discrepancies?.length || 0} discrepancies`);
          }

          log('ORCHESTRATE', `${leaderboard.name}: ${extraction.entries.length} entries (${extraction.extractionMethod}, ${extraction.confidence}% confidence)`);
        } else {
          // EXTRACTION FAILED OR BAD DATA - Invoke Teacher Mode if enabled
          const reason = extraction.entries.length === 0
            ? 'No entries extracted'
            : `${extraction.entries.length} entries but data quality poor (wager/prize all 0 or too few entries)`;
          log('ORCHESTRATE', `${leaderboard.name}: ${reason} - checking Teacher Mode`);

          try {
            // Note: getSiteProfile expects basePath (lbscraper root), not dataDir
            const profile = await getSiteProfile(basePath, domain);
            const teacherDecision = shouldInvokeTeacherMode(profile, extraction.confidence || 0);

            if (teacherDecision.invoke) {
              log('ORCHESTRATE', `Invoking Teacher Mode for ${leaderboard.name}: ${teacherDecision.reason}`);

              const teacherResult = await evaluateWithTeacher(
                page,
                networkData,
                { results: [], entries: [], confidence: 0 },
                profile || { domain, status: 'new', attempts: 0, maxAttempts: 3 },
                config
              );

              if (teacherResult.improved && teacherResult.correctedResult?.entries?.length > 0) {
                log('ORCHESTRATE', `Teacher found ${teacherResult.correctedResult.entries.length} entries for ${leaderboard.name}`);

                // Add timestamps to Teacher-extracted entries (no per-entry IDs)
                const teacherEntriesWithTimestamps = teacherResult.correctedResult.entries.map(entry => ({
                  ...entry,
                  extractedAt: new Date().toISOString()
                }));

                // Calculate total wagered across all entries
                const teacherTotalWagered = teacherEntriesWithTimestamps.reduce((sum, entry) => sum + (entry.wager || 0), 0);

                // Calculate totalPrizePool from entries if Teacher extracted prizes
                const teacherTotalPrizePool = teacherEntriesWithTimestamps.reduce((sum, entry) => sum + (entry.prize || 0), 0);

                result.results.push({
                  id: crypto.randomUUID(),
                  extractionId: extractionId,
                  name: leaderboard.name,
                  url: page.url(),
                  type: 'current',
                  source: `teacher-phase${teacherResult.phase}`,
                  entryCount: teacherEntriesWithTimestamps.length,
                  entries: teacherEntriesWithTimestamps,
                  prizes: [],
                  totalPrizePool: teacherTotalPrizePool,
                  totalWagered: teacherTotalWagered,
                  confidence: teacherResult.confidence || 70,
                  scrapedAt: new Date().toISOString(),
                  teacherAssisted: true
                });

                result.metadata.leaderboardsScraped++;
                if (!result.metadata.strategiesUsed.includes(`teacher-phase${teacherResult.phase}`)) {
                  result.metadata.strategiesUsed.push(`teacher-phase${teacherResult.phase}`);
                }
              } else {
                log('ORCHESTRATE', `Teacher could not extract for ${leaderboard.name}: ${teacherResult.reason}`);
                result.errors.push(`No entries for ${leaderboard.name} (Teacher: ${teacherResult.reason})`);
              }
            } else {
              log('ORCHESTRATE', `Teacher Mode not invoked for ${leaderboard.name}: ${teacherDecision.reason}`);
              result.errors.push(`No entries for ${leaderboard.name}`);
            }
          } catch (teacherError) {
            log('ERR', `Teacher Mode error for ${leaderboard.name}: ${teacherError.message}`);
            result.errors.push(`No entries for ${leaderboard.name}`);
          }
        }

      } catch (lbError) {
        log('ERR', `Failed to scrape ${leaderboard.name}: ${lbError.message}`);
        result.errors.push(`${leaderboard.name}: ${lbError.message}`);
      }
    }

    // Record success for circuit breaker
    if (result.results.length > 0) {
      circuitBreaker.recordSuccess(domain);
    }

  } catch (error) {
    log('ERR', `Orchestration failed for ${domain}: ${error.message}`);
    result.errors.push(error.message);
    circuitBreaker.recordFailure(domain);
  } finally {
    if (typeof unrouteBetJuicy === 'function') unrouteBetJuicy();
  }

  // =========================================================================
  // VALIDATION: Detect suspicious data patterns and add warnings
  // =========================================================================
  result.warnings = [];

  for (const lb of result.results) {
    const warnings = validateLeaderboardData(lb);
    if (lb.validation && !lb.validation.datasetComplete) {
      const comp = lb.validation.completeness;
      if (comp && comp.issues && comp.issues.length > 0) {
        warnings.push(`dataset_incomplete: ${comp.issues.join('; ')}`);
      }
      if (lb.validation.strategyAgreement && lb.validation.strategyAgreement.lowConfidence) {
        warnings.push(`low_confidence: ${lb.validation.strategyAgreement.reason || 'strategy disagreement'}`);
      }
    }
    if (warnings.length > 0) {
      result.warnings.push({
        leaderboard: lb.name,
        issues: warnings
      });
      log('WARNING', `${lb.name}: ${warnings.join(', ')}`);
    }
  }

  result.metadata.completedAt = new Date().toISOString();

  // Log summary
  const warnCount = result.warnings.length;
  log('ORCHESTRATE', `Completed ${domain}: ${result.results.length} leaderboards, ${result.errors.length} errors, ${warnCount} warnings`);

  return result;
}

// ============================================================================
// LEADERBOARD DATA VALIDATION (Warning System)
// ============================================================================

/**
 * Validate leaderboard data and return warnings for suspicious patterns
 * @param {Object} lb - Leaderboard result object
 * @returns {string[]} - Array of warning messages
 */
function validateLeaderboardData(lb) {
  const warnings = [];

  if (!lb.entries || lb.entries.length === 0) {
    return ['No entries'];
  }

  // Sort entries by rank for analysis
  const sorted = [...lb.entries].sort((a, b) => a.rank - b.rank);

  // Rule 1: Prizes should be in descending order (highest wager = highest prize)
  // CRITICAL: This is a fundamental rule - prize order should match wager order
  const entriesWithPrizes = sorted.filter(e => e.prize > 0);
  if (entriesWithPrizes.length >= 3) {
    // Check if prizes decrease as rank increases (higher rank = lower prize)
    let prizeOrderViolations = 0;
    for (let i = 1; i < entriesWithPrizes.length; i++) {
      if (entriesWithPrizes[i].prize > entriesWithPrizes[i-1].prize) {
        prizeOrderViolations++;
      }
    }
    // If more than 20% of transitions violate prize ordering, flag it
    if (prizeOrderViolations > entriesWithPrizes.length * 0.2) {
      warnings.push(`Prize order violation: ${prizeOrderViolations} entries have higher prizes than higher-ranked users`);
    }
  }

  // Rule 2: Detect prizes that look like rank numbers (garbage DOM extraction)
  // Pattern: prize value is close to the rank number for ranks > 20
  let rankAsPrizeCount = 0;
  for (const entry of sorted) {
    if (entry.rank > 20 && entry.prize > 0 && entry.prize < 100) {
      // Check if prize is suspiciously close to rank number
      if (Math.abs(entry.prize - entry.rank) <= 15) {
        rankAsPrizeCount++;
      }
    }
  }
  if (rankAsPrizeCount >= 3) {
    warnings.push(`Garbage prizes detected: ${rankAsPrizeCount} entries have prizes near their rank number (DOM extraction bug)`);
  }

  // Rule 3: Check for wager order violations (higher rank should have lower wager)
  // This is ALWAYS true - leaderboards rank by wager
  let wagerOrderViolations = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].wager > sorted[i-1].wager && sorted[i-1].wager > 0) {
      wagerOrderViolations++;
    }
  }
  if (wagerOrderViolations > sorted.length * 0.1) {
    warnings.push(`Wager order violation: ${wagerOrderViolations} lower-ranked users have higher wagers (should never happen)`);
  }

  // Rule 4: Detect absurd prize/wager ratios
  // A prize that is larger than the wager is very suspicious (except for low-rank bonus leaderboards)
  let absurdRatioCount = 0;
  for (const entry of sorted) {
    if (entry.wager > 0 && entry.prize > entry.wager) {
      absurdRatioCount++;
    }
  }
  // Allow up to 3 entries with prize > wager (could be special bonuses)
  if (absurdRatioCount > 3 && absurdRatioCount > sorted.length * 0.2) {
    warnings.push(`Absurd prize/wager ratio: ${absurdRatioCount} entries have prize > wager (likely extraction error)`);
  }

  // Rule 5: Check for all zeros
  const allZeroWagers = sorted.every(e => e.wager === 0);
  const allZeroPrizes = sorted.every(e => e.prize === 0);
  if (allZeroWagers) {
    warnings.push('All entries have zero wager (data extraction likely failed)');
  }
  // Note: All zero prizes is valid for leaderboards that don't show prizes

  // Rule 6: Duplicate wagers (likely Frankenstein entries from DOM extraction)
  const wagerCounts = new Map();
  for (const entry of sorted) {
    const wager = Math.round(entry.wager);
    if (wager > 0) {
      wagerCounts.set(wager, (wagerCounts.get(wager) || 0) + 1);
    }
  }
  const duplicateWagers = Array.from(wagerCounts.entries()).filter(([w, c]) => c > 1);
  if (duplicateWagers.length >= 3) {
    warnings.push(`Duplicate wagers: ${duplicateWagers.length} wager values appear multiple times (possible extraction error)`);
  }

  return warnings;
}

// ============================================================================
// PAGINATED API FETCHING
// ============================================================================

/**
 * Detect and fetch additional pages from paginated APIs
 * Looks for APIs with pagination params (limit=X&page=1) and fetches subsequent pages
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {Object} rawData - Raw scraped data with rawJsonResponses
 * @param {string} siteName - Current leaderboard name for logging
 */
async function fetchPaginatedApiPages(page, rawData, siteName) {
  if (!rawData.rawJsonResponses || rawData.rawJsonResponses.length === 0) {
    log('ORCHESTRATE', `No API responses to check for pagination`);
    return;
  }

  const { fetchApiInBrowser } = require('../core/page-scraper');
  const { isHistoricalUrl } = require('../strategies/api-merger');

  log('ORCHESTRATE', `Checking ${rawData.rawJsonResponses.length} API responses for pagination...`);

  // Find APIs with pagination patterns
  for (const response of rawData.rawJsonResponses) {
    if (!response.url) continue;

    const url = response.url;

    // SKIP historical/past-winners APIs - these are for past leaderboards, not current
    if (isHistoricalUrl(url)) {
      log('ORCHESTRATE', `Skipping historical API (not paginating): ${url.slice(-60)}`);
      continue;
    }

    log('ORCHESTRATE', `Checking API URL: ${url.slice(-60)}`);  // Debug log

    // Detect pagination patterns: page=1, page=0, offset=0, etc.
    const pageMatch = url.match(/[?&](page)=(\d+)/i);
    const limitMatch = url.match(/[?&](limit)=(\d+)/i);

    if (pageMatch && limitMatch) {
      const pageParam = pageMatch[1];
      const currentPage = parseInt(pageMatch[2]);
      const limit = parseInt(limitMatch[2]);

      // Check if response contains limit-sized data (might have more pages)
      const entries = findEntriesInData(response.data);
      if (entries && entries.length >= limit) {
        log('ORCHESTRATE', `Detected paginated API: ${limit} entries on page ${currentPage}, checking for more pages...`);

        // Fetch additional pages (up to 5 more pages = 300 total entries with limit=50)
        for (let nextPage = currentPage + 1; nextPage <= currentPage + 5; nextPage++) {
          const nextUrl = url.replace(
            new RegExp(`([?&])${pageParam}=\\d+`, 'i'),
            `$1${pageParam}=${nextPage}`
          );

          try {
            const result = await fetchApiInBrowser(page, nextUrl, { timeout: 5000 });

            if (result.success && result.data) {
              const nextEntries = findEntriesInData(result.data);

              if (nextEntries && nextEntries.length > 0) {
                log('ORCHESTRATE', `Fetched page ${nextPage}: ${nextEntries.length} additional entries`);

                // Add to rawJsonResponses
                rawData.rawJsonResponses.push({
                  url: nextUrl,
                  data: result.data,
                  timestamp: Date.now(),
                  _paginationFetch: true
                });

                // If fewer entries than limit, we've hit the last page
                if (nextEntries.length < limit) {
                  log('ORCHESTRATE', `Page ${nextPage} has fewer entries than limit, stopping pagination`);
                  break;
                }
              } else {
                // No more entries
                log('ORCHESTRATE', `Page ${nextPage} has no entries, stopping pagination`);
                break;
              }
            } else {
              // API error or no data
              break;
            }
          } catch (e) {
            log('ORCHESTRATE', `Failed to fetch page ${nextPage}: ${e.message}`);
            break;
          }
        }
      }
    }
  }
}

/**
 * Find entries array in API response data
 * @param {any} data - API response data
 * @returns {Array|null} - Entries array or null
 */
function findEntriesInData(data) {
  if (!data) return null;

  // Direct array
  if (Array.isArray(data)) return data;

  // Object with entries property
  if (typeof data === 'object') {
    const keys = ['leaderboard', 'entries', 'users', 'players', 'data', 'results', 'leaders', 'ranking'];
    for (const key of keys) {
      if (data[key] && Array.isArray(data[key])) {
        return data[key];
      }
    }
  }

  return null;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  orchestrateScrape,
  withRetry,
  circuitBreaker
};
