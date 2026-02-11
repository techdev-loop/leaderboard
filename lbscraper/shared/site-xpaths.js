/**
 * Per-Site XPath Configuration (Scalable Scraper Architecture)
 *
 * Loads and returns XPath selectors for each domain/leaderboard.
 * Use site-specific XPaths before scrape for correct extraction.
 * Add configs to data/site-xpaths.json.
 */

const fs = require('fs');
const path = require('path');

/**
 * Get XPath config for a domain (and optionally leaderboard name)
 * @param {string} basePath - lbscraper root
 * @param {string} domain - e.g. "paxgambles.com"
 * @param {string} [leaderboardName] - e.g. "diceblox"
 * @returns {Object|null} - { table, rows, rankCol, usernameCol, wagerCol, prizeCol } or null
 */
function getXPathConfig(basePath, domain, leaderboardName = null) {
  const configPath = path.join(basePath, 'data', 'site-xpaths.json');
  if (!fs.existsSync(configPath)) return null;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return null;
  }

  const normalized = (domain || '').toLowerCase().replace(/^www\./, '');
  const siteConfig = config[normalized] || config[domain];
  if (!siteConfig) return null;

  const lbName = (leaderboardName || '').toLowerCase();
  const lbConfig = lbName && siteConfig[lbName] ? siteConfig[lbName] : siteConfig.default || siteConfig['*'];
  return lbConfig || null;
}

/**
 * Check if domain has any XPath config
 */
function hasXPathConfig(basePath, domain) {
  return getXPathConfig(basePath, domain) != null;
}

/**
 * Save or update XPath config for a domain
 * @param {string} basePath - lbscraper root
 * @param {string} domain - e.g. "paxgambles.com"
 * @param {string} leaderboardName - e.g. "diceblox" or "default"
 * @param {Object} xpathConfig - { table, rows, rankCol, usernameCol, wagerCol, prizeCol }
 */
function saveXPathConfig(basePath, domain, leaderboardName, xpathConfig) {
  const dataDir = path.join(basePath, 'data');
  const configPath = path.join(dataDir, 'site-xpaths.json');
  fs.mkdirSync(dataDir, { recursive: true });

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {}
  }

  const normalized = domain.toLowerCase().replace(/^www\./, '');
  if (!config[normalized]) config[normalized] = {};
  config[normalized][leaderboardName || 'default'] = xpathConfig;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

module.exports = {
  getXPathConfig,
  hasXPathConfig,
  saveXPathConfig
};
