/**
 * Network Capture for Leaderboard Scraper
 * 
 * Handles API interception and response capture
 */

const { log } = require('./utils');

// ============================================================================
// NETWORK CAPTURE SETUP
// ============================================================================

/**
 * Setup network capture with intelligent leaderboard detection
 * Captures request headers for replay and categorizes responses
 * Also captures JavaScript files and text responses that may contain leaderboard data
 * 
 * @param {Page} page - Playwright page instance
 * @param {Object} options - Options for network capture
 * @returns {Object} - Captured data object with responses and metadata
 */
async function setupNetworkCapture(page, options = {}) {
  const { detectLeaderboardFn, isHistoricalFn } = options;
  
  const capturedData = {
    responses: [],
    previousResponses: [],
    allResponses: [],
    rawJsonResponses: [],
    jsResponses: [],        // JavaScript files that may contain leaderboard data
    textResponses: [],      // Text responses that may contain embedded data
    capturedUrls: [],
    capturedRequests: []
  };
  
  // Capture request headers for replay
  page.on('request', (request) => {
    const url = request.url();
    
    // Only capture API requests that look like leaderboard endpoints
    if (url.includes('leaderboard') || url.includes('ranking') || url.includes('leaders') || url.includes('api')) {
      const requestData = {
        url: url,
        method: request.method(),
        headers: request.headers(),
        timestamp: Date.now()
      };
      
      capturedData.capturedRequests.push(requestData);
      
      // Keep only last 50 requests to avoid memory issues
      if (capturedData.capturedRequests.length > 50) {
        capturedData.capturedRequests.shift();
      }
    }
  });
  
  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    const urlLower = url.toLowerCase();
    
    // Check if this is a leaderboard-related URL
    const isLeaderboardUrl = urlLower.includes('leaderboard') || 
                             urlLower.includes('ranking') || 
                             urlLower.includes('leaders') ||
                             urlLower.includes('api');
    
    // Find matching request to get headers
    const matchingRequest = capturedData.capturedRequests.find(r => r.url === url);
    
    try {
      // Handle JSON responses
      if (contentType.includes('application/json')) {
        const json = await response.json();
        
        // Track URL for pattern learning
        if (isLeaderboardUrl) {
          capturedData.capturedUrls.push(url);
        }
        
        capturedData.rawJsonResponses.push({
          url,
          timestamp: Date.now(),
          data: json,
          requestHeaders: matchingRequest?.headers || null,
          requestMethod: matchingRequest?.method || 'GET'
        });
        
        // Use provided detection function if available
        if (detectLeaderboardFn) {
          const leaderboardData = detectLeaderboardFn(json, url);
          
          if (leaderboardData) {
            const isPrevious = isHistoricalFn ? isHistoricalFn(url, json) : isHistoricalData(url, json);
            
            const responseData = {
              siteName: leaderboardData.siteName,
              url,
              entries: leaderboardData.entries,
              timestamp: Date.now(),
              isPrevious,
              confidence: leaderboardData.confidence,
              requestHeaders: matchingRequest?.headers || null
            };
            
            capturedData.allResponses.push(responseData);
            
            if (isPrevious) {
              capturedData.previousResponses.push(responseData);
              log('API', `Previous leaderboard captured: ${leaderboardData.siteName} (${leaderboardData.entries.length} entries)`);
            } else {
              capturedData.responses.push(responseData);
              log('API', `Current leaderboard captured: ${leaderboardData.siteName} (${leaderboardData.entries.length} entries)`);
            }
          }
        }
      }
      // Handle JavaScript responses that may contain embedded leaderboard data
      else if ((contentType.includes('javascript') || contentType.includes('text/javascript') || 
                urlLower.endsWith('.js')) && isLeaderboardUrl) {
        const text = await response.text();
        
        // Look for embedded JSON or leaderboard data in JS
        const extractedData = extractDataFromJavaScript(text, url);
        
        if (extractedData) {
          capturedData.jsResponses.push({
            url,
            timestamp: Date.now(),
            data: extractedData,
            rawText: text.substring(0, 5000), // Keep first 5k chars for debugging
            requestHeaders: matchingRequest?.headers || null
          });
          
          log('API', `JavaScript leaderboard data captured from: ${url.substring(0, 80)}...`);
        }
      }
      // Handle text/html responses that may contain embedded data
      else if ((contentType.includes('text/') || contentType.includes('html')) && isLeaderboardUrl) {
        const text = await response.text();
        
        // Only process if it looks like it contains data
        if (text.includes('leaderboard') || text.includes('ranking') || text.includes('wager')) {
          const extractedData = extractDataFromText(text, url);
          
          if (extractedData) {
            capturedData.textResponses.push({
              url,
              timestamp: Date.now(),
              data: extractedData,
              requestHeaders: matchingRequest?.headers || null
            });
            
            log('API', `Text/HTML leaderboard data captured from: ${url.substring(0, 80)}...`);
          }
        }
      }
    } catch (e) {
      // Parsing failed - ignore
    }
  });
  
  return capturedData;
}

