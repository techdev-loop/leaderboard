/**
 * Keyword Manager for Leaderboard Scraper
 * 
 * Maintains a persistent list of discovered keywords/providers per domain.
 * Keywords are continuously reused in API calls for maximum data extraction.
 * 
 * CRITICAL: Keywords scraped from sites MUST be reused in API calls
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./utils');

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_KEYWORDS_FILE = 'discovered-keywords.json';

// In-memory cache
let keywordCache = {};

// ============================================================================
// LOAD/SAVE
// ============================================================================

/**
 * Get the path to the keywords file
 * @param {string} basePath - Base path to lbscraper directory
 * @returns {string} - Path to keywords file
 */
function getKeywordsPath(basePath) {
  return path.join(basePath, 'data', DEFAULT_KEYWORDS_FILE);
}

/**
 * Load keywords from disk into memory
 * @param {string} basePath - Base path to lbscraper directory
 */
function loadKeywordCache(basePath) {
  const filePath = getKeywordsPath(basePath);
  
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Convert arrays back to Sets
      keywordCache = {};
      for (const [domain, keywords] of Object.entries(data.keywords || {})) {
        keywordCache[domain] = new Set(keywords);
      }
      
      log('KEYWORD', `Loaded ${Object.keys(keywordCache).length} domains from cache`);
    } else {
      keywordCache = {};
    }
  } catch (err) {
    log('ERR', `Failed to load keyword cache: ${err.message}`);
    keywordCache = {};
  }
}

/**
 * Save keywords from memory to disk
 * @param {string} basePath - Base path to lbscraper directory
 */
function saveKeywordCache(basePath) {
  const filePath = getKeywordsPath(basePath);
  const dirPath = path.dirname(filePath);
  
  // Ensure directory exists
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  
  try {
    // Convert Sets to arrays for JSON
    const data = {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      keywords: {}
    };
    
    for (const [domain, keywords] of Object.entries(keywordCache)) {
      data.keywords[domain] = Array.from(keywords);
    }
    
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    log('ERR', `Failed to save keyword cache: ${err.message}`);
  }
}

// ============================================================================
// KEYWORD MANAGEMENT
// ============================================================================

/**
 * Get all keywords for a domain
 * @param {string} domain - Domain name
 * @returns {Array} - Array of keywords
 */
function getKeywordsForDomain(domain) {
  const key = domain.toLowerCase().replace(/^www\./, '');
  return keywordCache[key] ? Array.from(keywordCache[key]) : [];
}

/**
 * Add new keywords for a domain
 * @param {string} domain - Domain name
 * @param {Array} newKeywords - Keywords to add
 * @returns {Array} - Updated list of all keywords for domain
 */
function addKeywordsForDomain(domain, newKeywords) {
  if (!newKeywords || !Array.isArray(newKeywords) || newKeywords.length === 0) {
    return getKeywordsForDomain(domain);
  }
  
  const key = domain.toLowerCase().replace(/^www\./, '');
  
  if (!keywordCache[key]) {
    keywordCache[key] = new Set();
  }
  
  let addedCount = 0;
  
  for (const kw of newKeywords) {
    if (!kw || typeof kw !== 'string') continue;
    
    const normalized = kw.toLowerCase().trim();
    
    // Skip too short or too long
    if (normalized.length < 2 || normalized.length > 50) continue;
    
    // Skip if it's a generic word
    const genericWords = ['leaderboard', 'leaderboards', 'home', 'about', 'contact', 
                          'login', 'register', 'faq', 'help', 'support', 'terms',
                          'privacy', 'affiliates', 'rewards', 'bonus', 'promotions'];
    if (genericWords.includes(normalized)) continue;
    
    if (!keywordCache[key].has(normalized)) {
      keywordCache[key].add(normalized);
      addedCount++;
    }
  }
  
  if (addedCount > 0) {
    log('KEYWORD', `Added ${addedCount} new keywords for ${domain}, total: ${keywordCache[key].size}`);
  }
  
  return Array.from(keywordCache[key]);
}

/**
 * Remove a keyword from a domain
 * @param {string} domain - Domain name
 * @param {string} keyword - Keyword to remove
 */
function removeKeywordFromDomain(domain, keyword) {
  const key = domain.toLowerCase().replace(/^www\./, '');
  
  if (keywordCache[key]) {
    keywordCache[key].delete(keyword.toLowerCase().trim());
  }
}

/**
 * Get count of keywords for a domain
 * @param {string} domain - Domain name
 * @returns {number} - Keyword count
 */
function getKeywordCount(domain) {
  const key = domain.toLowerCase().replace(/^www\./, '');
  return keywordCache[key] ? keywordCache[key].size : 0;
}

/**
 * Get all domains with their keyword counts
 * @returns {Object} - { domain: count }
 */
function getAllDomainStats() {
  const stats = {};
  for (const [domain, keywords] of Object.entries(keywordCache)) {
    stats[domain] = keywords.size;
  }
  return stats;
}

/**
 * Merge keywords from multiple sources
 * @param {string} domain - Domain name
 * @param {Object} sources - { source: [keywords] }
 * @returns {Array} - Merged keywords
 */
