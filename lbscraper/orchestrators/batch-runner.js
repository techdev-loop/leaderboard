/**
 * Batch Runner
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

const { log, initLogging, getRunId, loadWebsites, loadKeywords } = require('../shared/utils');
const { buildLegacyConfig } = require('../shared/config');
const { setupNetworkCapture } = require('../shared/network-capture');
const { orchestrateScrape, circuitBreaker } = require('./scrape-orchestrator');
const { clearGlobalEntriesTracker } = require('../shared/entry-validation');

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

// ============================================================================
// Per-site timeout: allows multi-leaderboard sites (e.g. 5+ tabs) to complete.
// Override with SITE_TIMEOUT_MS in .env (e.g. 600000 for 10 min).
// ============================================================================
const SITE_TIMEOUT_MS = parseInt(process.env.SITE_TIMEOUT_MS, 10) || 5 * 60 * 1000; // 5 min default for accurate scraping

/**
 * Wrap a promise with a timeout
 * @param {Promise} promise - Promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} timeoutMessage - Message for timeout error
 * @returns {Promise} - Promise that rejects on timeout
 */
function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

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
    elapsedMs: 0,
    timedOut: false // TEMPORARY: Track if site timed out
  };

  try {
    log('BATCH', `Processing ${site.domain}... (max ${SITE_TIMEOUT_MS / 1000}s)`);

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
      const challengeBypass = require('../challenge-bypass');
      const { initChallengeBypass } = require('../shared/page-navigation');
      initChallengeBypass(challengeBypass);
    } catch (e) {
      log('BATCH', 'Challenge bypass module not available');
    }

    // TEMPORARY: Run orchestrator with timeout to prevent infinite loops
    const orchResult = await withTimeout(
      orchestrateScrape({
        page,
        baseUrl: site.url,
        networkData,
        config,
        keywords
      }),
      SITE_TIMEOUT_MS,
      `TIMEOUT: Site ${site.domain} exceeded ${SITE_TIMEOUT_MS / 1000}s limit`
    );

    result.success = orchResult.results.length > 0;
    result.resultCount = orchResult.results.length;
    result.results = orchResult.results;

    if (orchResult.errors.length > 0) {
      result.error = orchResult.errors.join('; ');
    }

    // Save to results/current for every site (same as single-site mode) so all sites have output
    try {
      const currentDir = config.paths?.currentResultsDir || path.join(__dirname, '..', 'results', 'current');
      fs.mkdirSync(currentDir, { recursive: true });
      const resultsPath = path.join(currentDir, `${site.domain}.json`);
      fs.writeFileSync(resultsPath, JSON.stringify(orchResult, null, 2));
      log('BATCH', `Saved to ${resultsPath}`);
    } catch (saveErr) {
      log('ERR', `Failed to save JSON for ${site.domain}: ${saveErr.message}`);
    }

    // Save to database if we have results
    if (result.success) {
      try {
        const { saveToDatabase } = require('../shared/db-save');
        const dbResult = await saveToDatabase(site.domain, { results: orchResult.results });
        log('BATCH', `Saved to DB: ${dbResult.snapshotCount} snapshots, ${dbResult.entryCount} entries`);
        result.dbSaved = true;
        result.dbSnapshots = dbResult.snapshotCount;
        result.dbEntries = dbResult.entryCount;
      } catch (dbErr) {
        log('ERR', `DB save failed for ${site.domain}: ${dbErr.message}`);
        result.dbError = dbErr.message;
      }
    }

    log('BATCH', `Completed ${site.domain}: ${result.resultCount} leaderboards`);

  } catch (error) {
    // TEMPORARY: Check if it was a timeout
    if (error.message.includes('TIMEOUT:')) {
      log('BATCH', `⏱️ TIMEOUT: ${site.domain} took too long, skipping to next site`);
      result.timedOut = true;
      result.error = error.message;
    } else {
      log('ERR', `Failed ${site.domain}: ${error.message}`);
      result.error = error.message;
    }
    circuitBreaker.recordFailure(site.domain);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        log('ERR', `Failed to close browser for ${site.domain}: ${closeErr.message}`);
      }
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
    delayBetweenSitesMs = 5000,
    filterUrls = null,  // Array of URLs to filter to, or null for all
    limit = null        // Max number of sites to process (e.g. 50 for first 50 from websites.txt)
  } = options;

  setupShutdownHandlers();
  initLogging(production);

  // basePath must be the lbscraper root (parent of orchestrators) so paths.websites, paths.currentResultsDir resolve correctly
  const basePath = path.isAbsolute(configDir) ? path.join(configDir, '..') : path.resolve(configDir, '..');
  const config = buildLegacyConfig(basePath);
  config.production = { enabled: production };

  const keywords = loadKeywords(config.paths.keywords);

  let sites;
  if (filterUrls && filterUrls.length > 0) {
    // Use command-line URLs instead of websites.txt
    sites = filterUrls.map(url => ({
      url,
      domain: new URL(url).hostname,
      refreshInterval: 3600000,
      enabled: true,
      lastScrapedAt: null
    }));
    log('BATCH', `Using ${sites.length} URLs from command line`);
  } else {
    sites = await loadSitesToScrape(config);
  }

  let dueSites = filterDueSites(sites);
  if (limit != null && limit > 0) {
    dueSites = dueSites.slice(0, limit);
    log('BATCH', `Limited to first ${dueSites.length} sites (--limit ${limit})`);
  }

  log('BATCH', `Found ${dueSites.length}/${sites.length} sites due for scraping`);

  if (dueSites.length === 0) {
    log('BATCH', 'No sites due for scraping');
    return { totalUrls: 0, successful: 0, failed: 0 };
  }

  const allResults = [];
  const startTime = Date.now();

  // TEMPORARY: Process sites in parallel with maxWorkers concurrent browsers
  if (maxWorkers > 1) {
    log('BATCH', `Running with ${maxWorkers} parallel workers`);

    // Process in batches of maxWorkers
    for (let i = 0; i < dueSites.length && !isShuttingDown; i += maxWorkers) {
      const batch = dueSites.slice(i, Math.min(i + maxWorkers, dueSites.length));

      log('BATCH', `[Batch ${Math.floor(i / maxWorkers) + 1}] Processing ${batch.length} sites in parallel: ${batch.map(s => s.domain).join(', ')}`);

      const batchResults = await Promise.all(
        batch.map(site => processSite(site, config, keywords))
      );

      allResults.push(...batchResults);

      // Small delay between batches
      if (i + maxWorkers < dueSites.length && !isShuttingDown) {
        log('BATCH', `Waiting ${delayBetweenSitesMs}ms before next batch...`);
        await new Promise(r => setTimeout(r, delayBetweenSitesMs));
      }
    }
  } else {
    // Sequential processing (original behavior)
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
  }

  // Build summary
  const elapsed = Date.now() - startTime;
  const timedOutCount = allResults.filter(r => r.timedOut).length; // TEMPORARY
  const summary = {
    runId: getRunId(),
    totalUrls: dueSites.length,
    successful: allResults.filter(r => r.success).length,
    failed: allResults.filter(r => !r.success && !r.timedOut).length,
    timedOut: timedOutCount, // TEMPORARY: Track timed out sites
    totalLeaderboards: allResults.reduce((s, r) => s + r.resultCount, 0),
    elapsedMs: elapsed,
    elapsedFormatted: formatElapsed(elapsed),
    processedAt: new Date().toISOString(),
    results: allResults
  };

  // Save summary (ensure data dir exists)
  const dataDir = path.join(configDir, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const summaryPath = path.join(dataDir, 'batch-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // TEMPORARY: Generate detailed report for batch testing
  const reportPath = path.join(dataDir, `batch-report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const successfulSites = allResults.filter(r => r.success);
  const failedSites = allResults.filter(r => !r.success && !r.timedOut);
  const timedOutSites = allResults.filter(r => r.timedOut);

  let report = '';
  report += '═'.repeat(80) + '\n';
  report += '                         BATCH SCRAPE REPORT\n';
  report += '═'.repeat(80) + '\n';
  report += `Run ID: ${summary.runId}\n`;
  report += `Completed: ${summary.processedAt}\n`;
  report += `Duration: ${summary.elapsedFormatted}\n`;
  report += '\n';
  report += `SUMMARY:\n`;
  report += `  Total Sites: ${summary.totalUrls}\n`;
  report += `  Successful: ${summary.successful}\n`;
  report += `  Failed: ${summary.failed}\n`;
  report += `  Timed Out: ${summary.timedOut}\n`;
  report += `  Total Leaderboards Extracted: ${summary.totalLeaderboards}\n`;
  report += '\n';

  // Successful sites with leaderboard details
  report += '═'.repeat(80) + '\n';
  report += `✅ SUCCESSFUL SITES (${successfulSites.length})\n`;
  report += '═'.repeat(80) + '\n';
  let totalDbSnapshots = 0;
  let totalDbEntries = 0;
  for (const site of successfulSites) {
    const dbStatus = site.dbSaved ? `DB: ${site.dbSnapshots} snapshots, ${site.dbEntries} entries` : (site.dbError ? `DB ERROR: ${site.dbError}` : 'Not saved to DB');
    report += `\n${site.domain} (${site.resultCount} leaderboards, ${Math.round(site.elapsedMs / 1000)}s)\n`;
    report += `  URL: ${site.url}\n`;
    report += `  ${dbStatus}\n`;
    if (site.dbSaved) {
      totalDbSnapshots += site.dbSnapshots || 0;
      totalDbEntries += site.dbEntries || 0;
    }
    if (site.results && site.results.length > 0) {
      for (const lb of site.results) {
        const entries = lb.entries?.length || 0;
        const confidence = lb.confidence || 0;
        const source = lb.source || 'unknown';
        report += `  - ${lb.name || 'default'}: ${entries} entries, ${confidence}% confidence (${source})\n`;
      }
    }
  }
  report += `\nDATABASE TOTALS: ${totalDbSnapshots} snapshots, ${totalDbEntries} entries saved\n`;

  // Timed out sites
  if (timedOutSites.length > 0) {
    report += '\n';
    report += '═'.repeat(80) + '\n';
    report += `⏱️ TIMED OUT SITES (${timedOutSites.length}) - Need Investigation\n`;
    report += '═'.repeat(80) + '\n';
    for (const site of timedOutSites) {
      report += `\n${site.domain}\n`;
      report += `  URL: ${site.url}\n`;
      report += `  Elapsed: ${Math.round(site.elapsedMs / 1000)}s (hit timeout)\n`;
    }
  }

  // Failed sites with errors
  if (failedSites.length > 0) {
    report += '\n';
    report += '═'.repeat(80) + '\n';
    report += `❌ FAILED SITES (${failedSites.length})\n`;
    report += '═'.repeat(80) + '\n';
    for (const site of failedSites) {
      report += `\n${site.domain}\n`;
      report += `  URL: ${site.url}\n`;
      report += `  Elapsed: ${Math.round(site.elapsedMs / 1000)}s\n`;
      report += `  Error: ${site.error || 'Unknown error'}\n`;
    }
  }

  report += '\n';
  report += '═'.repeat(80) + '\n';
  report += '                           END OF REPORT\n';
  report += '═'.repeat(80) + '\n';

  fs.writeFileSync(reportPath, report);
  log('BATCH', `Detailed report saved to: ${reportPath}`);

  // Log summary
  log('BATCH', '');
  log('BATCH', '═'.repeat(60));
  log('BATCH', 'BATCH COMPLETE');
  log('BATCH', '═'.repeat(60));
  log('BATCH', `Total: ${summary.totalUrls} | Success: ${summary.successful} | Failed: ${summary.failed} | Timed Out: ${summary.timedOut}`);
  log('BATCH', `Leaderboards: ${summary.totalLeaderboards} | Time: ${summary.elapsedFormatted}`);

  // TEMPORARY: List timed out sites for investigation
  if (timedOutCount > 0) {
    log('BATCH', '');
    log('BATCH', '⏱️ TIMED OUT SITES (need investigation):');
    allResults.filter(r => r.timedOut).forEach(r => {
      log('BATCH', `   - ${r.domain}`);
    });
  }

  // List failed sites
  if (failedSites.length > 0) {
    log('BATCH', '');
    log('BATCH', '❌ FAILED SITES:');
    failedSites.forEach(r => {
      log('BATCH', `   - ${r.domain}: ${r.error?.substring(0, 80) || 'Unknown error'}`);
    });
  }

  log('BATCH', '═'.repeat(60));
  log('BATCH', `Full report: ${reportPath}`);

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

  // Extract URL arguments (any arg that looks like a URL)
  const urlArgs = args.filter(a => a.startsWith('http://') || a.startsWith('https://'));

  console.log('');
  console.log('🚀 Batch Runner');
  console.log(`   Mode: ${production ? 'PRODUCTION' : 'Development'}`);
  console.log(`   Workers: ${maxWorkers}`);
  console.log(`   Delay: ${delay}ms`);
  if (urlArgs.length > 0) {
    console.log(`   URLs: ${urlArgs.length} specified on command line`);
  }
  console.log('');

  await runBatch({
    configDir: __dirname,
    production,
    maxWorkers,
    delayBetweenSitesMs: delay,
    filterUrls: urlArgs.length > 0 ? urlArgs : null
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
