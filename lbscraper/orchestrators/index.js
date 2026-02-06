/**
 * Orchestrators - Index
 *
 * High-level coordinators for scraping operations:
 * - scrape-orchestrator: Coordinates 3 pillars for single site
 * - batch-runner: Runs scraper across multiple sites
 *
 * Usage:
 *   const { orchestrateScrape, runBatch } = require('./orchestrators');
 *
 *   // Single site
 *   const result = await orchestrateScrape({ page, baseUrl, networkData, config });
 *
 *   // Batch
 *   const summary = await runBatch({ production: true, maxWorkers: 2 });
 */

const scrapeOrchestrator = require('./scrape-orchestrator');
const batchRunner = require('./batch-runner');

module.exports = {
  // Scrape orchestrator
  orchestrateScrape: scrapeOrchestrator.orchestrateScrape,
  withRetry: scrapeOrchestrator.withRetry,
  circuitBreaker: scrapeOrchestrator.circuitBreaker,

  // Batch runner
  runBatch: batchRunner.runBatch,
  processSite: batchRunner.processSite,
  loadSitesToScrape: batchRunner.loadSitesToScrape,
  filterDueSites: batchRunner.filterDueSites
};
