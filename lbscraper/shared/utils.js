/**
 * Shared Utilities for Leaderboard Scraper
 * 
 * Contains: logging, number parsing, username validation, file I/O helpers
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// LOGGING SYSTEM
// ============================================================================

const LOG_PREFIXES = {
  FP: '🔐 [FP]',
  API: '📡 [API]',
  GEO: '📐 [GEO]',
  DOM: '📄 [DOM]',
  VAL: '✅ [VAL]',
  TIMER: '⏱️ [TIMER]',
  CLICK: '🖱️ [CLICK]',
  ERR: '❌ [ERR]',
  DIRECT: '🎯 [DIRECT]',
  LEARN: '🧠 [LEARN]',
  BATCH: '📦 [BATCH]',
  DUP: '🔄 [DUP]',
  PROD: '🏭 [PROD]',
  NAV: '🧭 [NAV]',
  CONFIG: '⚙️ [CONFIG]',
  TEACHER: '🎓 [TEACHER]',
  COST: '💰 [COST]',
  PROFILE: '📋 [PROFILE]',
  BROWSER: '🖥️ [BROWSER]',
  '2CAPTCHA': '🔐 [2CAPTCHA]',
  CHALLENGE: '🛡️ [CHALLENGE]',
  CRAWLER: '🕷️ [CRAWLER]'
};

// Run ID for production logging - generated once per execution
let runId = null;
let productionEnabled = false;

/**
 * Initialize logging with run ID and production mode
 */
function initLogging(isProduction = false) {
  runId = Date.now().toString(36).toUpperCase();
  productionEnabled = isProduction;
  return runId;
}

/**
 * Get current run ID
 */
function getRunId() {
  if (!runId) {
    runId = Date.now().toString(36).toUpperCase();
  }
  return runId;
}

/**
 * Log a message with category prefix
 */
function log(category, message, data = null) {
  const prefix = LOG_PREFIXES[category] || `[${category}]`;
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const runPrefix = productionEnabled ? `[${getRunId()}] ` : '';
  
  if (data) {
    console.log(`${timestamp} ${runPrefix}${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${timestamp} ${runPrefix}${prefix} ${message}`);
  }
}

// ============================================================================
// NUMBER PARSING
// ============================================================================

/**
 * Parse number from string with multi-format support
 * Handles: $1,234.56, 1.234,56, 10k, 1.5m, etc.
 */
function parseNum(str) {
  if (!str && str !== 0) return 0;
  if (typeof str === 'number') return str;
  
  let s = str.toString().trim();
  
  // Remove currency symbols, emojis, and common tokens
  s = s.replace(/[$€£¥₹฿₿©®™◆♦💎🪙💰🎰🎲🏆⭐✨🔥💵💴💶💷🤑\s]/g, '');
  s = s.replace(/(coins?|credits?|points?|xp|gems?|tokens?|chips?|btc|eth|ltc)$/i, '');
  s = s.replace(/^(xp|coins?|credits?|points?|gems?|tokens?|chips?)\s*/i, '');
  s = s.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '');
  
  // Handle multiplier suffixes
  let mult = 1;
  if (/m$/i.test(s)) { mult = 1000000; s = s.replace(/m$/i, ''); }
  else if (/k$/i.test(s)) { mult = 1000; s = s.replace(/k$/i, ''); }
  else if (/b$/i.test(s)) { mult = 1000000000; s = s.replace(/b$/i, ''); }
  
  // Handle European vs US number formats
  if (s.includes(',') && s.includes('.')) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    
    if (lastDot > lastComma) {
      // US format: 1,234.56
      s = s.replace(/,/g, '');
    } else {
      // European format: 1.234,56
      s = s.replace(/\./g, '').replace(',', '.');
    }
  } else if (s.includes(',')) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      // Likely decimal: 1,50
      s = s.replace(',', '.');
    } else {
      // Likely thousands separator: 1,234
      s = s.replace(/,/g, '');
    }
  }
  
  const num = parseFloat(s);
  return isNaN(num) ? 0 : num * mult;
}

// ============================================================================
// USERNAME VALIDATION
// ============================================================================

