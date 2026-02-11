/**
 * Headed.gg site adapter
 *
 * Headed.gg shows multiple leaderboard tabs (gamba, packdraw, daddyskins, etc.)
 * but tab clicks often don't change the visible DOM; data is loaded via API
 * with a ?site= query param. This adapter fetches each leaderboard's data
 * directly from the API so we get 100% coverage without relying on tab clicks.
 *
 * No API key required - uses in-page fetch() for same-origin requests.
 */

const { log } = require('../utils');

const LEADERBOARD_TO_SITE_PARAM = {
  gamba: 'gamba.com',
  packdraw: 'packdraw.com',
  daddyskins: 'daddyskins.com',
  juice: 'juice.gg',
  acebet: 'acebet.com',
  csgobig: 'csgobig.com',
  rain: 'rain.gg',
  clash: 'clash.gg',
  bsite: 'bsite.com',
  menace: 'menace.com'
};

/**
 * Get site param for a leaderboard name (e.g. "packdraw" -> "packdraw.com")
 */
function getSiteParam(leaderboardName) {
  const key = (leaderboardName || '').toLowerCase().trim();
  return LEADERBOARD_TO_SITE_PARAM[key] || `${key}.com`;
}

/**
 * Parse a headed.gg API URL and return base URL + query params so we can substitute site=
 * @param {string} url - Full or relative URL, e.g. https://www.headed.gg/api/leaderboards?start=...&end=...&site=gamba.com
 * @param {string} [baseOrigin] - e.g. https://www.headed.gg (used if url is relative)
 * @returns {{ baseUrl: string, searchParams: URLSearchParams } | null}
 */
function parseHeadedGgApiUrl(url, baseOrigin) {
  if (!url || !url.includes('site=')) return null;
  try {
    const resolved = baseOrigin ? new URL(url, baseOrigin + '/') : new URL(url);
    if (!resolved.pathname.includes('leaderboard')) return null;
    return { baseUrl: resolved.origin + resolved.pathname, searchParams: resolved.searchParams };
  } catch (_) {
    return null;
  }
}

/**
 * Normalize headed.gg API response so extractor finds users (rank, username, wager, prize at top level).
 * @param {any} data - Raw API response
 * @returns {{ users: Array<{rank: number, username: string, wager: number, prize: number}> } | null}
 */
function normalizeHeadedGgResponse(data) {
  if (!data) return null;
  let arr = Array.isArray(data) ? data : data.users || data.entries || data.leaderboard || data.data || null;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const usernameKeys = ['username', 'user', 'name', 'displayName', 'display_name', 'playerName', 'nickname'];
  const wagerKeys = ['wager', 'wagered', 'totalWagered', 'total_wagered', 'amount', 'volume'];
  const prizeKeys = ['prize', 'reward', 'payout', 'winnings', 'prizeAmount'];
  const rankKeys = ['rank', 'position', 'place', 'pos'];
  const get = (obj, keys) => {
    for (const k of keys) {
      const v = obj[k] ?? obj[k.replace(/_/g, '')];
      if (v !== undefined && v !== null) return typeof v === 'object' && v !== null && (v.displayName ?? v.name ?? v.username) ? (v.displayName ?? v.name ?? v.username) : v;
    }
    return undefined;
  };
  const users = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    const username = get(item, usernameKeys);
    if (typeof username !== 'string' || username.length < 2) continue;
    let wager = 0;
    for (const k of wagerKeys) {
      const v = item[k];
      if (v !== undefined && v !== null) { wager = Number(v) || 0; break; }
    }
    let prize = 0;
    for (const k of prizeKeys) {
      const v = item[k];
      if (v !== undefined && v !== null) { prize = Number(v) || 0; break; }
    }
    let rank = i + 1;
    for (const k of rankKeys) {
      const v = item[k];
      if (typeof v === 'number' && v > 0) { rank = v; break; }
    }
    users.push({ rank, username: String(username).trim(), wager, prize });
  }
  if (users.length < 2) return null;
  return { users };
}