// ============================================================================
// JAVASCRIPT/TEXT DATA EXTRACTION
// ============================================================================

/**
 * Extract leaderboard data from JavaScript content
 * Handles various formats:
 * - var leaderboard = [{...}]
 * - window.leaderboardData = {...}
 * - Embedded JSON in JS files
 * 
 * @param {string} jsContent - JavaScript file content
 * @param {string} url - Source URL for context
 * @returns {Object|null} - Extracted data or null
 */
function extractDataFromJavaScript(jsContent, url) {
  if (!jsContent || jsContent.length < 50) return null;
  
  const extractedData = {
    entries: [],
    prizes: {},
    source: 'javascript',
    url
  };
  
  try {
    // Pattern 1: var/let/const leaderboard = [...]
    const varArrayPatterns = [
      /(?:var|let|const)\s+(?:leaderboard|leaders|ranking|entries|users|players)\s*=\s*(\[[\s\S]*?\]);/gi,
      /(?:var|let|const)\s+\w*[Ll]eaderboard\w*\s*=\s*(\[[\s\S]*?\]);/gi
    ];
    
    for (const pattern of varArrayPatterns) {
      const matches = jsContent.matchAll(pattern);
      for (const match of matches) {
        try {
          const arr = JSON.parse(match[1].replace(/'/g, '"'));
          if (Array.isArray(arr) && arr.length > 0) {
            const entries = parseEntriesFromArray(arr);
            if (entries.length > extractedData.entries.length) {
              extractedData.entries = entries;
            }
          }
        } catch (e) { /* continue */ }
      }
    }
    
    // Pattern 2: window.leaderboardData = {...} or window.__INITIAL_STATE__ = {...}
    const windowPatterns = [
      /window\.(?:leaderboardData|__INITIAL_STATE__|__PRELOADED_STATE__|data)\s*=\s*(\{[\s\S]*?\});/gi,
      /window\[['"](?:leaderboard|data)['"]\]\s*=\s*(\{[\s\S]*?\});/gi
    ];
    
    for (const pattern of windowPatterns) {
      const matches = jsContent.matchAll(pattern);
      for (const match of matches) {
        try {
          const obj = JSON.parse(match[1].replace(/'/g, '"'));
          const entries = findEntriesInObject(obj);
          if (entries.length > extractedData.entries.length) {
            extractedData.entries = entries;
          }
        } catch (e) { /* continue */ }
      }
    }
    
    // Pattern 3: JSON.parse('...')
    const jsonParsePattern = /JSON\.parse\s*\(\s*['"](.+?)['"]\s*\)/gi;
    const jsonMatches = jsContent.matchAll(jsonParsePattern);
    for (const match of jsonMatches) {
      try {
        const decoded = match[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
        const obj = JSON.parse(decoded);
        if (Array.isArray(obj)) {
          const entries = parseEntriesFromArray(obj);
          if (entries.length > extractedData.entries.length) {
            extractedData.entries = entries;
          }
        }
      } catch (e) { /* continue */ }
    }
    
    // Pattern 4: Inline JSON objects/arrays
    const inlineJsonPattern = /(\[(?:\s*\{[^[\]]*?"(?:username|user|name)"[^[\]]*?\}(?:,\s*)?)+\])/gi;
    const inlineMatches = jsContent.matchAll(inlineJsonPattern);
    for (const match of inlineMatches) {
      try {
        const arr = JSON.parse(match[1]);
        if (Array.isArray(arr) && arr.length >= 3) {
          const entries = parseEntriesFromArray(arr);
          if (entries.length > extractedData.entries.length) {
            extractedData.entries = entries;
          }
        }
      } catch (e) { /* continue */ }
    }
    
  } catch (e) {
    // Extraction failed
  }
  
  return extractedData.entries.length > 0 ? extractedData : null;
}

/**
 * Extract leaderboard data from text/HTML content
 * @param {string} textContent - Text or HTML content
 * @param {string} url - Source URL
 * @returns {Object|null} - Extracted data or null
 */
function extractDataFromText(textContent, url) {
  if (!textContent || textContent.length < 50) return null;
  
  const extractedData = {
    entries: [],
    prizes: {},
    source: 'text',
    url
  };
  
  try {
    // Look for embedded JSON in script tags
    const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    const scriptMatches = textContent.matchAll(scriptPattern);
    
    for (const match of scriptMatches) {
      const scriptContent = match[1];
      if (scriptContent.includes('leaderboard') || scriptContent.includes('ranking')) {
        const jsData = extractDataFromJavaScript(scriptContent, url);
        if (jsData && jsData.entries.length > extractedData.entries.length) {
          extractedData.entries = jsData.entries;
        }
      }
    }
    
    // Look for JSON-LD or other embedded JSON
    const jsonLdPattern = /<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi;
    const jsonLdMatches = textContent.matchAll(jsonLdPattern);
    
    for (const match of jsonLdMatches) {
      try {
        const obj = JSON.parse(match[1]);
        const entries = findEntriesInObject(obj);
        if (entries.length > extractedData.entries.length) {
          extractedData.entries = entries;
        }
      } catch (e) { /* continue */ }
    }
    
  } catch (e) {
    // Extraction failed
  }
  
  return extractedData.entries.length > 0 ? extractedData : null;
}

/**
 * Parse entries from an array of objects
 * @param {Array} arr - Array of potential entry objects
 * @returns {Array} - Parsed entries
 */
function parseEntriesFromArray(arr) {
  const entries = [];
  
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== 'object' || item === null) continue;
    
    // Look for username field
    const username = item.username || item.user || item.name || item.userName || 
                     item.displayName || item.display_name || item.player || item.nick;
    
    if (!username || typeof username !== 'string') continue;
    
    // Look for wager/amount field
    const wager = parseFloat(item.wager || item.wagered || item.amount || item.total || 
                             item.totalWager || item.total_wager || item.points || item.score || 0);
    
    // Look for prize field
    const prize = parseFloat(item.prize || item.reward || item.payout || item.winnings || 0);
    
    // Look for rank field
    const rank = parseInt(item.rank || item.position || item.place || (i + 1), 10);
    
    entries.push({
      rank,
      username: username.substring(0, 50),
      wager: isNaN(wager) ? 0 : wager,
      prize: isNaN(prize) ? 0 : prize,
      source: 'js-api'
    });
  }
  
  return entries;
}

/**
 * Find entries array within a nested object
 * @param {Object} obj - Object to search
 * @returns {Array} - Found entries
 */
function findEntriesInObject(obj) {
  if (!obj || typeof obj !== 'object') return [];
  
  // Direct array
  if (Array.isArray(obj)) {
    return parseEntriesFromArray(obj);
  }
  
  // Check common keys
  const keysToCheck = ['leaderboard', 'leaders', 'entries', 'users', 'players', 
                       'ranking', 'data', 'results', 'items', 'list'];
  
  for (const key of keysToCheck) {
    if (obj[key] && Array.isArray(obj[key])) {
      const entries = parseEntriesFromArray(obj[key]);
      if (entries.length >= 3) return entries;
    }
  }
  
  // Recursive search (limited depth)
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (Array.isArray(obj[key])) {
        const entries = parseEntriesFromArray(obj[key]);
        if (entries.length >= 3) return entries;
      } else {
        const nested = findEntriesInObject(obj[key]);
        if (nested.length >= 3) return nested;
      }
    }
  }
  
  return [];
}

// ============================================================================
// HISTORICAL DATA DETECTION
// ============================================================================

/**
 * Check if URL or data indicates historical/previous leaderboard
 * @param {string} url - The API URL
 * @param {Object} json - The JSON response data
 * @returns {boolean} - True if historical data
 */
function isHistoricalData(url, json) {
  const urlLower = url.toLowerCase();
  const historicalIndicators = ['previous', 'past', 'history', 'archive', 'last', 'old', 'ended', 'completed'];
  
  if (historicalIndicators.some(ind => urlLower.includes(ind))) {
    return true;
  }
  
  if (typeof json === 'object' && json !== null) {
    const jsonStr = JSON.stringify(json).toLowerCase();
    if (jsonStr.includes('"ended":true') || jsonStr.includes('"completed":true') ||
        jsonStr.includes('"status":"ended"') || jsonStr.includes('"status":"completed"')) {
      return true;
    }
  }
  
  return false;
}

/**
 * Clear captured data for a fresh start (e.g., between sites)
 * @param {Object} networkData - The captured data object
 */
function clearNetworkData(networkData) {
  networkData.responses = [];
  networkData.previousResponses = [];
  networkData.allResponses = [];
  networkData.rawJsonResponses = [];
  networkData.jsResponses = [];
  networkData.textResponses = [];
  // Keep capturedUrls and capturedRequests for pattern learning
}

/**
 * Clear all network data including patterns
 * @param {Object} networkData - The captured data object
 */
function clearAllNetworkData(networkData) {
  networkData.responses = [];
  networkData.previousResponses = [];
  networkData.allResponses = [];
  networkData.rawJsonResponses = [];
  networkData.jsResponses = [];
  networkData.textResponses = [];
  networkData.capturedUrls = [];
  networkData.capturedRequests = [];
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  setupNetworkCapture,
  isHistoricalData,
  clearNetworkData,
  clearAllNetworkData,
  // JavaScript/Text extraction helpers
  extractDataFromJavaScript,
  extractDataFromText,
  parseEntriesFromArray,
  findEntriesInObject
};
