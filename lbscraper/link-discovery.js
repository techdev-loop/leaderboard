/**
 * Link Discovery v1.1 - Parallel Edition
 *
 * Discovers leaderboard links from websites in websites.txt.
 * Outputs categorized links for manual curation of leaderboard URLs.
 * Supports parallel discovery with multiple browser instances.
 *
 * Usage:
 *   node link-discovery.js                      # Discover links from all sites (parallel)
 *   node link-discovery.js <url>                # Discover from single site
 *   node link-discovery.js --show <domain>      # Show discovered links for domain
 *   node link-discovery.js --depth 3            # Set max crawl depth (default: 3)
 *   node link-discovery.js --max-pages 50       # Set max pages per site (default: 50)
 *   node link-discovery.js --workers 4          # Set number of parallel browsers (default: 3)
 *
 * Note: Each browser uses ~200-400MB RAM. Recommended: 2-4 workers.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Apply stealth plugin
chromium.use(stealth());

// Import shared utilities
const { log, initLogging, loadWebsites, loadKeywords } = require('./shared/utils');
const { initChallengeBypass, navigateWithBypass } = require('./shared/page-navigation');

// Import and initialize challenge bypass module
let challengeBypass;
try {
  challengeBypass = require('./challenge-bypass');
  initChallengeBypass(challengeBypass);
} catch (e) {
  log('CRAWLER', 'Challenge bypass module not found, continuing without it');
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  maxDepth: 3,              // Max link depth to follow
  maxPagesPerSite: 50,      // Max pages to crawl per site
  requestDelayMs: 1000,     // Delay between requests (slightly faster)
  pageTimeoutMs: 30000,     // Page load timeout
  respectRobotsTxt: false,  // Whether to respect robots.txt
  
  // Early stop: stop crawling when no new leaderboard links found for X pages
  maxPagesWithoutNewLeaderboard: 5,
  
  // Parallel crawling: number of browser instances to run simultaneously
  // Recommended: 2-4 depending on your PC's RAM (each browser uses ~200-400MB)
  parallelWorkers: 6,
  
  // File paths
  outputFile: path.join(__dirname, 'data', 'all-discovered-links.json'),
  knownLinksFile: path.join(__dirname, 'data', 'known-leaderboard-links.json'),
  inactiveLinksFile: path.join(__dirname, 'data', 'inactive-links.json'),
  creatorProfilesFile: path.join(__dirname, 'data', 'creator-profiles.json'),
  
  // Skip patterns for CRAWLING (don't navigate to these)
  skipPatterns: [
    /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|mp4|mp3|webp)$/i,
    /^mailto:/i,
    /^tel:/i,
    /^javascript:/i,
    /^#/,
    /login/i,
    /logout/i,
    /signup/i,
    /register/i,
    /password/i,
    /account/i,
    /admin/i,
    /api\//i,
    /cdn\./i,
    /static\./i,
    /fonts\./i,
    /googletagmanager/i,
    /google-analytics/i
  ],
  
  // Social media patterns for extraction (NOT for skip, we WANT these)
  socialPatterns: {
    kick: /^https?:\/\/(www\.)?kick\.com\/([a-zA-Z0-9_-]+)\/?$/i,
    twitter: /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/([a-zA-Z0-9_]+)\/?$/i,
    youtube: /^https?:\/\/(www\.)?youtube\.com\/(@[a-zA-Z0-9_-]+|c\/[a-zA-Z0-9_-]+|channel\/[a-zA-Z0-9_-]+)\/?$/i,
    discord: /^https?:\/\/(discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_-]+)\/?$/i
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if URL is a leaderboard URL (only save these)
 * Matches: /leaderboard, /leaderboards, /leaderboard/{anything}, /leaderboards/{anything}
 */
function isLeaderboardUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    // Match /leaderboard or /leaderboards with optional trailing path
    return /^\/(leaderboards?)(\/.*)?$/i.test(pathname);
  } catch (err) {
    return false;
  }
}

/**
 * Extract social media links from a list of URLs
 */
