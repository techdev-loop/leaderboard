/**
 * Batch Runner - ORIGINAL VERSION
 *
 * This is the original batch-runner.js before the temporary timeout/parallel changes.
 * After batch testing is complete, replace lbscraper/orchestrators/batch-runner.js with this file.
 *
 * RESPONSIBILITY: Run scraper across multiple sites
 * - Load sites from database or file
 * - Respect refresh intervals per site
 * - Parallel execution with configurable workers
 * - Graceful shutdown handling
 * - Progress tracking and reporting
 *
 * Future: BullMQ integration for job queuing
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

const { log, initLogging, getRunId, loadWebsites, loadKeywords } = require('./lbscraper/shared/utils');
const { buildLegacyConfig } = require('./lbscraper/shared/config');
const { setupNetworkCapture } = require('./lbscraper/shared/network-capture');
const { orchestrateScrape, circuitBreaker } = require('./lbscraper/orchestrators/scrape-orchestrator');
const { clearGlobalEntriesTracker } = require('./lbscraper/shared/entry-validation');

// Apply stealth plugin
chromium.use(stealth());

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let isShuttingDown = false;
let activeJobs = new Set();

function setupShutdownHandlers() {
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log('BATCH', `${signal} received, initiating graceful shutdown...`);
    log('BATCH', `Waiting for ${activeJobs.size} active jobs to complete...`);

    // Wait up to 30 seconds for active jobs
    const timeout = 30000;
    const start = Date.now();

    while (activeJobs.size > 0 && Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 1000));
    }

    if (activeJobs.size > 0) {
      log('BATCH', `Timeout waiting for ${activeJobs.size} jobs, forcing exit`);
    }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ============================================================================
// SITE LOADER
// ============================================================================

/**
 * Load sites to scrape from database or file
 * @param {Object} config - Configuration
 * @returns {Promise<Array>} - Sites to scrape
 */
async function loadSitesToScrape(config) {
  // TODO: Load from database when available
  // For now, load from websites.txt

  const urls = loadWebsites(config.paths.websites);

  return urls.map(url => ({
    url,
    domain: new URL(url).hostname,
    refreshInterval: 3600000, // Default 1 hour
    enabled: true,
    lastScrapedAt: null
  }));
}

/**
 * Filter sites that need scraping based on refresh interval
 * @param {Array} sites - All sites
 * @returns {Array} - Sites due for scraping
 */
function filterDueSites(sites) {
  const now = Date.now();

  return sites.filter(site => {
    if (!site.enabled) return false;
    if (!site.lastScrapedAt) return true;

    const lastScrape = new Date(site.lastScrapedAt).getTime();
    return now - lastScrape >= site.refreshInterval;
  });
}

// ============================================================================
// SINGLE SITE PROCESSOR
// ============================================================================

/**
 * Process a single site
 * @param {Object} site - Site to process
 * @param {Object} config - Configuration
 * @param {Array} keywords - Keywords list
 * @returns {Promise<Object>} - Processing result
 */
async function processSite(site, config, keywords) {
  const jobId = `${site.domain}-${Date.now()}`;
  activeJobs.add(jobId);

  let browser = null;
  const startTime = Date.now();

  const result = {
    url: site.url,
    domain: site.domain,
    success: false,
    resultCount: 0,
    results: [],
    error: null,
    processedAt: new Date().toISOString(),
    elapsedMs: 0
  };

  try {
    log('BATCH', `Processing ${site.domain}...`);

    // Clear global tracker
    clearGlobalEntriesTracker();

    // Launch browser (headless by default, set SCRAPER_HEADLESS=false to show browser for debugging)
    const headless = process.env.SCRAPER_HEADLESS !== 'false';
    browser = await chromium.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US'
    });

    const page = await context.newPage();
    const networkData = await setupNetworkCapture(page);

    // Initialize challenge bypass (Cloudflare, hCaptcha, etc.)
    try {
      const challengeBypass = require('./lbscraper/challenge-bypass');
      const { initChallengeBypass } = require('./lbscraper/shared/page-navigation');
      initChallengeBypass(challengeBypass);
    } catch (e) {
      log('BATCH', 'Challenge bypass module not available');
    }

    // Run orchestrator
    const orchResult = await orchestrateScrape({
      page,
      baseUrl: site.url,
      networkData,
      config,
      keywords
    });

    result.success = orchResult.results.length > 0;
    result.resultCount = orchResult.results.length;
    result.results = orchResult.results;

    if (orchResult.errors.length > 0) {
      result.error = orchResult.errors.join('; ');
    }

    log('BATCH', `Completed ${site.domain}: ${result.resultCount} leaderboards`);

  } catch (error) {
    log('ERR', `Failed ${site.domain}: ${error.message}`);
    result.error = error.message;
    circuitBreaker.recordFailure(site.domain);
  } finally {
    if (browser) {
      await browser.close();
    }
    activeJobs.delete(jobId);
    result.elapsedMs = Date.now() - startTime;
  }

  return result;
}

