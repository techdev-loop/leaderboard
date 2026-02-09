#!/usr/bin/env node
/**
 * New Scraper Entry Point
 *
 * Uses the refactored modular architecture:
 * - core/ (3 pillars: crawler, scraper, extractor)
 * - strategies/ (pluggable extraction methods)
 * - orchestrators/ (coordination layer)
 *
 * Usage:
 *   node new-run-scraper.js <url>           # Single site
 *   node new-run-scraper.js --batch         # Batch mode
 *   node new-run-scraper.js --batch -p      # Batch production
 *
 * This is the new entry point for the refactored scraper.
 * The old run-scraper.js (formerly test-scraper.js) is preserved
 * for comparison during migration.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

// Apply stealth plugin
chromium.use(stealth());

// Import new modular architecture
const { orchestrateScrape } = require('./orchestrators/scrape-orchestrator');
const { runBatch } = require('./orchestrators/batch-runner');
const { setupNetworkCapture } = require('./shared/network-capture');
const { log, initLogging, getRunId, loadKeywords } = require('./shared/utils');
const { buildLegacyConfig, getJsonLoggingConfig } = require('./shared/config');
const { saveDebugLog, cleanupOldLogs } = require('./shared/json-logger');
const { initChallengeBypass, navigateWithBypass } = require('./shared/page-navigation');

// ============================================================================
// SINGLE SITE MODE
// ============================================================================

async function scrapeSingleSite(url, config) {
  let browser = null;

  console.log('');
  console.log('🚀 Leaderboard Scraper v7.0 (Modular Architecture)');
  console.log(`   URL: ${url}`);
  console.log(`   Mode: ${config.production?.enabled ? 'PRODUCTION' : 'Development'}`);
  console.log(`   Run ID: ${getRunId()}`);
  console.log('');

  try {
    // Launch browser (headless by default, set SCRAPER_HEADLESS=false to show browser for debugging)
    const headless = process.env.SCRAPER_HEADLESS !== 'false';
    console.log(`🌐 Launching browser... (headless: ${headless})`);
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
    const keywords = loadKeywords(config.paths.keywords);

    // Initialize challenge bypass (Cloudflare, hCaptcha, etc.)
    try {
      const challengeBypass = require('./challenge-bypass');
      initChallengeBypass(challengeBypass);
      log('NAV', 'Challenge bypass initialized');
    } catch (e) {
      console.log('⚠️ Challenge bypass module not found, continuing without it');
    }

    // Navigate to page with bypass support
    log('NAV', `Navigating to ${url}`);
    const navResult = await navigateWithBypass(page, url, { maxRetries: 3, waitAfterLoad: 5000 });
    if (!navResult.success) {
      throw new Error(`Navigation failed: ${navResult.error}`);
    }
    if (navResult.challengeBypassed) {
      log('NAV', 'Challenge was bypassed successfully');
    }

    // Run orchestrator
    const result = await orchestrateScrape({
      page,
      baseUrl: url,
      networkData,
      config,
      keywords
    });

    // Log results
    console.log('');
    console.log('═'.repeat(60));
    console.log('SCRAPING COMPLETE');
    console.log('═'.repeat(60));
    console.log(`   Leaderboards found: ${result.metadata.leaderboardsDiscovered}`);
    console.log(`   Leaderboards scraped: ${result.metadata.leaderboardsScraped}`);
    console.log(`   Strategies used: ${result.metadata.strategiesUsed.join(', ') || 'none'}`);
    console.log(`   Errors: ${result.errors.length}`);
    console.log('═'.repeat(60));
    console.log('');

    // Log each result
    for (const lb of result.results) {
      console.log(`   📊 ${lb.name}: ${lb.entryCount} entries (${lb.source}, ${lb.confidence}% confidence)`);
    }

    // Save results to current (always)
    const resultsPath = path.join(__dirname, 'results', 'current', `${new URL(url).hostname}.json`);
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, JSON.stringify(result, null, 2));
    console.log(`\n📁 Results saved to: ${resultsPath}`);

    // Save to debug logs if enabled
    try {
      const loggingConfig = await getJsonLoggingConfig();

      if (loggingConfig.enabled) {
        const domain = new URL(url).hostname;
        const logPath = saveDebugLog(domain, result);
        log('SAVE', `Debug log saved to: ${logPath}`);
      }

      // Cleanup old logs if auto-cleanup is enabled (run occasionally - 10% chance)
      if (loggingConfig.autoCleanupEnabled && Math.random() < 0.1) {
        const { deletedCount, freedBytes } = cleanupOldLogs(loggingConfig.retentionHours);
        if (deletedCount > 0) {
          log('CLEANUP', `Deleted ${deletedCount} old log files (freed ${(freedBytes / 1024).toFixed(1)} KB)`);
        }
      }
    } catch (logErr) {
      log('WARN', `JSON logging error: ${logErr.message}`);
    }

    // Save to database
    try {
      const { saveToDatabase, disconnect } = require('./shared/db-save');
      const domain = new URL(url).hostname;
      const dbResult = await saveToDatabase(domain, result);
      log('DB', `Saved to database: site ${dbResult.siteId} (${dbResult.snapshotCount} snapshots, ${dbResult.entryCount} entries)`);
      await disconnect();
    } catch (dbErr) {
      log('DB-ERROR', `Failed to save to database: ${dbErr.message}`);
      // Continue - JSON save already succeeded
    }

    return result;

  } catch (error) {
    console.error('❌ Error:', error.message);
    return { results: [], errors: [error.message] };
  } finally {
    if (browser) await browser.close();
    console.log('\n🏁 Complete!');
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  const batchMode = args.includes('--batch') || args.includes('-b');
  const productionMode = args.includes('--production') || args.includes('-p');

  initLogging(productionMode);

  const config = buildLegacyConfig(__dirname);
  config.production = { enabled: productionMode };

  if (batchMode) {
    // Batch mode - use batch runner
    // Pass URL args if provided (e.g. node new-run-scraper.js --batch https://site1.com https://site2.com)
    const urlArgs = args.filter(a => a.startsWith('http'));
    const limitIdx = args.indexOf('--limit');
    const limitShortIdx = args.indexOf('-l');
    const limitArg = limitIdx !== -1 ? args[limitIdx + 1] : (limitShortIdx !== -1 ? args[limitShortIdx + 1] : null);
    const limit = limitArg != null ? parseInt(limitArg, 10) : null;
    await runBatch({
      configDir: path.join(__dirname, 'orchestrators'),
      production: productionMode,
      maxWorkers: 1,
      delayBetweenSitesMs: 5000,
      filterUrls: urlArgs.length > 0 ? urlArgs : null,
      limit: Number.isFinite(limit) && limit > 0 ? limit : null
    });
  } else {
    // Single URL mode
    const urlArg = args.find(a => a.startsWith('http'));

    if (!urlArg) {
      console.log('');
      console.log('🚀 Leaderboard Scraper v7.0 (Modular Architecture)');
      console.log('');
      console.log('Usage:');
      console.log('  node new-run-scraper.js <url>            # Single site');
      console.log('  node new-run-scraper.js <url> -p         # Single site (production)');
      console.log('  node new-run-scraper.js --batch          # Batch from websites.txt');
      console.log('  node new-run-scraper.js --batch --limit 50   # First 50 sites from websites.txt');
      console.log('  node new-run-scraper.js --batch <url...> # Batch specific URLs only');
      console.log('  node new-run-scraper.js --batch -p       # Batch (production)');
      console.log('');
      console.log('Examples:');
      console.log('  node new-run-scraper.js https://example.com/leaderboards');
      console.log('  node new-run-scraper.js https://example.com --production');
      console.log('');
      process.exit(1);
    }

    await scrapeSingleSite(urlArg, config);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