// Single-word blacklist for UI elements
const UI_SINGLE_WORDS = new Set([
  'view', 'show', 'more', 'all', 'total', 'prize', 'pool', 'load',
  'other', 'leaders', 'leaderboard', 'leaderboards', 'top', 'rank', 'ranking',
  'winner', 'winners', 'see', 'expand', 'collapse', 'bonus',
  'bonuses', 'remaining', 'participants', 'wagered', 'reward',
  'rewards', 'tier', 'tiers', 'level', 'levels', 'next', 'previous',
  'status', 'active', 'inactive', 'terminal', 'shown', 'scan',
  'mission', 'progress', 'timer', 'live', 'ready', 'username',
  'days', 'hours', 'minutes', 'seconds', 'hrs', 'mins', 'secs', 'place', 'user', 'users', 'current',
  'ending', 'monthly', 'weekly', 'daily', 'bi-weekly', 'position',
  'amount', 'wager', 'available', 'claimed', 'unclaimed', 'ended',
  'tournament', 'tournaments', 'competition', 'competitions',
  'race', 'races', 'challenge', 'challenges', 'free',
  'login', 'register', 'signup', 'sign', 'browse', 'join',
  'vip', 'premium', 'exclusive', 'special', 'enter',
  'loading', 'refresh', 'update', 'error', 'failed', 'success',
  'info', 'information', 'details', 'about', 'rules', 'terms',
  'home', 'menu', 'settings', 'account', 'profile', 'dashboard',
  'deposit', 'withdraw', 'cashout', 'affiliate', 'referral',
  'code', 'codes', 'promo', 'promotion', 'promotions',
  'history', 'past', 'results', 'statistics', 'stats',
  'gamdom', 'packdraw', 'shuffle', 'stake', 'roobet', 'rollbit',
  'csgoroll', 'clash', 'hypedrop', 'csgopolygon',
  'raffles', 'raffle', 'shop', 'store', 'points', 'games', 'game',
  'slots', 'slot', 'casino', 'sports', 'news', 'blog', 'faq',
  'support', 'contact', 'help', 'chat', 'discord', 'twitter',
  'telegram', 'facebook', 'instagram', 'youtube', 'twitch',
  // Aggregate stats and timer UI
  'duration', 'volume', 'countdown', 'sum', 'average', 'median',
  'max', 'min', 'entries', 'players', 'highest', 'lowest',
  'high', 'low', 'timer', 'running', 'elapsed', 'distribution',
  // Prize pool / total row patterns
  'prizepool', 'totalwagered', 'totalprize', 'grandtotal', 'subtotal',
  // Community/membership stats (often in page headers)
  'members', 'member', 'subscribers', 'subscriber', 'followers', 'follower',
  'visitors', 'visitor', 'viewers', 'viewer', 'community', 'communities'
]);

// Phrase patterns that indicate UI text, not usernames
const UI_PHRASE_PATTERNS = [
  /^(view|show|see|load)\s+(all|more|history)/i,
  /^other\s+(leaders?|players?|winners?|participants?)/i,
  /^total\s+(prize|pool|wager|wagered|bonus|amount)/i,
  /^all\s+(bonus|bonuses|rewards?|prizes?|players?)/i,
  /^(top|all)\s+\d+/i,
  /^prize\s*pool$/i,
  /^(bi-?)?weekly|monthly|daily\s+(race|challenge|leaderboard)/i,
  /^\d+\s*(remaining|left|more|available)/i,
  /^(last|next)\s+(week|month|day|cycle|round)/i,
  /^(ends?|ending|started?|starting)\s+(in|at|on)/i,
  /^time\s+(left|remaining)/i,
  /^\d+[dhms]\s*\d*[dhms]?\s*\d*[dhms]?\s*\d*[dhms]?$/i,
  /^#\d+$/,
  /^\d+(st|nd|rd|th)?\s*(place|position)?$/i,
  /^rank[_\s]*\d+/i,
  /^level\s*\d+/i,
  /^on\s+[a-z]+\.?$/i,
  /^(play|bet|wager)\s+(on|at|with)/i,
  /^(join|enter)\s+(now|here|the)/i,
  /^view\s+history$/i,
  /^show\s+more$/i,
  /^leaderboard\s+ends?\s+in/i,
  /^gamdom\s+bonuses?$/i,
  /^packdraw\s+bonuses?$/i,
  /^shuffle\s+bonuses?$/i,
  /^.+\s+bonuses?$/i,
  /^points\s+shop$/i,
  /^vip\s+(club|rewards?|program)$/i,
  /^(live|new|hot)\s+(games?|slots?|drops?)$/i
];

// Roman numerals (often used as rank indicators)
const ROMAN_NUMERALS = new Set([
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'
]);

/**
 * Check if text is UI/interface text rather than a username
 */
