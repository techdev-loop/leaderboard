/**
 * Core Modules - Index
 *
 * The 3 pillars of the scraper architecture:
 * 1. Leaderboard Crawler - Discovers leaderboards on a site
 * 2. Page Scraper - Collects raw data from pages
 * 3. Data Extractor - Parses raw data into entries
 *
 * Usage:
 *   const { crawler, scraper, extractor } = require('./core');
 *
 *   // Discover leaderboards
 *   const discovery = await crawler.discoverLeaderboards({ page, baseUrl, keywords });
 *
 *   // Scrape page data
 *   const rawData = await scraper.scrapePageData({ page, url, networkData });
 *
 *   // Extract entries
 *   const result = await extractor.extractLeaderboardData({
 *     ...rawData,
 *     page,
 *     config: { minConfidence: 50 }
 *   });
 */

const crawler = require('./leaderboard-crawler');
const scraper = require('./page-scraper');
const extractor = require('./data-extractor');
const fusion = require('./data-fusion');
const crossValidator = require('./cross-validator');
const qualityScorer = require('./quality-scorer');

module.exports = {
  crawler,
  scraper,
  extractor,
  fusion,
  crossValidator,
  qualityScorer,

  // Direct exports for convenience
  discoverLeaderboards: crawler.discoverLeaderboards,
  clickSwitcher: crawler.clickSwitcher,
  scrapePageData: scraper.scrapePageData,
  extractLeaderboardData: extractor.extractLeaderboardData,

  // Fusion layer exports
  fuseExtractionResults: fusion.fuseExtractionResults,
  crossValidate: crossValidator.crossValidate,
  calculateQualityScore: qualityScorer.calculateQualityScore
};