/**
 * Fetch one leaderboard's data from headed.gg API (in browser context, same-origin).
 * @param {import('playwright').Page} page
 * @param {string} apiUrl - Full URL with site= param
 * @returns {Promise<{ url: string, data: any } | null>}
 */
async function fetchHeadedGgLeaderboard(page, apiUrl) {
  try {
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { method: 'GET', credentials: 'same-origin' });
        if (!res.ok) return null;
        const data = await res.json();
        return { url, data };
      } catch (_) {
        return null;
      }
    }, apiUrl);
    if (!result || !result.data) return null;
    const normalized = normalizeHeadedGgResponse(result.data);
    if (normalized) result.data = normalized;
    return result;
  } catch (e) {
    log('HEADED-GG', `Fetch failed for ${apiUrl?.substring(0, 60)}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch all headed.gg leaderboards via API (no tab clicks).
 * Call this when domain is www.headed.gg and we have at least one captured API URL with site=.
 *
 * @param {import('playwright').Page} page - Playwright page (must be on headed.gg)
 * @param {Array<{ url: string, data: any }>} capturedResponses - rawJsonResponses from first load
 * @param {string[]} leaderboardNames - e.g. ['gamba', 'packdraw', 'daddyskins', ...]
 * @returns {Promise<Map<string, { url: string, data: any, timestamp: number }>>} Map of leaderboard name -> response
 */
async function fetchAllHeadedGgLeaderboards(page, capturedResponses, leaderboardNames) {
  const out = new Map();
  if (!capturedResponses || capturedResponses.length === 0 || !leaderboardNames || leaderboardNames.length === 0) {
    return out;
  }

  const sample = capturedResponses.find(r => r.url && r.url.includes('site='));
  if (!sample || !sample.url) {
    log('HEADED-GG', 'No API URL with site= param found in captured responses');
    return out;
  }

  let pageOrigin = 'https://www.headed.gg';
  try {
    pageOrigin = new URL(page.url()).origin;
  } catch (_) {}

  const baseUrl = pageOrigin + '/api/leaderboards';
  let start = '';
  let end = '';
  const urlStr = sample.url || '';
  const startMatch = urlStr.match(/start=([^&]+)/);
  const endMatch = urlStr.match(/end=([^&]+)/);
  if (startMatch) start = decodeURIComponent(startMatch[1]);
  if (endMatch) end = decodeURIComponent(endMatch[1]);
  if (!start || !end) {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + 14);
    start = now.toISOString().replace(/\.\d{3}Z$/, '+00:00');
    end = periodEnd.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  }

  log('HEADED-GG', `Fetching ${leaderboardNames.length} leaderboards via API (base: ${baseUrl})`);

  for (const name of leaderboardNames) {
    const siteParam = getSiteParam(name);
    const params = new URLSearchParams();
    params.set('site', siteParam);
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    const url = `${baseUrl}?${params.toString()}`;

    const response = await fetchHeadedGgLeaderboard(page, url);
    if (response && response.data != null) {
      out.set(name, {
        url: response.url,
        data: response.data,
        timestamp: Date.now()
      });
      const entryCount = Array.isArray(response.data) ? response.data.length : (response.data?.users?.length ?? response.data?.entries?.length ?? 0);
      log('HEADED-GG', `${name}: ${entryCount} entries from API`);
    } else {
      log('HEADED-GG', `${name}: no data from API`);
    }
    await page.waitForTimeout(200);
  }

  return out;
}

/**
 * Check if the current site is headed.gg (www.headed.gg or headed.gg)
 */
function isHeadedGg(domain) {
  if (!domain) return false;
  const d = domain.toLowerCase().replace(/^www\./, '');
  return d === 'headed.gg';
}

module.exports = {
  isHeadedGg,
  fetchAllHeadedGgLeaderboards,
  getSiteParam,
  parseHeadedGgApiUrl
};