function isUIText(text) {
  if (!text) return true;
  
  let normalized = text.toLowerCase().trim();
  
  // Strip trailing punctuation that might be captured with UI text
  // e.g., "Place:" should match "place" in the blacklist
  normalized = normalized.replace(/[:.,;!?]+$/, '');

  // Allow single alphanumeric characters as valid usernames (e.g., "r", "a", "5")
  // Some sites have users with single-character names
  if (normalized.length === 1 && /[a-zA-Z0-9]/.test(normalized)) return false;
  if (normalized.length < 2) return true;
  if (UI_SINGLE_WORDS.has(normalized)) return true;
  
  for (const pattern of UI_PHRASE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  
  const words = normalized.split(/\s+/);
  // Strip punctuation from each word before checking blacklist
  // NOTE: Require 3+ words all in blacklist to mark as UI text
  // Two-word combinations like "CODE Leaderboard" can be valid usernames
  // Single words are already checked above against UI_SINGLE_WORDS
  if (words.length >= 3 && words.length <= 4 && words.every(w => UI_SINGLE_WORDS.has(w.replace(/[:.,;!?]+$/, '')))) {
    return true;
  }
  
  if (ROMAN_NUMERALS.has(text.trim().toUpperCase())) return true;
  if (/^[$€£¥₹฿₿◆♦#@%]/.test(text.trim())) return true;
  if (/^[$€£¥]?\s*[\d,]+\.?\d*\s*(k|m|b)?$/i.test(normalized)) return true;
  
  return false;
}

/**
 * Validate username with confidence scoring
 * Returns { valid: boolean, confidence: number, reason: string }
 */
function validateUsername(text) {
  if (!text) {
    return { valid: false, confidence: 1.0, reason: 'empty' };
  }
  
  let trimmed = text.trim();
  trimmed = trimmed.replace(/[�\uFFFD]/g, '*');

  // Special case: [hidden] placeholder for users with no visible username on the site
  // These are legitimate leaderboard entries where the site only shows an avatar
  if (trimmed === '[hidden]') {
    return { valid: true, confidence: 0.60, reason: 'hidden_username_placeholder' };
  }

  // Allow single alphanumeric characters as valid usernames (e.g., "r", "a", "5")
  if (trimmed.length === 1) {
    if (/[a-zA-Z0-9]/.test(trimmed)) {
      // Single letter/digit is valid but lower confidence
      return { valid: true, confidence: 0.70, reason: 'single_character' };
    }
    return { valid: false, confidence: 0.95, reason: 'too_short' };
  }
  if (trimmed.length > 30) {
    return { valid: false, confidence: 0.9, reason: 'too_long' };
  }
  
  const hasAsterisks = trimmed.includes('*');
  if (!hasAsterisks && isUIText(trimmed)) {
    return { valid: false, confidence: 0.98, reason: 'ui_text' };
  }
  
  // Strip any bracket suffixes like "[1.5k HD LB]" that sites append to usernames
  // These are badges/labels, not part of the actual username
  let cleanedUsername = trimmed.replace(/\s*\[.*?\]\s*$/, '').trim();

  const wordCount = cleanedUsername.split(/\s+/).length;
  if (wordCount > 3) {
    return { valid: false, confidence: 0.85, reason: 'too_many_words' };
  }

  // Count both ASCII letters AND Unicode letters (for Cyrillic, Chinese, etc.)
  const asciiLetters = (cleanedUsername.match(/[a-zA-Z]/g) || []).length;
  const unicodeLetters = (cleanedUsername.match(/\p{L}/gu) || []).length;
  const letters = Math.max(asciiLetters, unicodeLetters);
  const asterisks = (cleanedUsername.match(/\*/g) || []).length;
  const numbers = (cleanedUsername.match(/\d/g) || []).length;
  const effectiveLetters = letters + asterisks;

  // Detect censored usernames - include single asterisk if it's a short name
  // Examples: "A*", "Jo**", "****ster"
  const isCensored = asterisks >= 2 || (asterisks >= 1 && cleanedUsername.length <= 4);

  if (isCensored) {
    if (letters >= 1) {
      const lowerCleaned = cleanedUsername.toLowerCase();
      const stillGarbage = lowerCleaned.includes('total') ||
                          lowerCleaned.includes('prize') ||
                          lowerCleaned.includes('pool') ||
                          lowerCleaned.includes('bonus');

      if (!stillGarbage) {
        return { valid: true, confidence: 0.90, reason: 'censored_username' };
      }
    }

    const hasValidPrefix = /^[✪★☆◆♦●○▪▫◇♢✦✧⭐🔥💎👑]/.test(cleanedUsername);
    if (hasValidPrefix && effectiveLetters >= 3) {
      return { valid: true, confidence: 0.85, reason: 'symbol_censored_username' };
    }

    if (asterisks >= 3 && cleanedUsername.length >= 4 && cleanedUsername.length <= 20) {
      return { valid: true, confidence: 0.70, reason: 'fully_censored_username' };
    }
  }

  if (letters < 1) {
    return { valid: false, confidence: 0.8, reason: 'no_letters' };
  }

  // Allow single-letter usernames if they have asterisks (heavily censored)
  // Examples: "A*", "J*", etc.
  if (letters < 2 && asterisks === 0) {
    return { valid: false, confidence: 0.8, reason: 'insufficient_letters' };
  }

  if (numbers > cleanedUsername.length * 0.7 && letters < 3) {
    return { valid: false, confidence: 0.75, reason: 'mostly_numbers' };
  }

  const emojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
  const emojiCount = (cleanedUsername.match(emojiPattern) || []).length;
  if (emojiCount > 2) {
    return { valid: false, confidence: 0.7, reason: 'emoji_heavy' };
  }

  const strippedForPattern = cleanedUsername.replace(/^[✪★☆◆♦●○▪▫◇♢✦✧⭐🔥💎👑]/u, '');

  if (/^[a-zA-Z0-9][a-zA-Z0-9._\-*]{1,29}$/.test(strippedForPattern)) {
    return { valid: true, confidence: 0.95, reason: 'standard_pattern' };
  }

  if (cleanedUsername !== strippedForPattern && /^[a-zA-Z0-9][a-zA-Z0-9._\-*]{0,28}$/.test(strippedForPattern)) {
    return { valid: true, confidence: 0.88, reason: 'symbol_prefixed_username' };
  }

  // Check for pure Unicode usernames (Cyrillic, Chinese, Arabic, etc.)
  if (/^[\p{L}\p{N}][\p{L}\p{N}._\-*\s]{0,29}$/u.test(strippedForPattern)) {
    return { valid: true, confidence: 0.85, reason: 'unicode_pattern' };
  }

  if (effectiveLetters >= 2 && wordCount <= 3) {
    return { valid: true, confidence: 0.6, reason: 'fallback_accepted' };
  }
  
  return { valid: false, confidence: 0.5, reason: 'pattern_mismatch' };
}

/**
 * Clean username by removing rank prefixes and extra whitespace
 */
function cleanUsername(str) {
  if (!str) return null;
  
  let clean = str.trim();
  clean = clean.replace(/^RANK[_\s]*\d+\s*/i, '');
  clean = clean.replace(/^#\d+\s*[-:.]?\s*/i, '');
  clean = clean.replace(/^\d+[.)\s]+/, '');
  clean = clean.replace(/^(1st|2nd|3rd|\d+th)\s*[-:.]?\s*/i, '');
  
  return clean.trim();
}

// ============================================================================
// FILE I/O HELPERS
// ============================================================================

const DEFAULT_KEYWORDS = [
  'diceblox', 'cases', 'casesgg', 'acebet', 'csbattle',
  'shuffle', 'stake', 'roobet', 'duelbits', 'gamdom',
  'rollbit', 'clash', 'clashgg', 'hypedrop', 'keydrop',
  'packdraw', 'csgoroll', 'skinport', 'farmskins', 'rainbet',
  'csgoempire', 'empire', 'rustyloot', 'bandit', 'howl', 'daddyskins',
  'chicken', 'csgoluck', 'datdrop', 'hellcase', 'skinhub',
  'skinrave', 'csgostake', 'lootbox'
];

/**
 * Load keywords from keywords.txt file
 */
function loadKeywords(keywordsPath) {
  try {
    if (fs.existsSync(keywordsPath)) {
      return fs.readFileSync(keywordsPath, 'utf8')
        .split('\n')
        .map(k => k.trim().toLowerCase())
        .filter(k => k);
    }
  } catch (err) {
    log('ERR', `Failed to load keywords: ${err.message}`);
  }
  fs.writeFileSync(keywordsPath, DEFAULT_KEYWORDS.join('\n'));
  return DEFAULT_KEYWORDS;
}

/**
 * Load leaderboard cache from JSON file
 */
function loadCache(cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  } catch (err) {
    log('ERR', `Failed to load cache: ${err.message}`);
  }
  return {};
}

/**
 * Save leaderboard cache to JSON file
 */
function saveCache(cachePath, cache) {
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

/**
 * Load websites from websites.txt file
 */
function loadWebsites(websitesPath) {
  try {
    if (!fs.existsSync(websitesPath)) {
      // Create template file
      const template = `# Leaderboard Scraper - Website List
# Add one URL per line. Lines starting with # are comments.
# Example:
# https://wrewards.com/leaderboards
# https://example.com/affiliate/leaderboard

`;
      fs.writeFileSync(websitesPath, template);
      log('BATCH', `Created template websites.txt - please add URLs and run again`);
      return [];
    }
    
    const content = fs.readFileSync(websitesPath, 'utf8');
    const urls = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    
    log('BATCH', `Loaded ${urls.length} URLs from websites.txt`);
    return urls;
  } catch (err) {
    log('ERR', `Failed to load websites.txt: ${err.message}`);
    return [];
  }
}

/**
 * Get direct leaderboard links for a specific domain from websites.txt
 * This extracts direct paths like /skinrave/, /daddyskins/ that can be used
 * for URL-based navigation instead of button clicking
 * 
 * @param {string} websitesPath - Path to websites.txt
 * @param {string} domain - Domain to find links for (e.g., "hustlehouse.bet")
 * @returns {Array} - Array of { name, url, path } objects
 */
function getDirectLinksForDomain(websitesPath, domain) {
  try {
    if (!fs.existsSync(websitesPath)) {
      return [];
    }
    
    const content = fs.readFileSync(websitesPath, 'utf8');
    const allUrls = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    
    // Normalize domain for matching
    const normalizedDomain = domain.replace(/^www\./, '').toLowerCase();
    
    const directLinks = [];
    
    for (const urlStr of allUrls) {
      try {
        const url = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`);
        const urlDomain = url.hostname.replace(/^www\./, '').toLowerCase();
        
        // Check if this URL is for our domain
        if (urlDomain === normalizedDomain) {
          const pathParts = url.pathname.split('/').filter(p => p);
          
          // If there's a path beyond the base (e.g., /skinrave/, /leaderboard/sitename)
          if (pathParts.length > 0) {
            // Extract the leaderboard/site name from the path
            // Common patterns: /skinrave/, /leaderboard/skinrave, /leaderboards/skinrave
            let siteName = null;
            
            if (pathParts.length === 1 && !['leaderboard', 'leaderboards', 'lb'].includes(pathParts[0].toLowerCase())) {
              // Direct path like /skinrave/
              siteName = pathParts[0];
            } else if (pathParts.length >= 2) {
              // Path like /leaderboard/skinrave
              const lastPart = pathParts[pathParts.length - 1];
              if (!['leaderboard', 'leaderboards', 'lb'].includes(lastPart.toLowerCase())) {
                siteName = lastPart;
              }
            }
            
            if (siteName) {
              directLinks.push({
                name: siteName.toLowerCase(),
                url: url.href,
                path: url.pathname
              });
            }
          }
        }
      } catch (e) {
        // Skip invalid URLs
      }
    }
    
    if (directLinks.length > 0) {
      log('NAV', `Found ${directLinks.length} direct leaderboard links for ${domain} in websites.txt`);
    }
    
    return directLinks;
  } catch (err) {
    log('ERR', `Failed to get direct links for domain: ${err.message}`);
    return [];
  }
}

/**
 * Save failed scrapes for later retry
 */
function saveFailedScrape(failedScrapesPath, url, error, siteName = null) {
  try {
    let failed = [];
    if (fs.existsSync(failedScrapesPath)) {
      failed = JSON.parse(fs.readFileSync(failedScrapesPath, 'utf8'));
    }
    
    failed.push({
      url,
      siteName,
      error,
      timestamp: new Date().toISOString(),
      runId: getRunId()
    });
    
    fs.writeFileSync(failedScrapesPath, JSON.stringify(failed, null, 2));
  } catch (err) {
    log('ERR', `Failed to save failed scrape: ${err.message}`);
  }
}

// ============================================================================
// KNOWN LEADERBOARD LINKS
// ============================================================================

/**
 * Load known leaderboard links from JSON file
 * @param {string} knownLinksPath - Path to known-leaderboard-links.json
 * @returns {Object} - Known links data with sites object
 */
function loadKnownLinks(knownLinksPath) {
  try {
    if (!fs.existsSync(knownLinksPath)) {
      log('NAV', 'No known-leaderboard-links.json found, will use runtime discovery');
      return { sites: {} };
    }
    
    const content = fs.readFileSync(knownLinksPath, 'utf8');
    const data = JSON.parse(content);
    
    if (!data.sites || typeof data.sites !== 'object') {
      log('ERR', 'Invalid known-leaderboard-links.json format');
      return { sites: {} };
    }
    
    // Count active leaderboards
    let totalActive = 0;
    for (const domain of Object.keys(data.sites)) {
      const site = data.sites[domain];
      if (site.leaderboards) {
        totalActive += site.leaderboards.filter(lb => lb.active !== false).length;
      }
    }
    
    log('NAV', `Loaded ${Object.keys(data.sites).length} sites with ${totalActive} active leaderboards from known links`);
    return data;
  } catch (err) {
    log('ERR', `Failed to load known links: ${err.message}`);
    return { sites: {} };
  }
}

/**
 * Get known links for a specific domain
 * @param {Object} knownLinksData - Full known links data
 * @param {string} domain - Domain to get links for
 * @returns {Object|null} - Site data or null if not found
 */
function getKnownLinksForDomain(knownLinksData, domain) {
  if (!knownLinksData || !knownLinksData.sites) {
    return null;
  }
  
  // Normalize domain (remove www, convert to lowercase)
  const normalizeDomain = d => d.replace(/^www\./, '').toLowerCase();
  const normalizedTarget = normalizeDomain(domain);
  
  // Find matching domain
  for (const siteDomain of Object.keys(knownLinksData.sites)) {
    if (normalizeDomain(siteDomain) === normalizedTarget) {
      return knownLinksData.sites[siteDomain];
    }
  }
  
  return null;
}

/**
 * Update a leaderboard's status in known links file
 * @param {string} knownLinksPath - Path to known-leaderboard-links.json
 * @param {string} domain - Domain of the site
 * @param {string} leaderboardName - Name of the leaderboard
 * @param {Object} updates - Fields to update (active, lastVerified, etc.)
 */
function updateKnownLink(knownLinksPath, domain, leaderboardName, updates) {
  try {
    const data = loadKnownLinks(knownLinksPath);
    const siteData = getKnownLinksForDomain(data, domain);
    
    if (!siteData || !siteData.leaderboards) {
      return false;
    }
    
    const lb = siteData.leaderboards.find(l => 
      l.name.toLowerCase() === leaderboardName.toLowerCase()
    );
    
    if (lb) {
      Object.assign(lb, updates);
      data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(knownLinksPath, JSON.stringify(data, null, 2));
      return true;
    }
    
    return false;
  } catch (err) {
    log('ERR', `Failed to update known link: ${err.message}`);
    return false;
  }
}

/**
 * Save inactive links to separate tracking file
 * @param {string} inactiveLinksPath - Path to inactive-links.json
 * @param {string} domain - Domain of the site
 * @param {string} url - URL that failed
 * @param {string} reason - Reason for marking inactive
 */
function saveInactiveLink(inactiveLinksPath, domain, url, reason) {
  try {
    let data = {};
    if (fs.existsSync(inactiveLinksPath)) {
      data = JSON.parse(fs.readFileSync(inactiveLinksPath, 'utf8'));
    }
    
    if (!data[domain]) {
      data[domain] = [];
    }
    
    // Check if already tracked
    const existing = data[domain].find(l => l.url === url);
    if (existing) {
      existing.lastChecked = new Date().toISOString();
      existing.failCount = (existing.failCount || 0) + 1;
    } else {
      data[domain].push({
        url,
        reason,
        firstFailed: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        failCount: 1
      });
    }
    
    fs.writeFileSync(inactiveLinksPath, JSON.stringify(data, null, 2));
  } catch (err) {
    log('ERR', `Failed to save inactive link: ${err.message}`);
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Logging
  LOG_PREFIXES,
  log,
  initLogging,
  getRunId,
  
  // Number parsing
  parseNum,
  
  // Username validation
  UI_SINGLE_WORDS,
  UI_PHRASE_PATTERNS,
  ROMAN_NUMERALS,
  isUIText,
  validateUsername,
  cleanUsername,
  
  // File I/O
  DEFAULT_KEYWORDS,
  loadKeywords,
  loadCache,
  saveCache,
  loadWebsites,
  getDirectLinksForDomain,
  saveFailedScrape,
  
  // Known leaderboard links
  loadKnownLinks,
  getKnownLinksForDomain,
  updateKnownLink,
  saveInactiveLink
};