function extractSocialLinks(urls) {
  const socials = {
    kick: null,
    twitter: null,
    youtube: null,
    discord: null
  };
  
  for (const url of urls) {
    if (!url) continue;
    
    // Kick
    if (!socials.kick && CONFIG.socialPatterns.kick.test(url)) {
      socials.kick = url;
    }
    
    // Twitter / X
    if (!socials.twitter && CONFIG.socialPatterns.twitter.test(url)) {
      socials.twitter = url;
    }
    
    // YouTube
    if (!socials.youtube && CONFIG.socialPatterns.youtube.test(url)) {
      socials.youtube = url;
    }
    
    // Discord
    if (!socials.discord && CONFIG.socialPatterns.discord.test(url)) {
      socials.discord = url;
    }
  }
  
  return socials;
}

/**
 * Extract username from a social media URL
 */
function extractUsername(url, platform) {
  if (!url) return null;
  
  try {
    switch (platform) {
      case 'kick': {
        const match = url.match(/kick\.com\/([a-zA-Z0-9_-]+)/i);
        return match ? match[1].toLowerCase() : null;
      }
      case 'twitter': {
        const match = url.match(/(twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/i);
        return match ? match[2].toLowerCase() : null;
      }
      case 'youtube': {
        const match = url.match(/youtube\.com\/(@([a-zA-Z0-9_-]+)|c\/([a-zA-Z0-9_-]+)|channel\/([a-zA-Z0-9_-]+))/i);
        if (match) {
          return (match[2] || match[3] || match[4] || '').toLowerCase();
        }
        return null;
      }
      case 'discord': {
        const match = url.match(/(discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9_-]+)/i);
        return match ? match[2] : null;
      }
      default:
        return null;
    }
  } catch (err) {
    return null;
  }
}

/**
 * Determine the creator username with priority: Kick > Twitter > domain
 */
function determineCreatorUsername(socials, domain) {
  let username = null;
  let source = null;
  let needsReview = false;
  
  // Priority 1: Kick username
  if (socials.kick) {
    username = extractUsername(socials.kick, 'kick');
    source = 'kick';
  }
  
  // Priority 2: Twitter/X username
  if (!username && socials.twitter) {
    username = extractUsername(socials.twitter, 'twitter');
    source = 'twitter';
  }
  
  // Priority 3: Website domain (flagged for review)
  if (!username) {
    // Remove www. and TLD
    username = domain.replace(/^www\./i, '').split('.')[0].toLowerCase();
    source = 'domain';
    needsReview = true;
  }
  
  return { username, source, needsReview };
}

// ============================================================================
// CRAWLER CLASS
// ============================================================================

class LinkCrawler {
  constructor(options = {}) {
    this.maxDepth = options.maxDepth || CONFIG.maxDepth;
    this.maxPages = options.maxPagesPerSite || CONFIG.maxPagesPerSite;
    this.delayMs = options.requestDelayMs || CONFIG.requestDelayMs;
    this.keywords = [];
    this.browser = null;
    this.context = null;
    this.page = null;
  }
  
