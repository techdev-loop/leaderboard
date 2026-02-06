/**
 * API Module for Leaderboard Scraper
 * 
 * Handles API pattern learning, direct requests, and data extraction from API responses
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const { log, parseNum, validateUsername } = require('./utils');

// ============================================================================
// API PATTERN LEARNING
// ============================================================================

/**
 * Load learned API patterns from disk
 * @param {string} patternsPath - Path to api-patterns.json
 * @param {number} expiryDays - Days until patterns expire
 * @returns {Object} - Loaded patterns by domain
 */
function loadApiPatterns(patternsPath, expiryDays = 7) {
  try {
    if (fs.existsSync(patternsPath)) {
      const data = JSON.parse(fs.readFileSync(patternsPath, 'utf8'));
      
      // Clean expired patterns
      const now = Date.now();
      const expiryMs = expiryDays * 24 * 60 * 60 * 1000;
      
      for (const domain in data) {
        data[domain] = data[domain].filter(p => (now - p.discoveredAt) < expiryMs);
        if (data[domain].length === 0) delete data[domain];
      }
      
      return data;
    }
  } catch (err) {
    log('ERR', `Failed to load API patterns: ${err.message}`);
  }
  return {};
}

/**
 * Save a learned API pattern
 * @param {string} patternsPath - Path to api-patterns.json
 * @param {string} domain - Domain name
 * @param {Object} pattern - Pattern to save
 * @param {number} maxPatternsPerDomain - Maximum patterns per domain
 */
function saveApiPattern(patternsPath, domain, pattern, maxPatternsPerDomain = 10) {
  try {
    const patterns = loadApiPatterns(patternsPath);
    
    if (!patterns[domain]) {
      patterns[domain] = [];
    }
    
    // Check if pattern already exists
    const exists = patterns[domain].some(p => p.urlTemplate === pattern.urlTemplate);
    if (exists) {
      // Update last used timestamp
      const existing = patterns[domain].find(p => p.urlTemplate === pattern.urlTemplate);
      existing.lastUsed = Date.now();
      existing.successCount = (existing.successCount || 0) + 1;
    } else {
      // Add new pattern
      patterns[domain].push({
        ...pattern,
        discoveredAt: Date.now(),
        lastUsed: Date.now(),
        successCount: 1
      });
      
      // Limit patterns per domain
      if (patterns[domain].length > maxPatternsPerDomain) {
        patterns[domain].sort((a, b) => b.successCount - a.successCount);
        patterns[domain] = patterns[domain].slice(0, maxPatternsPerDomain);
      }
    }
    
    fs.writeFileSync(patternsPath, JSON.stringify(patterns, null, 2));
    log('LEARN', `Saved API pattern for ${domain}: ${pattern.urlTemplate}`);
  } catch (err) {
    log('ERR', `Failed to save API pattern: ${err.message}`);
  }
}

/**
 * Get learned API patterns for a domain
 * @param {string} patternsPath - Path to api-patterns.json
 * @param {string} domain - Domain name
 * @returns {Array} - Array of patterns for domain
 */
function getApiPatternsForDomain(patternsPath, domain) {
  const patterns = loadApiPatterns(patternsPath);
  return patterns[domain] || [];
}

// ============================================================================
// SITE VALIDATION
// ============================================================================

/**
 * Extract site identifier from API URL
 * @param {string} url - The API URL
 * @returns {string|null} - Site name or null
 */