function mergeKeywordsFromSources(domain, sources) {
  const allKeywords = [];
  
  for (const [source, keywords] of Object.entries(sources)) {
    if (Array.isArray(keywords)) {
      allKeywords.push(...keywords);
      log('KEYWORD', `From ${source}: ${keywords.length} keywords`);
    }
  }
  
  return addKeywordsForDomain(domain, allKeywords);
}

// ============================================================================
// KEYWORD DISCOVERY FROM API RESPONSES
// ============================================================================

/**
 * Extract potential keywords/site names from API responses
 * @param {Array} apiResponses - Array of API response objects
 * @returns {Array} - Extracted keywords
 */
function extractKeywordsFromApiResponses(apiResponses) {
  const keywords = new Set();
  
  if (!apiResponses || !Array.isArray(apiResponses)) return [];
  
  for (const response of apiResponses) {
    const data = response.data || response;
    
    // Extract from common fields
    extractFromObject(data, keywords);
  }
  
  return Array.from(keywords);
}

/**
 * Recursively extract keywords from an object
 * @param {Object} obj - Object to extract from
 * @param {Set} keywords - Set to add keywords to
 * @param {number} depth - Current depth
 */
function extractFromObject(obj, keywords, depth = 0) {
  if (depth > 5 || !obj) return;
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractFromObject(item, keywords, depth + 1);
    }
    return;
  }
  
  if (typeof obj !== 'object') return;
  
  // Fields that often contain site/provider names
  const siteFields = ['site', 'siteName', 'site_name', 'provider', 'providerName',
                      'provider_name', 'casino', 'casinoProvider', 'casino_provider',
                      'platform', 'source', 'name', 'slug'];
  
  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    
    // Check if this field likely contains a site name
    if (siteFields.some(f => keyLower.includes(f.toLowerCase()))) {
      if (typeof value === 'string' && value.length >= 2 && value.length <= 50) {
        keywords.add(value.toLowerCase());
      }
    }
    
    // Recurse into nested objects
    if (typeof value === 'object') {
      extractFromObject(value, keywords, depth + 1);
    }
  }
}

// ============================================================================
// KEYWORD DISCOVERY FROM PAGE ELEMENTS (SWITCHERS)
// ============================================================================

/**
 * Discover keywords from page elements like switcher buttons, images, data attributes
 * @param {Page} page - Playwright page instance
 * @returns {Promise<Array>} - Discovered keywords
 */
async function discoverKeywordsFromSwitchers(page) {
  log('KEYWORD', 'Discovering keywords from page switcher elements...');
  
  const discovered = await page.evaluate(() => {
    const keywords = new Set();
    
    // Generic words to filter out
    const genericWords = new Set([
      'leaderboard', 'leaderboards', 'home', 'about', 'contact', 
      'login', 'register', 'faq', 'help', 'support', 'terms',
      'privacy', 'affiliates', 'rewards', 'bonus', 'promotions',
      'menu', 'nav', 'header', 'footer', 'logo', 'icon',
      'button', 'link', 'image', 'small', 'large', 'coin', 'currency',
      'previous', 'next', 'current', 'active', 'selected'
    ]);
    
    /**
     * Extract keyword from image filename
     */
    function extractFromFilename(src) {
      if (!src) return null;
      try {
        const url = new URL(src, window.location.origin);
        const pathname = url.pathname;
        const filename = pathname.split('/').pop();
        if (!filename) return null;
        
        const name = filename
          .replace(/\.(png|jpg|jpeg|svg|gif|webp)$/i, '')
          .replace(/[-_]?(logo|icon|small|large|coin|currency|brand|img|image)$/i, '')
          .replace(/^(logo|icon|brand)[-_]?/i, '')
          .toLowerCase();
        
        return name.length >= 3 && name.length <= 25 ? name : null;
      } catch (e) {
        return null;
      }
    }
    
    /**
     * Add keyword if valid
     */
    function addIfValid(kw) {
      if (!kw || typeof kw !== 'string') return;
      const cleaned = kw.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
      if (cleaned.length >= 3 && cleaned.length <= 25 && !genericWords.has(cleaned)) {
        keywords.add(cleaned);
      }
    }
    
    // 1. Extract from image paths and alt text
    document.querySelectorAll('img').forEach(img => {
      const filenameKw = extractFromFilename(img.src);
      if (filenameKw) addIfValid(filenameKw);
      
      const alt = (img.alt || '').trim();
      if (alt) {
        // Clean alt text: "CLASH.GG" -> "clashgg", "Chicken GG" -> "chickengg"
        const altClean = alt.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '');
        addIfValid(altClean);
      }
    });
    
    // 2. Extract from data attributes
    const dataAttrSelectors = [
      '[data-load-mode]', '[data-site]', '[data-provider]', 
      '[data-casino]', '[data-keyword]', '[data-name]'
    ];
    
    for (const selector of dataAttrSelectors) {
      document.querySelectorAll(selector).forEach(el => {
        const attrs = ['data-load-mode', 'data-site', 'data-provider', 'data-casino', 'data-keyword', 'data-name'];
        for (const attr of attrs) {
          const value = el.getAttribute(attr);
          if (value) addIfValid(value);
        }
      });
    }
    
    // 3. Extract from relative href links
    document.querySelectorAll('a[href]:not([href^="http"]):not([href^="#"]):not([href^="javascript"])').forEach(link => {
      const href = link.getAttribute('href') || '';
      const pathPart = href.replace(/^[./]+/, '').split('/')[0];
      if (pathPart) addIfValid(pathPart);
    });
    
    // 4. Extract from button text that looks like site names
    document.querySelectorAll('button, [role="button"]').forEach(btn => {
      const text = (btn.textContent || '').trim();
      // Only if text is short and looks like a site name
      if (text.length >= 3 && text.length <= 25 && !text.includes(' ') || 
          (text.includes('.') && text.length <= 15)) {
        const cleaned = text.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '');
        addIfValid(cleaned);
      }
    });
    
    // 5. Extract from tab/switcher containers
    const switcherContainers = document.querySelectorAll(
      '[class*="slider"], [class*="tabs"], [role="tablist"], [class*="switcher"]'
    );
    
    for (const container of switcherContainers) {
      // Get all buttons/tabs in the container
      const items = container.querySelectorAll('button, a, [role="tab"]');
      for (const item of items) {
        // Check images inside
        const img = item.querySelector('img');
        if (img) {
          const filenameKw = extractFromFilename(img.src);
          if (filenameKw) addIfValid(filenameKw);
          if (img.alt) addIfValid(img.alt.replace(/\s+/g, ''));
        }
        
        // Check text content
        const spans = item.querySelectorAll('span');
        for (const span of spans) {
          const text = (span.textContent || '').trim();
          if (text.length >= 3 && text.length <= 25) {
            addIfValid(text);
          }
        }
      }
    }
    
    return Array.from(keywords);
  });
  
  log('KEYWORD', `Discovered ${discovered.length} potential keywords from page elements`);
  if (discovered.length > 0) {
    log('KEYWORD', `Keywords: ${discovered.slice(0, 10).join(', ')}${discovered.length > 10 ? '...' : ''}`);
  }
  
  return discovered;
}