  /**
   * Initialize browser and load keywords
   */
  async init() {
    initLogging();
    log('CRAWLER', 'Initializing Link Crawler...');
    
    // Load keywords for categorization
    try {
      this.keywords = loadKeywords(path.join(__dirname, 'keywords.txt'));
      log('CRAWLER', `Loaded ${this.keywords.length} keywords for categorization`);
    } catch (err) {
      log('CRAWLER', 'No keywords.txt found, continuing without keyword matching');
      this.keywords = [];
    }
    
    // Launch browser
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    this.context = await this.browser.newContext({
      userAgent: this.getRandomUserAgent(),
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    this.page = await this.context.newPage();
    
    log('CRAWLER', 'Browser initialized');
  }
  
  /**
   * Get random user agent for polite crawling
   */
  getRandomUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
  
  /**
   * Crawl a single website and discover all links
   * @param {string} startUrl - URL to start crawling from
   * @returns {Object} - Discovered links with metadata
   */
  async crawlSite(startUrl) {
    const domain = new URL(startUrl).hostname;
    log('CRAWLER', `Starting crawl of ${domain}`);
    
    const visited = new Set();
    const leaderboardLinks = new Map(); // Only leaderboard URLs
    const allExternalUrls = new Set(); // Collect social media URLs
    
    // Normalize start URL and add to queue
    const normalizedStartUrl = this.normalizeUrl(startUrl);
    const queue = [{ url: startUrl, normalizedUrl: normalizedStartUrl, depth: 0, foundOn: null }];
    let pagesProcessed = 0;
    
    // Track consecutive pages without new leaderboard links (for early stop)
    let pagesWithoutNewLeaderboard = 0;
    const maxPagesWithoutNew = CONFIG.maxPagesWithoutNewLeaderboard || 5;
    
    while (queue.length > 0 && pagesProcessed < this.maxPages) {
      const { url, normalizedUrl, depth, foundOn } = queue.shift();
      
      // Skip if already visited (using normalized URL) or too deep
      if (visited.has(normalizedUrl) || depth > this.maxDepth) {
        continue;
      }
      
      // Skip if URL matches skip patterns
      if (this.shouldSkipUrl(url)) {
        continue;
      }
      
      // Skip if different domain
      try {
        const urlDomain = new URL(url).hostname;
        if (!this.isSameDomain(domain, urlDomain)) {
          continue;
        }
      } catch (err) {
        continue;
      }
      
      visited.add(normalizedUrl);
      pagesProcessed++;
      
      log('CRAWLER', `[${pagesProcessed}/${this.maxPages}] Crawling: ${url} (depth ${depth})`);
      
      try {
        // Navigate to page
        const navResult = await navigateWithBypass(this.page, url, {
          maxRetries: 2,
          timeoutMs: CONFIG.pageTimeoutMs
        });
        
        if (!navResult.success) {
          log('CRAWLER', `Failed to load: ${url}`);
          continue;
        }
        
        // Wait for page to settle
        await this.page.waitForTimeout(1000);
        
        // Extract links from page
        const pageLinks = await this.extractLinks();
        
        // Track if we find any new leaderboard links on this page
        let foundNewLeaderboardOnThisPage = false;
        
        // Process each link
        for (const link of pageLinks) {
          const absoluteUrl = this.resolveUrl(url, link.href);
          if (!absoluteUrl) continue;
          
          // Check if external URL (for social media extraction)
          try {
            const linkDomain = new URL(absoluteUrl).hostname;
            if (!this.isSameDomain(domain, linkDomain)) {
              allExternalUrls.add(absoluteUrl);
              continue; // Don't crawl external URLs, just collect them
            }
          } catch (err) {
            continue;
          }
          
          // Normalize URL for deduplication
          const linkNormalizedUrl = this.normalizeUrl(absoluteUrl);
          
          // Only save leaderboard URLs
          if (isLeaderboardUrl(absoluteUrl) && !leaderboardLinks.has(linkNormalizedUrl)) {
            const matchedKeywords = this.findMatchingKeywords(absoluteUrl, link.text);
            
            leaderboardLinks.set(linkNormalizedUrl, {
              url: absoluteUrl,
              foundOn: url,
              anchorText: link.text?.substring(0, 100) || '',
              matchedKeywords: matchedKeywords,
              depth: depth + 1
            });
            
            log('CRAWLER', `Found leaderboard URL: ${absoluteUrl}`);
            foundNewLeaderboardOnThisPage = true;
          }
          
          // Add to queue for further crawling if not at max depth
          if (depth + 1 <= this.maxDepth && !this.shouldSkipUrl(absoluteUrl) && !visited.has(linkNormalizedUrl)) {
            queue.push({
              url: absoluteUrl,
              normalizedUrl: linkNormalizedUrl,
              depth: depth + 1,
              foundOn: url
            });
          }
        }
        
        // Update early stop tracking
        if (foundNewLeaderboardOnThisPage) {
          pagesWithoutNewLeaderboard = 0;
        } else {
          pagesWithoutNewLeaderboard++;
        }
        
        // Early stop: if we've found leaderboard links but haven't found new ones for a while
        if (leaderboardLinks.size > 0 && pagesWithoutNewLeaderboard >= maxPagesWithoutNew) {
          log('CRAWLER', `No new leaderboard links for ${maxPagesWithoutNew} pages, stopping early for ${domain}`);
          break;
        }
        
        // Polite crawling delay (slightly reduced for faster operation)
        await this.page.waitForTimeout(this.delayMs + Math.random() * 300);
        
      } catch (err) {
        log('CRAWLER', `Error crawling ${url}: ${err.message}`);
      }
    }
    
    // Extract social media links from external URLs
    const socials = extractSocialLinks(Array.from(allExternalUrls));
    const { username, source, needsReview } = determineCreatorUsername(socials, domain);
    
    // Log social media findings
    const socialCount = Object.values(socials).filter(v => v).length;
    if (socialCount > 0) {
      log('CRAWLER', `Found ${socialCount} social media links for ${domain}`);
      log('CRAWLER', `Creator username: ${username} (source: ${source}${needsReview ? ', NEEDS REVIEW' : ''})`);
    }
    
    // Convert to array
    const links = Array.from(leaderboardLinks.values());
    
    log('CRAWLER', `Crawl complete for ${domain}: ${links.length} leaderboard links from ${pagesProcessed} pages`);
    
    return {
      domain: domain,
      crawledAt: new Date().toISOString(),
      pagesProcessed: pagesProcessed,
      totalLinks: links.length,
      links: links,
      // Social media data
      socials: socials,
      creatorProfile: {
        username: username,
        source: source,
        website: domain,
        socials: socials,
        needsReview: needsReview,
        discoveredAt: new Date().toISOString()
      }
    };
  }
  
  /**
   * Extract all links from current page
   */
  async extractLinks() {
    return await this.page.evaluate(() => {
      const links = [];
      
      // Get all anchor tags
      document.querySelectorAll('a[href]').forEach(a => {
        links.push({
          href: a.getAttribute('href'),
          text: a.textContent?.trim()
        });
      });
      
      // Get links from onclick handlers (basic parsing)
      document.querySelectorAll('[onclick]').forEach(el => {
        const onclick = el.getAttribute('onclick');
        const match = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (match) {
          links.push({
            href: match[1],
            text: el.textContent?.trim()
          });
        }
      });
      
      // Get links from data attributes
      document.querySelectorAll('[data-href], [data-url], [data-link]').forEach(el => {
        const href = el.getAttribute('data-href') || 
                     el.getAttribute('data-url') || 
                     el.getAttribute('data-link');
        if (href) {
          links.push({
            href: href,
            text: el.textContent?.trim()
          });
        }
      });
      
      return links;
    });
  }
  
  /**
   * Resolve relative URL to absolute
   */
  resolveUrl(baseUrl, href) {
    if (!href) return null;
    
    try {
      return new URL(href, baseUrl).href;
    } catch (err) {
      return null;
    }
  }
  
  /**
   * Normalize URL for deduplication
   */
  normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      // Remove trailing slash, fragments
      let normalized = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '');
      return normalized.toLowerCase();
    } catch (err) {
      return url.toLowerCase();
    }
  }
  
  /**
   * Check if URL should be skipped
   */
  shouldSkipUrl(url) {
    return CONFIG.skipPatterns.some(pattern => pattern.test(url));
  }
  
  /**
   * Check if two domains are the same (including www variants)
   */
  isSameDomain(domain1, domain2) {
    const normalize = d => d.replace(/^www\./, '').toLowerCase();
    return normalize(domain1) === normalize(domain2);
  }
  
  /**
   * Categorize a link based on URL and anchor text
   */
  categorizeLink(url, anchorText, pageTitle) {
    const urlLower = url.toLowerCase();
    const textLower = (anchorText || '').toLowerCase();
    
    // Check for leaderboard patterns
    for (const pattern of CONFIG.leaderboardPatterns) {
      if (pattern.test(urlLower) || pattern.test(textLower)) {
        return { category: 'leaderboard', priority: 90 };
      }
    }
    
    // Check for keyword matches in URL
    for (const keyword of this.keywords) {
      if (urlLower.includes(keyword.toLowerCase())) {
        return { category: 'potential-leaderboard', priority: 75 };
      }
    }
    
    // Categorize by URL pattern
    if (/\/(blog|news|articles?)\//i.test(url)) {
      return { category: 'blog', priority: 20 };
    }
    
    if (/\/(terms|privacy|legal|about|contact|faq|help)\//i.test(url)) {
      return { category: 'static', priority: 10 };
    }
    
    if (/\/(shop|store|checkout|cart)\//i.test(url)) {
      return { category: 'commerce', priority: 15 };
    }
    
    return { category: 'unknown', priority: 30 };
  }
  
  /**
   * Find keywords that match in URL or anchor text
   */
  findMatchingKeywords(url, anchorText) {
    const urlLower = url.toLowerCase();
    const textLower = (anchorText || '').toLowerCase();
    
    return this.keywords.filter(keyword => {
      const kw = keyword.toLowerCase();
      return urlLower.includes(kw) || textLower.includes(kw);
    });
  }
  
  /**
   * Close browser
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      log('CRAWLER', 'Browser closed');
    }
  }
}

// ============================================================================
// FILE I/O
// ============================================================================

/**
 * Load discovered links from file
 */