// ============================================================================
// BATCH PROCESSOR
// ============================================================================

/**
 * Process multiple sites
 * @param {Object} options - Batch options
 * @returns {Promise<Object>} - Batch summary
 */
async function runBatch(options = {}) {
  const {
    configDir = __dirname,
    production = false,
    maxWorkers = 1,
    delayBetweenSitesMs = 5000
  } = options;

  setupShutdownHandlers();
  initLogging(production);

  const config = buildLegacyConfig(path.join(configDir, 'lbscraper'));
  config.production = { enabled: production };

  const keywords = loadKeywords(config.paths.keywords);
  const sites = await loadSitesToScrape(config);
  const dueSites = filterDueSites(sites);

  log('BATCH', `Found ${dueSites.length}/${sites.length} sites due for scraping`);

  if (dueSites.length === 0) {
    log('BATCH', 'No sites due for scraping');
    return { totalUrls: 0, successful: 0, failed: 0 };
  }

  const allResults = [];
  const startTime = Date.now();

  // Process sites (sequential for now, parallel later with BullMQ)
  for (let i = 0; i < dueSites.length && !isShuttingDown; i++) {
    const site = dueSites[i];

    log('BATCH', `[${i + 1}/${dueSites.length}] Processing ${site.domain}`);

    const result = await processSite(site, config, keywords);
    allResults.push(result);

    // Delay between sites
    if (i < dueSites.length - 1 && !isShuttingDown) {
      log('BATCH', `Waiting ${delayBetweenSitesMs}ms before next site...`);
      await new Promise(r => setTimeout(r, delayBetweenSitesMs));
    }
  }

  // Build summary
  const elapsed = Date.now() - startTime;
  const summary = {
    runId: getRunId(),
    totalUrls: dueSites.length,
    successful: allResults.filter(r => r.success).length,
    failed: allResults.filter(r => !r.success).length,
    totalLeaderboards: allResults.reduce((s, r) => s + r.resultCount, 0),
    elapsedMs: elapsed,
    elapsedFormatted: formatElapsed(elapsed),
    processedAt: new Date().toISOString(),
    results: allResults
  };

  // Save summary
  const summaryPath = path.join(configDir, 'lbscraper', 'data', 'batch-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Log summary
  log('BATCH', '');
  log('BATCH', '═'.repeat(60));
  log('BATCH', 'BATCH COMPLETE');
  log('BATCH', '═'.repeat(60));
  log('BATCH', `Total: ${summary.totalUrls} | Success: ${summary.successful} | Failed: ${summary.failed}`);
  log('BATCH', `Leaderboards: ${summary.totalLeaderboards} | Time: ${summary.elapsedFormatted}`);
  log('BATCH', '═'.repeat(60));

  return summary;
}

/**
 * Format elapsed time
 * @param {number} ms - Milliseconds
 * @returns {string} - Formatted time
 */
function formatElapsed(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const production = args.includes('--production') || args.includes('-p');
  const maxWorkers = parseInt(args.find(a => a.startsWith('--workers='))?.split('=')[1] || '1');
  const delay = parseInt(args.find(a => a.startsWith('--delay='))?.split('=')[1] || '5000');

  console.log('');
  console.log('🚀 Batch Runner');
  console.log(`   Mode: ${production ? 'PRODUCTION' : 'Development'}`);
  console.log(`   Workers: ${maxWorkers}`);
  console.log(`   Delay: ${delay}ms`);
  console.log('');

  await runBatch({
    configDir: __dirname,
    production,
    maxWorkers,
    delayBetweenSitesMs: delay
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  runBatch,
  processSite,
  loadSitesToScrape,
  filterDueSites
};

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