/**
 * Persist newly discovered keywords to keywords.txt file
 * @param {string} basePath - Base path to lbscraper directory
 * @param {Array} newKeywords - Keywords to add
 * @returns {number} - Count of keywords added
 */
function persistKeywordsToFile(basePath, newKeywords) {
  if (!newKeywords || newKeywords.length === 0) return 0;
  
  const keywordsPath = path.join(basePath, 'keywords.txt');
  
  try {
    // Read existing keywords
    let existingContent = '';
    if (fs.existsSync(keywordsPath)) {
      existingContent = fs.readFileSync(keywordsPath, 'utf8');
    }
    
    const existingKeywords = new Set(
      existingContent.split('\n')
        .map(line => line.trim().toLowerCase())
        .filter(line => line.length > 0)
    );
    
    // Filter to only truly new keywords
    const toAdd = newKeywords.filter(kw => {
      const normalized = kw.toLowerCase().trim();
      return normalized.length >= 3 && !existingKeywords.has(normalized);
    });
    
    if (toAdd.length > 0) {
      // Append new keywords
      const appendContent = '\n' + toAdd.join('\n');
      fs.appendFileSync(keywordsPath, appendContent);
      log('KEYWORD', `Added ${toAdd.length} new keywords to keywords.txt: ${toAdd.join(', ')}`);
      return toAdd.length;
    }
    
    return 0;
  } catch (err) {
    log('ERR', `Failed to persist keywords to file: ${err.message}`);
    return 0;
  }
}

/**
 * Load keywords from keywords.txt file
 * @param {string} basePath - Base path to lbscraper directory
 * @returns {Array} - Keywords from file
 */
function loadKeywordsFromFile(basePath) {
  const keywordsPath = path.join(basePath, 'keywords.txt');
  
  try {
    if (fs.existsSync(keywordsPath)) {
      const content = fs.readFileSync(keywordsPath, 'utf8');
      const keywords = content.split('\n')
        .map(line => line.trim().toLowerCase())
        .filter(line => line.length >= 2);
      
      return [...new Set(keywords)]; // Dedupe
    }
  } catch (err) {
    log('ERR', `Failed to load keywords from file: ${err.message}`);
  }
  
  return [];
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize keyword manager with base path
 * @param {string} basePath - Base path to lbscraper directory
 */
function initKeywordManager(basePath) {
  loadKeywordCache(basePath);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Initialization
  initKeywordManager,
  loadKeywordCache,
  saveKeywordCache,
  
  // Core operations
  getKeywordsForDomain,
  addKeywordsForDomain,
  removeKeywordFromDomain,
  getKeywordCount,
  getAllDomainStats,
  mergeKeywordsFromSources,
  
  // Discovery
  extractKeywordsFromApiResponses,
  discoverKeywordsFromSwitchers,
  
  // File persistence
  persistKeywordsToFile,
  loadKeywordsFromFile
};
