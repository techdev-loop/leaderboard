/**
 * Resource Blocking for Scraper (Scalable Scraper Architecture - PDF)
 *
 * Blocks images, fonts, media, and known trackers to reduce load time and bandwidth.
 * One of the biggest speed wins in scraping. Toggle via SCRAPER_BLOCK_RESOURCES (default: true).
 */

const { log } = require('./utils');

const BLOCK_RESOURCES_DEFAULT = true;

/** Resource types to block (images, fonts, media). XHR/Fetch are allowed for API data. */
const BLOCKED_RESOURCE_TYPES = ['image', 'font', 'media'];

/** URL patterns for known trackers/analytics (abort these too) */
const TRACKER_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /facebook\.net\/.*(?:fbevents|analytics)/i,
  /doubleclick\.net/i,
  /hotjar\.com/i,
  /segment\.(?:io|com)/i,
  /mixpanel\.com/i,
  /amplitude\.com/i,
  /fullstory\.com/i,
  /clarity\.ms/i,
  /analytics/i,
  /tracking/i,
  /pixel\.(?:php|gif)/i,
  /beacon/i,
  /telemetry/i
];

/**
 * Apply resource blocking to a Playwright page.
 * Call once per page after page is created (before goto).
 *
 * @param {import('playwright').Page} page - Playwright page
 * @returns {Function} - Unroute function to restore normal loading (call in finally if needed)
 */
function applyResourceBlocking(page) {
  const env = process.env.SCRAPER_BLOCK_RESOURCES;
  const enabled = env === undefined || env === '' ? BLOCK_RESOURCES_DEFAULT : env === 'true' || env === '1';

  if (!enabled) {
    log('PERF', 'Resource blocking disabled (SCRAPER_BLOCK_RESOURCES=false)');
    return () => {};
  }

  const handler = async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();

    if (BLOCKED_RESOURCE_TYPES.includes(resourceType)) {
      await route.abort();
      return;
    }

    if (resourceType === 'document' || resourceType === 'script') {
      await route.continue();
      return;
    }

    if (TRACKER_PATTERNS.some(p => p.test(url))) {
      await route.abort();
      return;
    }

    await route.continue();
  };

  page.route('**/*', handler);
  log('PERF', 'Resource blocking applied (images, fonts, media, trackers)');
  return () => {
    try {
      page.unroute('**/*', handler);
    } catch (e) {
      // ignore if already unruled
    }
  };
}

/**
 * Check if resource blocking is enabled (for logging/config)
 */
function isResourceBlockingEnabled() {
  const env = process.env.SCRAPER_BLOCK_RESOURCES;
  return env === undefined || env === '' ? BLOCK_RESOURCES_DEFAULT : env === 'true' || env === '1';
}

module.exports = {
  applyResourceBlocking,
  isResourceBlockingEnabled
};