function loadDiscoveredLinks() {
  try {
    if (fs.existsSync(CONFIG.outputFile)) {
      const content = fs.readFileSync(CONFIG.outputFile, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    log('CRAWLER', `Failed to load discovered links: ${err.message}`);
  }
  return {};
}

/**
 * Save discovered links to file
 */
function saveDiscoveredLinks(data) {
  try {
    const dir = path.dirname(CONFIG.outputFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(data, null, 2));
    log('CRAWLER', `Saved discovered links to ${CONFIG.outputFile}`);
  } catch (err) {
    log('ERR', `Failed to save discovered links: ${err.message}`);
  }
}

/**
 * Load creator profiles from file
 */
function loadCreatorProfiles() {
  try {
    if (fs.existsSync(CONFIG.creatorProfilesFile)) {
      const content = fs.readFileSync(CONFIG.creatorProfilesFile, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    log('CRAWLER', `Failed to load creator profiles: ${err.message}`);
  }
  return {};
}

/**
 * Save creator profiles to file
 */
function saveCreatorProfiles(profiles) {
  try {
    const dir = path.dirname(CONFIG.creatorProfilesFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG.creatorProfilesFile, JSON.stringify(profiles, null, 2));
    log('CRAWLER', `Saved ${Object.keys(profiles).length} creator profiles to ${CONFIG.creatorProfilesFile}`);
  } catch (err) {
    log('ERR', `Failed to save creator profiles: ${err.message}`);
  }
}

/**
 * Update a single creator profile (merge with existing)
 */
function updateCreatorProfile(profiles, creatorProfile) {
  if (!creatorProfile || !creatorProfile.username) {
    return profiles;
  }
  
  const username = creatorProfile.username;
  
  // Merge with existing profile if present
  if (profiles[username]) {
    const existing = profiles[username];
    
    // Merge socials (don't overwrite with null)
    const mergedSocials = { ...existing.socials };
    for (const [platform, url] of Object.entries(creatorProfile.socials || {})) {
      if (url) {
        mergedSocials[platform] = url;
      }
    }
    
    profiles[username] = {
      ...existing,
      ...creatorProfile,
      socials: mergedSocials,
      // Keep existing needsReview if it was manually set to false
      needsReview: existing.needsReview === false ? false : creatorProfile.needsReview,
      updatedAt: new Date().toISOString()
    };
  } else {
    profiles[username] = creatorProfile;
  }
  
  return profiles;
}

/**
 * Generate suggested leaderboard links
 */
function generateSuggestedLinks(allData) {
  const suggested = {};
  
  for (const [domain, data] of Object.entries(allData)) {
    // Only include actual leaderboard links now
    const leaderboardLinks = data.links || [];
    
    if (leaderboardLinks.length > 0) {
      suggested[domain] = {
        leaderboards: leaderboardLinks.map(l => ({
          url: l.url,
          matchedKeywords: l.matchedKeywords || []
        })),
        creatorProfile: data.creatorProfile || null
      };
    }
  }
  
  return suggested;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  // Parse CLI arguments
  let targetUrl = null;
  let showDomain = null;
  let maxDepth = CONFIG.maxDepth;
  let maxPages = CONFIG.maxPagesPerSite;
  let numWorkers = CONFIG.parallelWorkers || 3;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--show' && args[i + 1]) {
      showDomain = args[i + 1];
      i++;
    } else if (args[i] === '--depth' && args[i + 1]) {
      maxDepth = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--max-pages' && args[i + 1]) {
      maxPages = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--workers' && args[i + 1]) {
      numWorkers = Math.max(1, Math.min(10, parseInt(args[i + 1], 10))); // Clamp 1-10
      i++;
    } else if (!args[i].startsWith('--')) {
      targetUrl = args[i];
    }
  }
  
  // Show mode - display discovered links for a domain
  if (showDomain) {
    const data = loadDiscoveredLinks();
    const domainData = data[showDomain] || data[`www.${showDomain}`];
    
    if (domainData) {
      log('CRAWLER', `\nDiscovered data for ${showDomain}:`);
      log('CRAWLER', `Crawled at: ${domainData.crawledAt}`);
      log('CRAWLER', `Leaderboard links: ${domainData.totalLinks}`);
      
      // Show leaderboard links
      if (domainData.links && domainData.links.length > 0) {
        log('CRAWLER', '\nLeaderboard URLs:');
        domainData.links.forEach(link => {
          log('CRAWLER', `  ${link.url}`);
          if (link.matchedKeywords && link.matchedKeywords.length > 0) {
            log('CRAWLER', `    Keywords: ${link.matchedKeywords.join(', ')}`);
          }
        });
      }
      
      // Show social media
      if (domainData.socials) {
        const socialCount = Object.values(domainData.socials).filter(v => v).length;
        if (socialCount > 0) {
          log('CRAWLER', '\nSocial Media:');
          if (domainData.socials.kick) log('CRAWLER', `  Kick: ${domainData.socials.kick}`);
          if (domainData.socials.twitter) log('CRAWLER', `  Twitter: ${domainData.socials.twitter}`);
          if (domainData.socials.youtube) log('CRAWLER', `  YouTube: ${domainData.socials.youtube}`);
          if (domainData.socials.discord) log('CRAWLER', `  Discord: ${domainData.socials.discord}`);
        }
      }
      
      // Show creator profile
      if (domainData.creatorProfile) {
        log('CRAWLER', `\nCreator Profile:`);
        log('CRAWLER', `  Username: ${domainData.creatorProfile.username}`);
        log('CRAWLER', `  Source: ${domainData.creatorProfile.source}`);
        if (domainData.creatorProfile.needsReview) {
          log('CRAWLER', `  Status: NEEDS MANUAL REVIEW`);
        }
      }
    } else {
      log('CRAWLER', `No data found for ${showDomain}`);
    }
    return;
  }
  
  // Determine sites to crawl
  let sitesToCrawl = [];
  
  if (targetUrl) {
    sitesToCrawl = [targetUrl];
  } else {
    // Load from websites.txt
    try {
      sitesToCrawl = loadWebsites(path.join(__dirname, 'websites.txt'));
      log('CRAWLER', `Loaded ${sitesToCrawl.length} sites from websites.txt`);
    } catch (err) {
      log('ERR', `Failed to load websites.txt: ${err.message}`);
      return;
    }
  }
  
  // Load existing data (shared across workers)
  const allData = loadDiscoveredLinks();
  let creatorProfiles = loadCreatorProfiles();
  
  // Mutex for safe file saving (simple lock using a flag)
  let isSaving = false;
  const pendingSaves = [];
  
  async function safeSave() {
    if (isSaving) {
      // Queue a save for later
      return new Promise(resolve => pendingSaves.push(resolve));
    }
    isSaving = true;
    try {
      saveDiscoveredLinks(allData);
      saveCreatorProfiles(creatorProfiles);
    } finally {
      isSaving = false;
      // Process any pending saves
      if (pendingSaves.length > 0) {
        const nextSave = pendingSaves.shift();
        nextSave();
      }
    }
  }
  
  // Queue of sites to crawl (shared across workers)
  const siteQueue = [...sitesToCrawl];
  let completedCount = 0;
  const totalSites = sitesToCrawl.length;
  
  // Determine number of workers (use CLI arg, or 1 for single URL)
  const actualWorkers = targetUrl ? 1 : Math.min(numWorkers, sitesToCrawl.length);
  log('CRAWLER', `Starting ${actualWorkers} parallel browser workers for ${totalSites} sites...`);
  
  /**
   * Worker function - creates a browser and processes sites from queue
   */
  async function crawlerWorker(workerId) {
    const crawler = new LinkCrawler({
      maxDepth,
      maxPagesPerSite: maxPages
    });
    
    try {
      await crawler.init();
      log('CRAWLER', `[Worker ${workerId}] Browser initialized`);
      
      while (siteQueue.length > 0) {
        // Get next site from queue
        const siteUrl = siteQueue.shift();
        if (!siteUrl) break;
        
        const progress = `[${completedCount + 1}/${totalSites}]`;
        log('CRAWLER', `[Worker ${workerId}] ${progress} Starting: ${siteUrl}`);
        
        try {
          const result = await crawler.crawlSite(siteUrl);
          
          // Update shared data (atomic-ish operations)
          allData[result.domain] = result;
          
          if (result.creatorProfile) {
            creatorProfiles = updateCreatorProfile(creatorProfiles, result.creatorProfile);
          }
          
          // Save immediately (with mutex to prevent file corruption)
          await safeSave();
          
          completedCount++;
          
          // Log summary
          log('CRAWLER', `[Worker ${workerId}] Done: ${result.domain} - ${result.totalLinks} leaderboard links`);
          
          // Show social media found
          const socialCount = Object.values(result.socials || {}).filter(v => v).length;
          if (socialCount > 0) {
            log('CRAWLER', `[Worker ${workerId}]   Social links: ${socialCount}`);
          }
          
          if (result.creatorProfile) {
            log('CRAWLER', `[Worker ${workerId}]   Creator: ${result.creatorProfile.username}`);
          }
          
        } catch (err) {
          log('ERR', `[Worker ${workerId}] Failed to crawl ${siteUrl}: ${err.message}`);
          completedCount++;
        }
      }
      
      log('CRAWLER', `[Worker ${workerId}] Queue empty, worker finished`);
      
    } catch (err) {
      log('ERR', `[Worker ${workerId}] Worker error: ${err.message}`);
    } finally {
      await crawler.close();
    }
  }
  
  try {
    // Start all workers in parallel
    const workerPromises = [];
    for (let i = 1; i <= actualWorkers; i++) {
      workerPromises.push(crawlerWorker(i));
    }
    
    // Wait for all workers to complete
    await Promise.all(workerPromises);
    
    // Generate suggested links summary
    const suggested = generateSuggestedLinks(allData);
    const suggestedFile = path.join(__dirname, 'data', 'suggested-leaderboards.json');
    fs.writeFileSync(suggestedFile, JSON.stringify(suggested, null, 2));
    log('CRAWLER', `\nSuggested leaderboard links saved to ${suggestedFile}`);
    
    // Count profiles needing review
    const needsReviewCount = Object.values(creatorProfiles).filter(p => p.needsReview).length;
    
    // Print summary
    log('CRAWLER', '\n========================================');
    log('CRAWLER', 'CRAWL COMPLETE');
    log('CRAWLER', '========================================');
    log('CRAWLER', `Sites crawled: ${completedCount}`);
    log('CRAWLER', `Workers used: ${actualWorkers}`);
    log('CRAWLER', `Creator profiles: ${Object.keys(creatorProfiles).length}`);
    if (needsReviewCount > 0) {
      log('CRAWLER', `Profiles needing review: ${needsReviewCount}`);
    }
    log('CRAWLER', `\nOutput files:`);
    log('CRAWLER', `  Links: ${CONFIG.outputFile}`);
    log('CRAWLER', `  Suggestions: ${suggestedFile}`);
    log('CRAWLER', `  Creator profiles: ${CONFIG.creatorProfilesFile}`);
    log('CRAWLER', '\nNext steps:');
    log('CRAWLER', '1. Review suggested-leaderboards.json');
    log('CRAWLER', '2. Add verified links to known-leaderboard-links.json');
    log('CRAWLER', '3. Review creator-profiles.json (check needsReview: true entries)');
    log('CRAWLER', '4. Run scraper with: node test-scraper.js --batch --production');
    
  } catch (err) {
    log('ERR', `Crawler error: ${err.message}`);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    log('ERR', `Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { 
  LinkCrawler, 
  loadDiscoveredLinks, 
  saveDiscoveredLinks,
  loadCreatorProfiles,
  saveCreatorProfiles,
  updateCreatorProfile,
  isLeaderboardUrl,
  extractSocialLinks,
  extractUsername,
  determineCreatorUsername
};