function extractSiteFromApiUrl(url) {
  const urlLower = url.toLowerCase();
  
  const patterns = [
    /[?&]casinoprovider=([a-zA-Z0-9_-]+)/i,
    /[?&]site=([a-zA-Z0-9_-]+)/i,
    /[?&]provider=([a-zA-Z0-9_-]+)/i,
    /[?&]platform=([a-zA-Z0-9_-]+)/i,
    /\/api\/([a-zA-Z0-9_-]+)\/leaderboard/i,
    /\/leaderboard[s]?\/([a-zA-Z0-9_-]+)/i,
    /\/([a-zA-Z0-9_-]+)\/leaderboard/i,
    /\/providers?\/([a-zA-Z0-9_-]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  
  return null;
}

/**
 * Extract site identifier from JSON response data
 * @param {Object} json - JSON response data
 * @returns {string|null} - Site name or null
 */
function extractSiteFromJsonData(json) {
  if (!json || typeof json !== 'object') return null;
  
  const siteFields = ['casinoProvider', 'casino_provider', 'site', 'siteName', 'site_name', 
                      'provider', 'platform', 'source', 'affiliate'];
  
  for (const field of siteFields) {
    if (json[field] && typeof json[field] === 'string') {
      return json[field].toLowerCase();
    }
    if (json.data && json.data[field] && typeof json.data[field] === 'string') {
      return json.data[field].toLowerCase();
    }
  }
  
  return null;
}

/**
 * Validate that an API response belongs to the target site
 * @param {Object} apiResponse - API response object with url and data
 * @param {string} targetSiteName - Expected site name
 * @returns {Object} - { valid: boolean, detectedSite: string|null, reason: string }
 */
function validateApiResponseForSite(apiResponse, targetSiteName) {
  const targetLower = targetSiteName.toLowerCase();
  
  // Extract site from URL
  const urlSite = extractSiteFromApiUrl(apiResponse.url);
  if (urlSite) {
    if (urlSite === targetLower || urlSite.includes(targetLower) || targetLower.includes(urlSite)) {
      return { valid: true, detectedSite: urlSite, reason: 'url_match' };
    } else {
      return { valid: false, detectedSite: urlSite, reason: `url_mismatch: expected ${targetLower}, got ${urlSite}` };
    }
  }
  
  // Extract site from JSON data
  const jsonSite = extractSiteFromJsonData(apiResponse.data);
  if (jsonSite) {
    if (jsonSite === targetLower || jsonSite.includes(targetLower) || targetLower.includes(jsonSite)) {
      return { valid: true, detectedSite: jsonSite, reason: 'json_match' };
    } else {
      return { valid: false, detectedSite: jsonSite, reason: `json_mismatch: expected ${targetLower}, got ${jsonSite}` };
    }
  }
  
  // No site identifier found - allow but flag as unverified
  return { valid: true, detectedSite: null, reason: 'no_site_identifier' };
}

// ============================================================================
// DIRECT HTTP REQUESTS
// ============================================================================

/**
 * Make a direct HTTP/HTTPS request
 * @param {string} url - URL to request
 * @param {Object} options - Request options
 * @returns {Promise<Object>} - Result with success, data, status
 */
function makeHttpRequest(url, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || 10000;
    const protocol = url.startsWith('https') ? https : http;
    
    const req = protocol.get(url, {
      headers: {
        'User-Agent': options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers
      },
      timeout
    }, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ success: true, data: json, status: res.statusCode });
        } catch (e) {
          resolve({ success: false, error: 'Invalid JSON', status: res.statusCode });
        }
      });
    });
    
    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout' });
    });
  });
}

/**
 * Make HTTP request using captured headers from a previous successful request
 * @param {string} url - URL to request
 * @param {Object} capturedHeaders - Headers from previous request
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} - Result with success, data, status
 */
function makeHttpRequestWithHeaders(url, capturedHeaders, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || 10000;
    const urlObj = new URL(url);
    const protocol = url.startsWith('https') ? https : http;
    
    // Build headers - use captured headers as base
    const headers = {
      ...capturedHeaders,
      'host': urlObj.host,
      ...options.headers
    };
    
    // Remove HTTP/2 pseudo-headers
    delete headers[':authority'];
    delete headers[':method'];
    delete headers[':path'];
    delete headers[':scheme'];
    
    log('DIRECT', `Making request with ${Object.keys(headers).length} headers`);
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: headers,
      timeout: timeout
    };
    
    const req = protocol.request(requestOptions, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ success: true, data: json, status: res.statusCode });
        } catch (e) {
          log('DIRECT', `Response not valid JSON (status: ${res.statusCode})`);
          resolve({ success: false, error: 'Invalid JSON', status: res.statusCode, rawData: data.substring(0, 200) });
        }
      });
    });
    
    req.on('error', (err) => {
      log('DIRECT', `Request error: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout' });
    });
    
    req.end();
  });
}

/**
 * Construct API URL from learned pattern and target site name
 * @param {Object} pattern - Pattern object with urlTemplate
 * @param {string} siteName - Site name to substitute
 * @returns {string} - Constructed URL
 */
function constructApiUrl(pattern, siteName) {
  let url = pattern.urlTemplate;
  
  url = url.replace(/\{SITE\}/gi, siteName);
  url = url.replace(/\{site\}/gi, siteName);
  url = url.replace(/\{SITENAME\}/gi, siteName);
  url = url.replace(/\{sitename\}/gi, siteName);
  url = url.replace(/casinoProvider=[^&]+/i, `casinoProvider=${siteName.toUpperCase()}`);
  
  // Use word boundary or start-of-param to avoid matching "casinoProvider" when we want "site" or "provider"
  url = url.replace(/([?&])site=([^&]+)/i, `$1site=${siteName}`);
  url = url.replace(/([?&])provider=([^&]+)/i, `$1provider=${siteName}`);
  
  // ALWAYS use expanded view to get ALL leaderboard entries (not just top 10)
  url = url.replace(/viewState=collapsed/gi, 'viewState=expanded');
  
  return url;
}

// ============================================================================
// LEADERBOARD DATE EXTRACTION
// ============================================================================

/**
 * Extract leaderboard date metadata from API response
 * Looks for month, year, startDate, endDate, type fields
 * @param {Object} apiResponse - API response data
 * @returns {Object} - Date metadata
 */
function extractLeaderboardDates(apiResponse) {
  if (!apiResponse || typeof apiResponse !== 'object') {
    return {
      month: null,
      year: null,
      type: null,
      startDate: null,
      endDate: null,
      leaderboardId: null,
      periodInfo: null
    };
  }
  
  // Handle nested data structures
  const data = apiResponse.data || apiResponse;
  
  // Common field name patterns for each date property
  const monthFields = ['month', 'periodMonth', 'period_month', 'currentMonth'];
  const yearFields = ['year', 'periodYear', 'period_year', 'currentYear'];
  const typeFields = ['type', 'leaderboardType', 'leaderboard_type', 'periodType', 'period_type'];
  const startFields = ['startDate', 'start_date', 'startAt', 'start_at', 'startsAt', 'starts_at', 'periodStart', 'period_start'];
  const endFields = ['endDate', 'end_date', 'endAt', 'end_at', 'endsAt', 'ends_at', 'periodEnd', 'period_end'];
  const idFields = ['id', 'leaderboardId', 'leaderboard_id', 'boardId', 'board_id', 'uuid'];
  
  /**
   * Find a value by trying multiple field names
   */
  function findValue(obj, fieldNames, parser = null) {
    if (!obj || typeof obj !== 'object') return null;
    
    for (const field of fieldNames) {
      if (obj[field] !== undefined && obj[field] !== null && obj[field] !== '') {
        const value = obj[field];
        if (parser) {
          try {
            return parser(value);
          } catch (e) {
            return value;
          }
        }
        return value;
      }
    }
    return null;
  }
  
  /**
   * Parse date strings and timestamps
   */
  function parseDate(value) {
    if (!value) return null;
    
    // Already a Date object
    if (value instanceof Date) {
      return value.toISOString();
    }
    
    // Numeric timestamp
    if (typeof value === 'number') {
      // Handle milliseconds vs seconds
      const ts = value > 9999999999 ? value : value * 1000;
      return new Date(ts).toISOString();
    }
    
    // String date
    if (typeof value === 'string') {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    
    return String(value);
  }
  
  // Extract values
  const month = findValue(data, monthFields, val => parseInt(val, 10));
  const year = findValue(data, yearFields, val => parseInt(val, 10));
  const type = findValue(data, typeFields);
  const startDate = findValue(data, startFields, parseDate);
  const endDate = findValue(data, endFields, parseDate);
  const leaderboardId = findValue(data, idFields);
  
  // Build period info string
  let periodInfo = null;
  if (type && month && year) {
    periodInfo = `${type} - ${month}/${year}`;
  } else if (month && year) {
    periodInfo = `${month}/${year}`;
  } else if (startDate && endDate) {
    periodInfo = `${startDate} to ${endDate}`;
  }
  
  const result = {
    month: month || null,
    year: year || null,
    type: type || null,
    startDate: startDate || null,
    endDate: endDate || null,
    leaderboardId: leaderboardId || null,
    periodInfo: periodInfo
  };
  
  // Log if we found date info
  if (month || year || startDate || endDate) {
    log('API', `Extracted date info: ${periodInfo || JSON.stringify({ month, year, type })}`);
  }
  
  return result;
}

/**
 * Extract date info from multiple API responses and merge
 * @param {Array} rawJsonResponses - Array of API responses
 * @returns {Object} - Merged date metadata
 */
function extractDatesFromResponses(rawJsonResponses) {
  if (!rawJsonResponses || !Array.isArray(rawJsonResponses)) {
    return extractLeaderboardDates(null);
  }
  
  // Priority: look for info endpoints first, then entries endpoints
  const priorityKeywords = ['info', 'metadata', 'details', 'current', 'active'];
  
  // Sort responses by priority
  const sorted = [...rawJsonResponses].sort((a, b) => {
    const aUrl = (a.url || '').toLowerCase();
    const bUrl = (b.url || '').toLowerCase();
    
    const aScore = priorityKeywords.filter(k => aUrl.includes(k)).length;
    const bScore = priorityKeywords.filter(k => bUrl.includes(k)).length;
    
    return bScore - aScore;
  });
  
  // Extract from each response, taking first non-null values
  const merged = {
    month: null,
    year: null,
    type: null,
    startDate: null,
    endDate: null,
    leaderboardId: null,
    periodInfo: null
  };
  
  for (const response of sorted) {
    const dates = extractLeaderboardDates(response.data || response);
    
    for (const key of Object.keys(merged)) {
      if (merged[key] === null && dates[key] !== null) {
        merged[key] = dates[key];
      }
    }
    
    // If we have all core fields, stop
    if (merged.month && merged.year) {
      break;
    }
  }
  
  return merged;
}

// ============================================================================
// LEADERBOARD DATA EXTRACTION FROM API
// ============================================================================

/**
 * Recursively find arrays in JSON that could be leaderboard data
 * @param {Object} obj - JSON object to search
 * @param {string} path - Current path (for debugging)
 * @param {Array} results - Accumulated results
 * @returns {Array} - Array of candidates
 */
function findLeaderboardArrays(obj, path = '', results = []) {
  if (Array.isArray(obj)) {
    if (obj.length >= 3 && obj.length <= 100) {
      const sampleItem = obj[0];
      if (typeof sampleItem === 'object' && sampleItem !== null) {
        results.push({ array: obj, path });
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.keys(obj)) {
      findLeaderboardArrays(obj[key], `${path}.${key}`, results);
    }
  }
  
  return results;
}

/**
 * Score how likely an array is to be leaderboard data
 * @param {Object} candidate - Candidate with array and path
 * @returns {number} - Score (higher is better)
 */
function scoreLeaderboardCandidate(candidate) {
  const { array } = candidate;
  if (!array || array.length === 0) return 0;
  
  const sampleItem = array[0];
  let score = 0;
  
  const usernameFields = ['username', 'user', 'name', 'player', 'displayName', 'display_name', 'nick', 'nickname', 'userName', 'playerName'];
  for (const field of usernameFields) {
    if (sampleItem[field] || (sampleItem.user && sampleItem.user[field])) {
      score += 2;
      break;
    }
  }
  
  const wagerFields = ['wagered', 'wager', 'wageredTotal', 'wager_total', 'amount', 'total', 'bet', 'bets', 'volume', 'played', 'totalWagered', 'total_wagered', 'betAmount', 'bet_amount'];
  for (const field of wagerFields) {
    if (sampleItem[field] !== undefined) {
      score += 2;
      break;
    }
  }
  
  const rankFields = ['rank', 'position', 'place', 'index', 'pos'];
  for (const field of rankFields) {
    if (sampleItem[field] !== undefined) {
      score += 2;
      break;
    }
  }
  
  const prizeFields = ['prize', 'reward', 'payout', 'bonus', 'winnings', 'won', 'prizeAmount', 'prize_amount'];
  for (const field of prizeFields) {
    if (sampleItem[field] !== undefined) {
      score += 1;
      break;
    }
  }
  
  if (array.length >= 5) score += 1;
  if (array.length >= 10) score += 1;
  
  const pathLower = candidate.path.toLowerCase();
  if (/leaderboard|ranking|leaders|top|winners|race|competition/.test(pathLower)) {
    score += 1;
  }
  
  return score;
}

/**
 * Extract standardized entries from a leaderboard array
 * @param {Object} candidate - Candidate with array property
 * @returns {Array} - Array of entry objects
 */
function extractEntriesFromArray(candidate) {
  const { array } = candidate;
  const entries = [];
  
  for (let i = 0; i < array.length; i++) {
    const item = array[i];
    
    let username = item.username || item.user || item.name || item.player ||
                   item.displayName || item.display_name || item.nick || item.nickname ||
                   item.userName || item.playerName;
    
    if (!username && item.user && typeof item.user === 'object') {
      username = item.user.username || item.user.name || item.user.displayName;
    }
    
    if (!username) continue;
    username = String(username);
    
    const validation = validateUsername(username);
    if (!validation.valid) continue;
    
    const wager = parseNum(
      item.wageredTotal || item.wagered || item.wager || item.wager_total ||
      item.totalWagered || item.total_wagered || item.amount || item.total ||
      item.bet || item.bets || item.volume || item.played || item.betAmount || 0
    );
    
    const prize = parseNum(
      item.prize || item.reward || item.payout || item.bonus ||
      item.winnings || item.won || item.prizeAmount || item.prize_amount || 0
    );
    
    let rank = parseInt(item.rank || item.position || item.place || item.pos || 0);
    if (!rank || rank <= 0) {
      rank = i + 1;
    }
    
    entries.push({
      rank,
      username,
      wager,
      prize,
      source: 'api'
    });
  }
  
  return entries;
}

/**
 * Extract prize table from an object that has prize1, prize2, etc. fields
 * @param {Object} obj - Object to extract from
 * @returns {Object} - Prize table mapping rank to prize amount
 */
function extractPrizeTableFromObject(obj) {
  const prizeTable = {};
  
  if (!obj || typeof obj !== 'object') return prizeTable;
  
  const keys = Object.keys(obj);
  
  for (const key of keys) {
    const keyLower = key.toLowerCase();
    
    const match = keyLower.match(/^(prize|reward|payout|bonus|winning)_?-?number?_?-?(\d+)$/i) ||
                  keyLower.match(/^(prize|reward|payout|bonus|winning)(\d+)$/i);
    
    if (match) {
      const position = parseInt(match[2]);
      const value = parseNum(obj[key]);
      if (position > 0 && position <= 100 && value > 0) {
        prizeTable[position] = value;
      }
    }
    
    // Handle prizes array
    if (keyLower === 'prizes' && Array.isArray(obj[key])) {
      obj[key].forEach((prize, idx) => {
        const pos = idx + 1;
        const value = parseNum(typeof prize === 'object' ? (prize.amount || prize.value || prize.prize) : prize);
        if (value > 0) {
          prizeTable[pos] = value;
        }
      });
    }
    
    // Handle rewards array
    if (keyLower === 'rewards' && Array.isArray(obj[key])) {
      obj[key].forEach((reward, idx) => {
        if (typeof reward === 'object' && (reward.position || reward.rank || reward.place)) {
          const pos = reward.position || reward.rank || reward.place;
          const value = parseNum(reward.amount || reward.value || reward.prize || reward.reward);
          if (value > 0) {
            prizeTable[pos] = value;
          }
        }
      });
    }
    
    // Handle additionalPrizes array with {amount, prizeNumber} structure (wrewards.com and similar)
    if ((keyLower === 'additionalprizes' || keyLower === 'additional_prizes' || keyLower === 'extraprizes') && Array.isArray(obj[key])) {
      obj[key].forEach((prize) => {
        if (typeof prize === 'object') {
          // Support multiple field name variations
          const pos = parseInt(prize.prizeNumber || prize.prize_number || prize.position || prize.rank || prize.place);
          const value = parseNum(prize.amount || prize.value || prize.prize || prize.reward);
          if (pos > 0 && pos <= 100 && value > 0) {
            if (!prizeTable[pos]) {
              prizeTable[pos] = value;
            }
          }
        }
      });
    }
  }
  
  return prizeTable;
}

/**
 * Extract site name from URL
 * @param {string} url - API URL
 * @returns {string} - Site name
 */
function extractSiteNameFromUrl(url) {
  const match = url.match(/\/api\/([a-zA-Z0-9-_]+)/i) ||
                url.match(/leaderboard[s]?\/([a-zA-Z0-9-_]+)/i) ||
                url.match(/\/([a-zA-Z0-9-_]+)\/leaderboard/i) ||
                url.match(/site[=:]([a-zA-Z0-9-_]+)/i) ||
                url.match(/casinoProvider=([a-zA-Z0-9-_]+)/i) ||
                url.match(/provider=([a-zA-Z0-9-_]+)/i);
  
  return match ? match[1].toLowerCase() : 'api';
}

/**
 * Merge entries with prizes from separate API responses
 * @param {Array} entries - Array of entry objects
 * @param {Object} prizeTable - Prize table mapping rank to prize
 * @returns {Array} - Entries with prizes merged
 */
function mergeEntriesWithPrizes(entries, prizeTable) {
  if (!prizeTable || Object.keys(prizeTable).length === 0) return entries;
  
  let mergedCount = 0;
  
  for (const entry of entries) {
    if (entry.prize === 0 || entry.prize === undefined) {
      const prize = prizeTable[entry.rank];
      if (prize) {
        entry.prize = prize;
        mergedCount++;
      }
    }
  }
  
  if (mergedCount > 0) {
    log('API', `Merged ${mergedCount} prizes from separate API response`);
  }
  
  return entries;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Pattern learning
  loadApiPatterns,
  saveApiPattern,
  getApiPatternsForDomain,
  
  // Site validation
  extractSiteFromApiUrl,
  extractSiteFromJsonData,
  validateApiResponseForSite,
  
  // HTTP requests
  makeHttpRequest,
  makeHttpRequestWithHeaders,
  constructApiUrl,
  
  // Date extraction
  extractLeaderboardDates,
  extractDatesFromResponses,
  
  // Data extraction
  findLeaderboardArrays,
  scoreLeaderboardCandidate,
  extractEntriesFromArray,
  extractPrizeTableFromObject,
  extractSiteNameFromUrl,
  mergeEntriesWithPrizes
};
