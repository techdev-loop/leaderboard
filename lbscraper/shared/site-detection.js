/**
 * Detection Module for Leaderboard Scraper
 * 
 * Handles site switcher detection, content fingerprinting, OCR detection,
 * and coordinate validation
 */

const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const { log } = require('./utils');

// ============================================================================
// CONTENT FINGERPRINTING
// ============================================================================

/**
 * Generate a fingerprint of the current leaderboard content
 * @param {Page} page - Playwright page instance
 * @returns {Object} - Fingerprint with hash, sample text, and potential usernames
 */
async function generateContentFingerprint(page) {
  return await page.evaluate(() => {
    const uiWords = new Set([
      'login', 'register', 'browse', 'home', 'menu', 'search',
      'view', 'more', 'show', 'hide', 'leaderboard', 'leaderboards',
      'rank', 'ranking', 'prize', 'reward', 'wagered', 'wager',
      'total', 'other', 'leaders', 'user', 'all', 'free', 'join',
      'play', 'bet', 'gamdom', 'packdraw', 'shuffle', 'stake',
      // Timer-related UI text
      'days', 'hours', 'minutes', 'seconds', 'hrs', 'mins', 'secs',
      'day', 'hour', 'minute', 'second', 'hr', 'min', 'sec'
    ]);
    
    const contentSelectors = [
      '[class*="leaderboard"]',
      '[class*="ranking"]',
      '[class*="leaders"]',
      'main',
      '[role="main"]',
      'article',
      '.content',
      '#content'
    ];
    
    let container = null;
    for (const selector of contentSelectors) {
      try {
        const el = document.querySelector(selector);
        const text = el ? (el.innerText ?? el.textContent ?? '') : '';
        if (el && text && text.length > 100) {
          container = el;
          break;
        }
      } catch (e) {}
    }
    
    if (!container) {
      container = document.body;
    }
    
    let text = (container && (container.innerText ?? container.textContent)) || '';
    text = text
      .replace(/\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi, '')
      .replace(/\d+\s*(seconds?|minutes?|hours?|days?)\s*(ago|left|remaining)?/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Generate hash
    let hash = 5381;
    for (let i = 0; i < Math.min(text.length, 5000); i++) {
      hash = ((hash << 5) + hash) + text.charCodeAt(i);
      hash = hash & hash;
    }
    
    // Extract potential usernames
    const usernameElements = [];
    
    const entries = container.querySelectorAll(
      '[class*="entry"], [class*="row"], [class*="player"], ' +
      '[class*="item"], [class*="card"], [class*="user"], tr, li'
    );
    
    // Collect more usernames to detect changes deeper in the leaderboard
    // Skip first few entries as they might be "featured" users that don't change
    let skippedEntries = 0;
    for (const entry of entries) {
      const entryText = (entry && (entry.innerText ?? entry.textContent ?? '')) || '';
      if (!entryText || entryText.length > 500 || entryText.length < 10) continue;

      // Skip first 3 entries (often featured/top users that stay the same)
      if (skippedEntries < 3) {
        skippedEntries++;
        continue;
      }

      const lines = entryText.split('\n').map(l => l.trim()).filter(l => l);

      for (const line of lines) {
        const lineLower = line.toLowerCase();
        if (uiWords.has(lineLower)) continue;
        if (/^[$€£]?\s*[\d,.]+\s*(k|m)?$/i.test(line)) continue;
        if (line.length < 3 || line.length > 25) continue;
        const hasLetters = /[a-zA-Z]/.test(line);
        const hasAsterisks = line.includes('*');
        if (!hasLetters && !hasAsterisks) continue;
        if (/^(wagered|reward|prize|bonus|status|rank|user|active|inactive)$/i.test(line)) continue;

        usernameElements.push(line);
        if (usernameElements.length >= 10) break;  // Collect 10 usernames for better detection
      }
      if (usernameElements.length >= 10) break;
    }
    
    // Fallback if not enough usernames found
    if (usernameElements.length < 5) {
      const allElements = container.querySelectorAll('span, div, td, p');
      let skipped = 0;
      for (const el of allElements) {
        const elText = el.textContent?.trim() || '';
        const elLower = elText.toLowerCase();

        if (elText.length < 3 || elText.length > 25) continue;
        if (uiWords.has(elLower)) continue;
        if (/^[$€£]?\s*[\d,.]+\s*(k|m)?$/i.test(elText)) continue;

        const hasLetters = /[a-zA-Z]/.test(elText);
        const hasAsterisks = elText.includes('*');
        if (!hasLetters && !hasAsterisks) continue;

        // Skip first few elements (featured users)
        if (skipped < 3) {
          skipped++;
          continue;
        }

        if (el && el.children && el.children.length <= 1) {
          usernameElements.push(elText);
        }
        if (usernameElements.length >= 10) break;
      }
    }
    
    return {
      hash: hash.toString(36),
      sampleText: text.substring(0, 200),
      potentialUsernames: usernameElements.slice(0, 10)  // Return 10 usernames for better change detection
    };
  });
}

/**
 * Wait for content to change after a click
 * @param {Page} page - Playwright page instance
 * @param {Object} previousFingerprint - Previous fingerprint
 * @param {number} maxWaitMs - Maximum wait time in ms
 * @param {Object} options - Options including pollIntervalMs and minUsernameChanges
 * @returns {Object} - Result with changed, elapsed, newFingerprint, usernameChanges
 */
async function waitForContentChange(page, previousFingerprint, maxWaitMs = 12000, options = {}) {
  const { pollIntervalMs = 500, minUsernameChanges = 2, productionMode = false } = options;
  
  const startTime = Date.now();
  
  log('FP', `Waiting for content change (max ${maxWaitMs}ms)...`);
  log('FP', `Previous fingerprint: ${previousFingerprint.hash}`, { 
    usernames: previousFingerprint.potentialUsernames 
  });
  
  while ((Date.now() - startTime) < maxWaitMs) {
    await page.waitForTimeout(pollIntervalMs);
    
    const currentFingerprint = await generateContentFingerprint(page);
    
    const hashChanged = currentFingerprint.hash !== previousFingerprint.hash;
    
    // Count username changes
    const prevNames = new Set((previousFingerprint.potentialUsernames || []).map(n => String(n || '').toLowerCase()));
    const currNames = currentFingerprint.potentialUsernames;
    let usernameChanges = 0;
    
    for (const name of currNames) {
      if (!prevNames.has(name.toLowerCase())) {
        usernameChanges++;
      }
    }
    
    // In production mode, require stricter changes
    const minChangesRequired = productionMode ? minUsernameChanges : 1;
    
    if (hashChanged && usernameChanges >= minChangesRequired) {
      const elapsed = Date.now() - startTime;
      log('FP', `Content changed after ${elapsed}ms (${usernameChanges} new usernames)`);
      log('FP', `New fingerprint: ${currentFingerprint.hash}`, {
        usernames: currentFingerprint.potentialUsernames
      });
      return { changed: true, elapsed, newFingerprint: currentFingerprint, usernameChanges };
    }
    
    // Allow hash-only change in non-production mode
    if (!productionMode && hashChanged) {
      const elapsed = Date.now() - startTime;
      log('FP', `Hash changed after ${elapsed}ms (username changes: ${usernameChanges})`);
      return { changed: true, elapsed, newFingerprint: currentFingerprint, usernameChanges };
    }
  }
  
  log('FP', `No content change detected after ${maxWaitMs}ms`);
  return { changed: false, elapsed: maxWaitMs, newFingerprint: null, usernameChanges: 0 };
}

// ============================================================================
// COORDINATE VALIDATION
// ============================================================================

/**
 * Validate that coordinates are sane (on-screen, positive, reasonable bounds)
 * @param {Object} coords - Coordinates with x and y
 * @param {number} viewportWidth - Viewport width
 * @param {number} viewportHeight - Viewport height
 * @returns {Object} - { valid: boolean, reason: string }
 */
function validateCoordinates(coords, viewportWidth = 1920, viewportHeight = 1080) {
  if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') {
    return { valid: false, reason: 'missing_coordinates' };
  }
  
  if (coords.x < 0 || coords.y < 0) {
    return { valid: false, reason: 'negative_coordinate', coords };
  }
  
  if (coords.x > viewportWidth || coords.y > viewportHeight) {
    return { valid: false, reason: 'off_screen', coords };
  }
  
  // Reject if too close to top edge (likely hidden/overflow) - but allow y >= 0
  // Many sites have tabs at y=20-40; only reject clearly off-screen (y < 0)
  if (coords.y < 0) {
    return { valid: false, reason: 'above_viewport', coords };
  }

  return { valid: true };
}

/**
 * Group switchers by spatial proximity
 * @param {Array} switchers - Array of switcher objects
 * @param {number} tolerance - Y-axis tolerance in pixels
 * @returns {Array} - Filtered and grouped switchers
 */
function groupSwitchersBySpatialProximity(switchers, tolerance = 50) {
  if (switchers.length < 2) return switchers;
  
  // Filter out invalid coordinates first
  const validSwitchers = switchers.filter(s => {
    const validation = validateCoordinates(s.coordinates);
    if (!validation.valid) {
      log('CLICK', `Filtering out ${s.keyword} with invalid coords: ${validation.reason}`);
      return false;
    }
    return true;
  });
  
  if (validSwitchers.length < 2) return validSwitchers;
  
  // Sort by Y coordinate
  const sorted = [...validSwitchers].sort((a, b) => a.coordinates.y - b.coordinates.y);
  
  const groups = [];
  let currentGroup = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    
    if (Math.abs(curr.coordinates.y - prev.coordinates.y) <= tolerance) {
      currentGroup.push(curr);
    } else {
      groups.push(currentGroup);
      currentGroup = [curr];
    }
  }
  groups.push(currentGroup);
  
  // Find the largest group
  const largestGroup = groups.reduce((max, g) => g.length > max.length ? g : max, []);
  
  log('CLICK', `Found ${groups.length} spatial groups, largest has ${largestGroup.length} switchers`);
  
  // Mark switchers in main group
  for (const switcher of validSwitchers) {
    switcher.inMainGroup = largestGroup.some(s => 
      s.keyword === switcher.keyword && 
      Math.abs(s.coordinates.x - switcher.coordinates.x) < 5
    );
    
    if (switcher.inMainGroup) {
      switcher.priority += 20;
      switcher.groupY = largestGroup[0].coordinates.y;
    }
  }
  
  return validSwitchers;
}

/**
 * Find the best switcher for a keyword
 * @param {Array} switchers - Array of switcher objects
 * @param {string} keyword - Keyword to find
 * @param {Object|null} referenceCoords - Reference coordinates for proximity
 * @returns {Object|null} - Best matching switcher
 */
function findBestSwitcherForKeyword(switchers, keyword, referenceCoords = null) {
  const matches = switchers.filter(s => s.keyword.toLowerCase() === keyword.toLowerCase());
  
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    const validation = validateCoordinates(matches[0].coordinates);
    return validation.valid ? matches[0] : null;
  }
  
  log('CLICK', `Found ${matches.length} elements matching "${keyword}", selecting best...`);
  
  // Filter out invalid coordinates
  const validMatches = matches.filter(m => {
    const validation = validateCoordinates(m.coordinates);
    if (!validation.valid) {
      log('CLICK', `  Rejecting ${keyword} at (${Math.round(m.coordinates.x)}, ${Math.round(m.coordinates.y)}): ${validation.reason}`);
      return false;
    }
    return true;
  });
  
  if (validMatches.length === 0) {
    log('CLICK', `  No valid coordinates found for ${keyword}`);
    return null;
  }
  
  if (validMatches.length === 1) return validMatches[0];
  
  // If we have a reference point, prefer nearby ones
  if (referenceCoords) {
    validMatches.sort((a, b) => {
      const aYDiff = Math.abs(a.coordinates.y - referenceCoords.y);
      const bYDiff = Math.abs(b.coordinates.y - referenceCoords.y);
      
      const aOnSameRow = aYDiff < 30;
      const bOnSameRow = bYDiff < 30;
      
      if (aOnSameRow && !bOnSameRow) return -1;
      if (bOnSameRow && !aOnSameRow) return 1;
      
      const aDist = Math.sqrt(Math.pow(a.coordinates.x - referenceCoords.x, 2) + Math.pow(aYDiff * 2, 2));
      const bDist = Math.sqrt(Math.pow(b.coordinates.x - referenceCoords.x, 2) + Math.pow(bYDiff * 2, 2));
      
      return aDist - bDist;
    });
    
    log('CLICK', `  Selected ${keyword} at (${Math.round(validMatches[0].coordinates.x)}, ${Math.round(validMatches[0].coordinates.y)}) - closest to reference`);
  } else {
    // Prefer elements in main group, then by priority
    validMatches.sort((a, b) => {
      if (a.inMainGroup && !b.inMainGroup) return -1;
      if (b.inMainGroup && !a.inMainGroup) return 1;
      return b.priority - a.priority;
    });
    
    log('CLICK', `  Selected ${keyword} at (${Math.round(validMatches[0].coordinates.x)}, ${Math.round(validMatches[0].coordinates.y)}) - highest priority in main group`);
  }
  
  return validMatches[0];
}

// ============================================================================
// SITE SWITCHER DETECTION
// ============================================================================

/**
 * Find site switcher buttons/cards/tabs on the page
 * @param {Page} page - Playwright page instance
 * @param {Array} keywords - Keywords to search for
 * @returns {Array} - Array of switcher objects
 */
async function findSiteSwitchers(page, keywords) {
  log('CLICK', 'Looking for site switcher buttons/cards/tabs...');
  
  // Phase 1: Open any dropdown menus that might contain switchers
  // This handles sites like jonkennleaderboard.com where leaderboard links are in dropdowns
  await page.evaluate(() => {
    // Strategy 1: Find and click dropdown buttons directly
    // Look for buttons that might open dropdowns containing leaderboard links
    const dropdownButtonSelectors = [
      '.dropdown-btn',
      '.dropdown-toggle',
      '[class*="dropdown"] > button',
      '[class*="dropdown"] button',
      '.site-dropdown button',
      '[class*="site-select"] button',
      'button:has(+ .dropdown-content)',
      'button:has(+ [class*="dropdown-menu"])'
    ];

    for (const selector of dropdownButtonSelectors) {
      try {
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          // Check if this button might be related to leaderboards
          const text = (btn.textContent || '').toLowerCase();
          const parentText = (btn.parentElement?.textContent || '').toLowerCase();
          if (text.includes('leaderboard') || text.includes('site') || text.includes('select') ||
              parentText.includes('leaderboard') || parentText.includes('site')) {
            btn.click();
          }
        }
      } catch (e) {}
    }

    // Strategy 2: Find dropdown containers and force-show their content
    const dropdownContainerSelectors = [
      '.dropdown-container',
      '.site-dropdown',
      '[class*="dropdown"]:has(.dropdown-content)',
      '[class*="dropdown"]:has([class*="dropdown-menu"])',
      '.hidden.group-hover\\:block',
      '[class*="group"]:has(ul.hidden)',
      'li:has(ul.hidden)'
    ];

    for (const selector of dropdownContainerSelectors) {
      try {
        const containers = document.querySelectorAll(selector);
        for (const container of containers) {
          // Trigger hover events
          container.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

          // Find and force-show any hidden content
          const contentSelectors = [
            '.dropdown-content',
            '[class*="dropdown-menu"]',
            '.dropdown-items',
            'ul.hidden',
            'div.hidden'
          ];

          for (const contentSel of contentSelectors) {
            const content = container.querySelector(contentSel);
            if (content) {
              content.style.display = 'block';
              content.style.visibility = 'visible';
              content.style.opacity = '1';
              content.style.position = 'absolute';
              content.style.zIndex = '9999';
              content.classList.remove('hidden');
            }
          }
        }
      } catch (e) {}
    }

    // Strategy 3: Direct targeting of hidden elements with leaderboard links
    try {
      const hiddenWithLinks = document.querySelectorAll('[class*="dropdown"] a[href*="leaderboard"]');
      for (const link of hiddenWithLinks) {
        let parent = link.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          if (parent.classList.contains('hidden') ||
              getComputedStyle(parent).display === 'none' ||
              getComputedStyle(parent).visibility === 'hidden') {
            parent.style.display = 'block';
            parent.style.visibility = 'visible';
            parent.style.opacity = '1';
            parent.classList.remove('hidden');
          }
          parent = parent.parentElement;
        }
      }
    } catch (e) {}
  });

  // Wait for dropdowns to open and content to render
  await page.waitForTimeout(800);
  
  const switchers = await page.evaluate((kws) => {
    const found = [];
    const seenKeywords = new Set();
    
    /**
     * Extract keyword from image filename
     * Examples: /brands/csgobig.png -> csgobig, /logos/shuffle_logo.svg -> shuffle
     */
    function extractKeywordFromFilename(src) {
      if (!src) return null;
      try {
        // Get filename from URL path
        const url = new URL(src, window.location.origin);
        const pathname = url.pathname;
        const filename = pathname.split('/').pop();
        if (!filename) return null;
        
        // Remove extension and common suffixes INCLUDING numeric sizes
        const name = filename
          .replace(/\.(png|jpg|jpeg|svg|gif|webp)$/i, '')
          .replace(/[-_]?(logo|icon|small|large|coin|currency|brand|img|image)$/i, '')
          .replace(/[-_]\d{1,3}$/i, '')  // Remove trailing -32, -64, -128, etc.
          .replace(/^(logo|icon|brand)[-_]?/i, '')
          .toLowerCase();

        return name.length >= 3 && name.length <= 30 ? name : null;
      } catch (e) {
        return null;
      }
    }
    
    /**
     * Check if element appears visually active/selected
     */
    function isVisuallyActive(el) {
      try {
        const style = window.getComputedStyle(el);
        const className = (el.className || '').toLowerCase();
        
        // Check for active/selected class patterns
        const hasActiveClass = /active|selected|current|chosen/.test(className);
        
        // Check opacity (inactive elements often have opacity < 1)
        const opacity = parseFloat(style.opacity);
        const isFullOpacity = opacity === 1;
        
        // Check for active border styling
        const hasBorder = style.borderBottomWidth !== '0px' && 
                         style.borderBottomColor !== 'transparent' &&
                         style.borderBottomColor !== 'rgba(0, 0, 0, 0)';
        
        // Check for background gradient (common active indicator)
        const hasGradient = style.backgroundImage.includes('gradient');
        
        return {
          isActive: hasActiveClass || (hasBorder && isFullOpacity) || hasGradient,
          opacity: opacity,
          hasActiveClass: hasActiveClass
        };
      } catch (e) {
        return { isActive: false, opacity: 1, hasActiveClass: false };
      }
    }
    
    /**
     * Check if href is an external link (should be filtered out)
     */
    function isExternalLink(href) {
      if (!href) return false;
      // External links start with http:// or https:// and go to different domain
      if (href.startsWith('http://') || href.startsWith('https://')) {
        try {
          const linkUrl = new URL(href);
          return linkUrl.hostname !== window.location.hostname;
        } catch (e) {
          return true; // Malformed URL, treat as external
        }
      }
      return false;
    }
    
    /**
     * Check if href is a relative navigation link (not # or external)
     */
    function isRelativeNavLink(href) {
      if (!href) return false;
      // Skip external links
      if (isExternalLink(href)) return false;
      // Skip hash-only links (unless they have data attributes)
      if (href === '#' || href.startsWith('#')) return false;
      // Skip javascript: links
      if (href.startsWith('javascript:')) return false;
      // Valid relative paths
      return true;
    }
    
    function getKeywordsFromElement(el, keywords) {
      const text = (el.textContent || '').toLowerCase().trim();
      for (const kw of keywords) {
        if (text.includes(kw) && !text.includes('previous')) {
          return { keyword: kw, source: 'text' };
        }
      }
      
      // Check for relative href that contains a keyword
      const link = el.closest('a') || (el.tagName === 'A' ? el : null);
      if (link) {
        const href = link.getAttribute('href') || '';
        
        // Skip external links (affiliate links, etc.)
        if (isExternalLink(href)) {
          return null;
        }
        
        // Check for relative navigation links
        if (isRelativeNavLink(href)) {
          const pathKeyword = href.replace(/^[./]+/, '').split('/')[0].toLowerCase();
          // Skip common non-leaderboard navigation paths
          const navBlacklist = ['bonus', 'bonuses', 'about', 'contact', 'support', 'help', 'faq',
            'login', 'register', 'signup', 'signin', 'logout', 'account', 'profile',
            'terms', 'privacy', 'legal', 'disclaimer', 'tos', 'policy',
            'promotions', 'promo', 'offers', 'deals', 'rewards', 'vip',
            'blog', 'news', 'updates', 'announcements', 'press',
            'affiliate', 'affiliates', 'partners', 'referral', 'referrals',
            'shop', 'store', 'cart', 'checkout', 'payment', 'deposit', 'withdraw',
            'settings', 'preferences', 'dashboard', 'admin', 'panel',
            'games', 'slots', 'live', 'sports', 'casino', 'poker',
            'api', 'docs', 'documentation', 'developers'];
          if (navBlacklist.includes(pathKeyword)) {
            return null; // Skip blacklisted paths
          }
          for (const kw of keywords) {
            if (pathKeyword === kw || pathKeyword.includes(kw)) {
              return { keyword: kw, source: 'href-relative', href: href };
            }
          }
        }
        
        // Check for hash links with data attributes (JavaScript-driven)
        if (href === '#' || href.startsWith('#')) {
          const loadMode = link.getAttribute('data-load-mode') || 
                          link.getAttribute('data-site') ||
                          link.getAttribute('data-provider');
          if (loadMode) {
            const modeLower = loadMode.toLowerCase();
            for (const kw of keywords) {
              if (modeLower === kw || modeLower.includes(kw)) {
                return { keyword: kw, source: 'data-attr-click', dataAttr: 'data-load-mode' };
              }
            }
          }
        }
      }
      
      const images = el.querySelectorAll('img');
      for (const img of images) {
        const src = (img.src || '').toLowerCase();
        const alt = (img.alt || '').toLowerCase();
        const srcset = (img.srcset || '').toLowerCase();
        
        // First check if full keyword is in src/alt/srcset
        for (const kw of keywords) {
          if (src.includes(kw) || alt.includes(kw) || srcset.includes(kw)) {
            return { keyword: kw, source: 'image' };
          }
        }
        
        // Then try extracting keyword from filename
        const filenameKeyword = extractKeywordFromFilename(img.src);
        if (filenameKeyword) {
          for (const kw of keywords) {
            if (filenameKeyword === kw || filenameKeyword.includes(kw) || kw.includes(filenameKeyword)) {
              return { keyword: kw, source: 'image-filename' };
            }
          }
          // Also check alt text cleanup
          const altClean = alt.replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
          for (const kw of keywords) {
            if (altClean === kw || altClean.includes(kw)) {
              return { keyword: kw, source: 'image-alt' };
            }
          }
        }
      }
      
      if (el.dataset) {
        for (const key in el.dataset) {
          const value = (el.dataset[key] || '').toLowerCase();
          for (const kw of keywords) {
            if (value.includes(kw)) {
              return { keyword: kw, source: 'data-attr' };
            }
          }
        }
      }
      
      return null;
    }
    
    // Slider containers
    const sliderSelectors = [
      '[class*="slider"]', '[class*="Slider"]',
      '[class*="carousel"]', '[class*="Carousel"]',
      '[class*="swiper"]', '[class*="buttonSlider"]'
    ];
    
    for (const selector of sliderSelectors) {
      try {
        const containers = document.querySelectorAll(selector);
        for (const container of containers) {
          const buttons = container.querySelectorAll('button, a, [role="button"], [tabindex="0"]');
          for (const btn of buttons) {
            const match = getKeywordsFromElement(btn, kws);
            if (match && !seenKeywords.has(match.keyword)) {
              const rect = btn.getBoundingClientRect();
              if (rect.width > 20 && rect.height > 20 && rect.width < 400) {
                const activeState = isVisuallyActive(btn);
                seenKeywords.add(match.keyword);
                found.push({
                  keyword: match.keyword,
                  type: 'slider-button',
                  priority: 90,
                  coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
                  source: match.source,
                  isActive: activeState.isActive,
                  opacity: activeState.opacity
                });
              }
            }
          }
        }
      } catch (e) {}
    }

    // Horizontal scroll containers (common for wrewards-style carousels)
    // These have overflow-x: scroll/auto and contain clickable items with images
    try {
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        try {
          const style = window.getComputedStyle(div);
          const hasHorizontalScroll = style.overflowX === 'scroll' || style.overflowX === 'auto';
          const hasFlexRow = style.display === 'flex' && (style.flexDirection === 'row' || style.flexDirection === '');

          if (hasHorizontalScroll || hasFlexRow) {
            // Check if this container has multiple clickable items with images
            const items = div.querySelectorAll('[class*="item"], [class*="card"], [class*="slide"], button, a');
            if (items.length >= 2) {
              for (const item of items) {
                const img = item.querySelector('img');
                if (!img) continue;

                const imgSrc = (img.src || '').toLowerCase();
                const imgAlt = (img.alt || '').toLowerCase();

                // Check if image matches a keyword
                for (const kw of kws) {
                  if ((imgSrc.includes(kw) || imgAlt.includes(kw)) && !seenKeywords.has(kw)) {
                    const rect = item.getBoundingClientRect();
                    if (rect.width > 30 && rect.height > 30 && rect.width < 400 && rect.top > 0) {
                      const activeState = isVisuallyActive(item);
                      seenKeywords.add(kw);
                      found.push({
                        keyword: kw,
                        type: 'scroll-carousel-item',
                        priority: 92, // Higher than image-button (75), close to slider-button (90)
                        coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
                        source: 'horizontal-scroll',
                        isActive: activeState.isActive,
                        opacity: activeState.opacity
                      });
                    }
                    break;
                  }
                }
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    // Tab lists
    const tabLists = document.querySelectorAll('[role="tablist"], [class*="tab-list"], [class*="tabs"]');
    for (const tabList of tabLists) {
      const tabs = tabList.querySelectorAll('[role="tab"], [class*="tab"], button, [tabindex]');
      for (const tab of tabs) {
        const match = getKeywordsFromElement(tab, kws);
        if (match && !seenKeywords.has(match.keyword)) {
          const rect = tab.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const activeState = isVisuallyActive(tab);
            seenKeywords.add(match.keyword);
            found.push({
              keyword: match.keyword,
              type: 'tab',
              priority: 100,
              coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
              source: match.source,
              isActive: activeState.isActive,
              opacity: activeState.opacity
            });
          }
        }
      }
    }
    
    // Relative navigation links (href-relative type) - HIGH PRIORITY
    // Blacklist common non-leaderboard navigation paths
    const navBlacklist = new Set([
      'bonus', 'bonuses', 'about', 'contact', 'support', 'help', 'faq',
      'login', 'register', 'signup', 'signin', 'logout', 'account', 'profile',
      'terms', 'privacy', 'legal', 'disclaimer', 'tos', 'policy',
      'promotions', 'promo', 'offers', 'deals', 'rewards', 'vip',
      'blog', 'news', 'updates', 'announcements', 'press',
      'affiliate', 'affiliates', 'partners', 'referral', 'referrals',
      'shop', 'store', 'cart', 'checkout', 'payment', 'deposit', 'withdraw',
      'settings', 'preferences', 'dashboard', 'admin', 'panel',
      'games', 'slots', 'live', 'sports', 'casino', 'poker',
      'api', 'docs', 'documentation', 'developers'
    ]);
    
    const navLinks = document.querySelectorAll('a[href]:not([href^="http"]):not([href^="#"]):not([href^="javascript"])');
    for (const link of navLinks) {
      const href = link.getAttribute('href') || '';
      // Skip empty or complex paths
      if (!href || href.length > 80) continue;

      // Extract keywords from href path - handle /leaderboard/{keyword} pattern
      const hrefLower = href.toLowerCase();
      const pathParts = href.replace(/^[./]+/, '').split('/').filter(p => p);

      // Primary keyword from first segment
      let pathKeyword = pathParts[0]?.toLowerCase() || '';

      // Special handling for /leaderboard/{keyword} or /leaderboards/{keyword} paths
      // Extract the keyword after 'leaderboard' if present
      const leaderboardIndex = pathParts.findIndex(p =>
        p.toLowerCase() === 'leaderboard' || p.toLowerCase() === 'leaderboards'
      );
      let leaderboardKeyword = null;
      if (leaderboardIndex >= 0 && pathParts[leaderboardIndex + 1]) {
        leaderboardKeyword = pathParts[leaderboardIndex + 1].toLowerCase();
      }

      if (!pathKeyword || pathKeyword.length < 2) continue;

      // Skip blacklisted navigation paths (non-leaderboard pages)
      // Check both exact match and if any blacklisted term appears in the path
      if (navBlacklist.has(pathKeyword) && !leaderboardKeyword) continue;

      // Additional check: skip hrefs that contain blacklisted terms anywhere (e.g., "gamdom-bonuses")
      let hasBlacklistedTerm = false;
      for (const blacklisted of navBlacklist) {
        if (hrefLower.includes(blacklisted)) {
          hasBlacklistedTerm = true;
          break;
        }
      }
      if (hasBlacklistedTerm && !leaderboardKeyword) continue;

      // Prioritize leaderboard-related paths
      const isLeaderboardPath = hrefLower.includes('leaderboard') || hrefLower.includes('lb') || hrefLower.includes('ranking');

      // Check both pathKeyword and leaderboardKeyword against known keywords
      for (const kw of kws) {
        const kwLower = kw.toLowerCase();
        const matchesPath = (pathKeyword === kwLower || pathKeyword.includes(kwLower));
        const matchesLeaderboard = leaderboardKeyword && (leaderboardKeyword === kwLower || leaderboardKeyword.includes(kwLower));

        if ((matchesPath || matchesLeaderboard) && !seenKeywords.has(kw)) {
          const rect = link.getBoundingClientRect();
          // Relax constraints for dropdown items (they may have smaller dimensions or be off-screen initially)
          const isDropdownItem = link.classList.contains('dropdown-item') ||
            link.closest('.dropdown-content') || link.closest('[class*="dropdown"]');
          const minSize = isDropdownItem ? 5 : 20;
          const maxTop = isDropdownItem ? 2000 : 800;
          if (rect.width > minSize && rect.height > minSize && rect.width < 400 && rect.top > -100 && rect.top < maxTop) {
            const activeState = isVisuallyActive(link);
            seenKeywords.add(kw);
            found.push({
              keyword: kw,
              type: 'href-relative',
              // Higher priority for leaderboard paths (98), lower for generic paths (95)
              priority: isLeaderboardPath ? 98 : 95,
              coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
              source: 'href-relative',
              href: href,
              isActive: activeState.isActive,
              opacity: activeState.opacity
            });
            break;
          }
        }
      }
    }
    
    // General buttons
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const match = getKeywordsFromElement(btn, kws);
      if (match && !seenKeywords.has(match.keyword)) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20) {
          const activeState = isVisuallyActive(btn);
          // Boost priority if button has text (more reliable than image-only)
          const hasText = (btn.textContent || '').trim().length > 2;
          seenKeywords.add(match.keyword);
          found.push({
            keyword: match.keyword,
            type: 'button',
            priority: hasText ? 85 : 80,
            coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
            source: match.source,
            isActive: activeState.isActive,
            opacity: activeState.opacity
          });
        }
      }
    }

    // Images with site names
    const allImages = document.querySelectorAll('img');
    for (const img of allImages) {
      const src = (img.src || '').toLowerCase();
      const srcset = (img.srcset || '').toLowerCase();
      const alt = (img.alt || '').toLowerCase();

      for (const kw of kws) {
        if ((src.includes(kw) || srcset.includes(kw)) && !seenKeywords.has(kw)) {
          let clickable = null;
          let el = img;
          for (let i = 0; i < 5 && el; i++) {
            el = el.parentElement;
            if (!el) break;
            
            const tag = el.tagName.toLowerCase();
            if (tag === 'button' || tag === 'a' ||
                el.getAttribute('role') === 'button' ||
                el.getAttribute('tabindex') === '0') {
              clickable = el;
              break;
            }
            
            try {
              if (window.getComputedStyle(el).cursor === 'pointer') {
                clickable = el;
                break;
              }
            } catch (e) {}
          }
          
          if (clickable) {
            const rect = clickable.getBoundingClientRect();
            if (rect.width > 20 && rect.height > 20 && rect.width < 400) {
              const activeState = isVisuallyActive(clickable);
              seenKeywords.add(kw);
              found.push({
                keyword: kw,
                type: 'image-button',
                priority: 75,
                coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
                source: 'image',
                isActive: activeState.isActive,
                opacity: activeState.opacity
              });
            }
          }
          break;
        }
      }
    }

    // SVG elements
    const allSvgs = document.querySelectorAll('svg');
    for (const svg of allSvgs) {
      const svgHtml = svg.outerHTML.toLowerCase();
      
      for (const kw of kws) {
        if (svgHtml.includes(kw) && !seenKeywords.has(kw)) {
          let svgParent = svg.closest('button, a, [role="button"], [tabindex="0"]');
          
          if (!svgParent) {
            let el = svg.parentElement;
            for (let i = 0; i < 5 && el; i++) {
              try {
                if (window.getComputedStyle(el).cursor === 'pointer') {
                  svgParent = el;
                  break;
                }
              } catch (e) {}
              el = el.parentElement;
            }
          }
          
          const targetEl = svgParent || svg.parentElement;
          if (targetEl) {
            const rect = targetEl.getBoundingClientRect();
            if (rect.width > 20 && rect.height > 20 && rect.width < 400 && rect.top > 0) {
              const activeState = isVisuallyActive(targetEl);
              seenKeywords.add(kw);
              found.push({
                keyword: kw,
                type: 'svg-button',
                priority: 80, // Reduced from 85 - SVG matching can be less reliable
                coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
                source: 'svg',
                isActive: activeState.isActive,
                opacity: activeState.opacity
              });
            }
          }
        }
      }
    }
    
    // Element attributes (data-*, title, aria-label)
    const attrElements = document.querySelectorAll('[data-site], [data-provider], [data-casino], [title], [aria-label]');
    for (const el of attrElements) {
      const attrs = el.attributes;
      if (!attrs) continue;
      
      for (let i = 0; i < attrs.length; i++) {
        const attrName = attrs[i].name.toLowerCase();
        const attrValue = (attrs[i].value || '').toLowerCase();
        
        if (['class', 'style', 'id'].includes(attrName)) continue;
        
        for (const kw of kws) {
          if (attrValue.includes(kw) && !seenKeywords.has(kw)) {
            let clickable = el;
            if (!['BUTTON', 'A'].includes(el.tagName)) {
              clickable = el.closest('button, a, [role="button"], [tabindex="0"]') || el;
            }
            
            const rect = clickable.getBoundingClientRect();
            if (rect.width > 20 && rect.height > 20 && rect.width < 400 && rect.top > 0) {
              const activeState = isVisuallyActive(clickable);
              seenKeywords.add(kw);
              found.push({
                keyword: kw,
                type: 'attr-match',
                priority: 80, // Increased from 70 - explicit data attributes show clear intent
                coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
                source: `attr:${attrName}`,
                isActive: activeState.isActive,
                opacity: activeState.opacity
              });
            }
            break;
          }
        }
      }
    }
    
    // innerHTML search
    const allDivs = document.querySelectorAll('div, span, button, a');
    for (const div of allDivs) {
      const rect = div.getBoundingClientRect();
      if (rect.width < 30 || rect.width > 300 || rect.height < 20 || rect.height > 200) continue;
      if (rect.top < 0 || rect.top > 800) continue;
      
      const html = div.innerHTML.toLowerCase();
      
      for (const kw of kws) {
        if (html.includes(kw) && !seenKeywords.has(kw)) {
          let clickable = div;
          if (div.tagName !== 'BUTTON' && div.tagName !== 'A') {
            const parent = div.closest('button, a, [role="button"], [tabindex="0"]');
            if (parent) clickable = parent;
          }
          
          const clickRect = clickable.getBoundingClientRect();
          if (clickRect.width >= 30 && clickRect.height >= 20 && clickRect.width <= 350) {
            const activeState = isVisuallyActive(clickable);
            seenKeywords.add(kw);
            found.push({
              keyword: kw,
              type: 'innerHTML-match',
              priority: 65,
              coordinates: { x: clickRect.x + clickRect.width / 2, y: clickRect.y + clickRect.height / 2 },
              source: 'innerHTML',
              isActive: activeState.isActive,
              opacity: activeState.opacity
            });
          }
          break;
        }
      }
    }
    
    // Sort by priority, then by active state (non-active first - we want to click those)
    found.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      // Non-active elements first (we want to click those to switch)
      if (a.isActive && !b.isActive) return 1;
      if (!a.isActive && b.isActive) return -1;
      return 0;
    });
    return found;
  }, keywords);

  // Additional deep scan: check script content and all HTML for keywords not found in DOM elements
  const existingKeywords = new Set(switchers.map(s => s.keyword.toLowerCase()));
  
  const scriptAndHtmlKeywords = await page.evaluate((kws) => {
    const found = [];
    
    // 1. Scan inline script content for keywords
    const scripts = document.querySelectorAll('script');
    scripts.forEach(script => {
      const content = (script.textContent || '').toLowerCase();
      kws.forEach(kw => {
        if (content.includes(kw.toLowerCase())) {
          found.push({ keyword: kw, source: 'script' });
        }
      });
    });
    
    // 2. Scan full HTML source for keywords (catches dynamically loaded content)
    const fullHtml = document.documentElement.innerHTML.toLowerCase();
    kws.forEach(kw => {
      if (fullHtml.includes(kw.toLowerCase())) {
        // Check if it's in a data attribute
        const hasDataAttr = fullHtml.includes(`data-`) && fullHtml.includes(kw.toLowerCase());
        found.push({ keyword: kw, source: hasDataAttr ? 'data-attribute' : 'html-deep' });
      }
    });
    
    // 3. Scan all element attributes (not just specific ones)
    const allElements = document.querySelectorAll('*');
    allElements.forEach(el => {
      if (!el.attributes) return;
      for (let i = 0; i < el.attributes.length; i++) {
        const attrValue = (el.attributes[i].value || '').toLowerCase();
        kws.forEach(kw => {
          if (attrValue.includes(kw.toLowerCase())) {
            found.push({ keyword: kw, source: `attr:${el.attributes[i].name}` });
          }
        });
      }
    });
    
    return found;
  }, keywords);
  
  // For script-detected keywords, try to find corresponding clickable elements
  // Search more aggressively for buttons that might contain these keywords in any form
  const scriptKeywordsToFind = scriptAndHtmlKeywords
    .filter(item => !existingKeywords.has(item.keyword.toLowerCase()))
    .map(item => item.keyword.toLowerCase());
  
  if (scriptKeywordsToFind.length > 0) {
    const additionalSwitchers = await page.evaluate((kws) => {
      const found = [];
      const seenKeywords = new Set();
      
      // Find all potential switcher buttons (horizontal groups of clickable elements)
      const allClickables = document.querySelectorAll('button, a, [role="button"], [tabindex="0"], [class*="tab"], [class*="button"], [class*="nav"]');
      
      for (const el of allClickables) {
        const rect = el.getBoundingClientRect();
        // Only consider reasonably sized elements in visible area
        if (rect.width < 30 || rect.width > 400 || rect.height < 20 || rect.height > 200) continue;
        if (rect.top < 0 || rect.top > 800) continue;
        
        // Check all possible locations for keywords
        const outerHtml = el.outerHTML.toLowerCase();
        const href = (el.getAttribute('href') || '').toLowerCase();
        const onclick = (el.getAttribute('onclick') || '').toLowerCase();
        const dataAttrs = Array.from(el.attributes)
          .filter(attr => attr.name.startsWith('data-'))
          .map(attr => attr.value.toLowerCase())
          .join(' ');
        
        // Also check images inside the element
        const images = el.querySelectorAll('img');
        let imageSrcs = '';
        images.forEach(img => {
          imageSrcs += ' ' + (img.src || '') + ' ' + (img.alt || '');
        });
        imageSrcs = imageSrcs.toLowerCase();
        
        // Combined content to search
        const searchContent = outerHtml + ' ' + href + ' ' + onclick + ' ' + dataAttrs + ' ' + imageSrcs;
        
        for (const kw of kws) {
          if (seenKeywords.has(kw)) continue;
          
          if (searchContent.includes(kw)) {
            seenKeywords.add(kw);
            found.push({
              keyword: kw,
              type: 'deep-scan',
              priority: 55,
              coordinates: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
              source: 'deep-scan',
              element: {
                tag: el.tagName.toLowerCase(),
                classes: el.className
              }
            });
          }
        }
      }
      
      return found;
    }, scriptKeywordsToFind);
    
    // Add deep-scan found elements (these have coordinates!)
    for (const item of additionalSwitchers) {
      if (!existingKeywords.has(item.keyword.toLowerCase())) {
        existingKeywords.add(item.keyword.toLowerCase());
        switchers.push(item);
      }
    }
  }
  
  // Add remaining script-detected keywords that still couldn't find clickable elements
  for (const item of scriptAndHtmlKeywords) {
    if (!existingKeywords.has(item.keyword.toLowerCase())) {
      existingKeywords.add(item.keyword.toLowerCase());
      switchers.push({
        keyword: item.keyword,
        type: 'script-detected',
        priority: 50, // Lower priority since no visible element found
        coordinates: null, // No coordinates - will need API or dynamic detection
        source: item.source,
        requiresSpecialHandling: true
      });
    }
  }
  
  if (switchers.length > 0) {
    log('CLICK', `Found ${switchers.length} site switcher(s):`);
    switchers.forEach(s => log('CLICK', `  - ${s.keyword} (${s.type}, priority: ${s.priority})`));
  } else {
    log('CLICK', 'No site switchers found');
  }
  
  // DEDUPLICATION: Remove switchers whose keyword is a substring of another switcher's keyword
  // Example: if both "rainbet" and "rain" are found, remove "rain" since it matches inside "rainbet"
  // This prevents clicking the same element multiple times with different keyword names
  const allKeywords = switchers.map(s => s.keyword.toLowerCase());
  const dedupedSwitchers = switchers.filter(switcher => {
    const kw = switcher.keyword.toLowerCase();
    // Check if this keyword is a substring of a LONGER keyword
    const isSubstringOfAnother = allKeywords.some(other => {
      if (other === kw) return false; // Don't compare with self
      // Only filter if 'kw' appears inside a longer 'other' keyword
      return other.length > kw.length && other.includes(kw);
    });

    if (isSubstringOfAnother) {
      log('CLICK', `Filtering out ${switcher.keyword} with invalid coords: substring_of_longer_keyword`);
    }
    return !isSubstringOfAnother;
  });

  return dedupedSwitchers;
}

// ============================================================================
// OCR DETECTION
// ============================================================================

/**
 * Detect site names via OCR in the switcher region
 * @param {Page} page - Playwright page instance
 * @param {Array} keywords - Keywords to search for
 * @param {string} tempDir - Directory for temporary files
 * @returns {Array} - Found keywords
 */
async function detectSiteNamesViaOCR(page, keywords, tempDir) {
  log('DOM', 'Running OCR scan for site names in images/SVGs...');
  
  const switcherRegion = await page.evaluate(() => {
    const selectors = [
      '[class*="slider"]',
      '[class*="switcher"]', 
      '[class*="tab"]',
      '[class*="button-group"]',
      '[class*="site-select"]',
      '[class*="leaderboard"] [class*="header"]',
      '[class*="leaderboard"] [class*="nav"]'
    ];
    
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 200 && rect.height > 30 && rect.height < 300) {
            return { 
              x: Math.max(0, rect.x - 10), 
              y: Math.max(0, rect.y - 10), 
              width: Math.min(rect.width + 20, window.innerWidth), 
              height: Math.min(rect.height + 20, 400) 
            };
          }
        }
      } catch (e) {}
    }
    
    return { x: 0, y: 100, width: window.innerWidth, height: 400 };
  });
  
  const screenshotPath = path.join(tempDir, `temp-ocr-switcher-${Date.now()}.png`);
  
  try {
    await page.screenshot({
      path: screenshotPath,
      clip: switcherRegion
    });
    
    const result = await Tesseract.recognize(screenshotPath, 'eng', {
      logger: () => {}
    });
    
    const ocrText = result.data.text.toLowerCase();
    log('DOM', `OCR text found: "${ocrText.substring(0, 100).replace(/\n/g, ' ')}..."`);
    
    const foundKeywords = keywords.filter(kw => ocrText.includes(kw.toLowerCase()));
    
    if (fs.existsSync(screenshotPath)) {
      fs.unlinkSync(screenshotPath);
    }
    
    if (foundKeywords.length > 0) {
      log('DOM', `OCR found site names: ${foundKeywords.join(', ')}`);
    } else {
      log('DOM', 'OCR found no matching site names');
    }
    
    return foundKeywords;
  } catch (err) {
    log('ERR', `OCR site detection failed: ${err.message}`);
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    return [];
  }
}

/**
 * Thorough HTML scan for site keywords
 * @param {Page} page - Playwright page instance
 * @param {Array} keywords - Keywords to search for
 * @returns {Array} - Found keywords
 */
async function thoroughHtmlScanForKeywords(page, keywords) {
  return await page.evaluate((kws) => {
    const found = new Set();
    const kwsLower = kws.map(k => k.toLowerCase());

    /**
     * Check if keyword matches with word boundaries
     * Prevents "rain" matching inside "rainbet" or "terrain"
     * Allows common separators: space, -, _, /, ., quotes, brackets, etc.
     */
    function matchesWithBoundary(text, keyword) {
      // Escape special regex characters in keyword
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Word boundary pattern - keyword must be standalone or separated by common delimiters
      const pattern = new RegExp(`(?:^|[\\s\\-_/\\.>"'\\[\\(])${escaped}(?:[\\s\\-_/\\.<"'\\]\\)]|$)`, 'i');
      return pattern.test(text);
    }

    // Full HTML scan with word boundary matching
    const fullHtml = document.documentElement.outerHTML.toLowerCase();
    for (const kw of kwsLower) {
      if (matchesWithBoundary(fullHtml, kw)) {
        found.add(kw);
      }
    }

    // Image sources (URLs can use simple includes - keyword in URL path is specific)
    const images = document.querySelectorAll('img, image, source');
    for (const img of images) {
      const src = (img.src || img.getAttribute('xlink:href') || img.srcset || '').toLowerCase();
      for (const kw of kwsLower) {
        // For URLs, check if keyword appears as path segment (between slashes)
        const urlPattern = new RegExp(`[/\\-_.]${kw}[/\\-_.]|[/\\-_.]${kw}$|^${kw}[/\\-_.]`, 'i');
        if (urlPattern.test(src)) found.add(kw);
      }
    }

    // SVG content with word boundary matching
    const svgs = document.querySelectorAll('svg');
    for (const svg of svgs) {
      const svgContent = svg.innerHTML.toLowerCase();
      for (const kw of kwsLower) {
        if (matchesWithBoundary(svgContent, kw)) found.add(kw);
      }
    }

    // Element attributes - check text content and specific attributes with boundaries
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      try {
        // Check visible text content for exact keyword match
        const textContent = (el.textContent || '').toLowerCase();
        for (const kw of kwsLower) {
          if (matchesWithBoundary(textContent, kw)) found.add(kw);
        }

        // Check href and data attributes (URLs/identifiers)
        for (const attr of el.attributes || []) {
          if (attr.name === 'href' || attr.name.startsWith('data-')) {
            const attrValue = (attr.value || '').toLowerCase();
            for (const kw of kwsLower) {
              // URL-style matching for hrefs
              const urlPattern = new RegExp(`[/\\-_.]${kw}[/\\-_.]|[/\\-_.]${kw}$|/${kw}\\?|/${kw}#`, 'i');
              if (urlPattern.test(attrValue) || matchesWithBoundary(attrValue, kw)) {
                found.add(kw);
              }
            }
          }
        }
      } catch (e) {}
    }

    // CSS background images (URL matching)
    for (const el of allElements) {
      try {
        const style = window.getComputedStyle(el);
        const bgImage = style.backgroundImage.toLowerCase();
        if (bgImage && bgImage !== 'none') {
          for (const kw of kwsLower) {
            const urlPattern = new RegExp(`[/\\-_.]${kw}[/\\-_.]|[/\\-_.]${kw}[\\)"']`, 'i');
            if (urlPattern.test(bgImage)) found.add(kw);
          }
        }
      } catch (e) {}
    }

    // Script contents - be conservative, only match clear references
    const scripts = document.querySelectorAll('script:not([src])');
    for (const script of scripts) {
      const content = (script.textContent || '').toLowerCase();
      for (const kw of kwsLower) {
        // Match keyword in quotes (string literal) or as object key
        const scriptPattern = new RegExp(`["'\`]${kw}["'\`]|\\b${kw}\\s*:|:\\s*["'\`]${kw}["'\`]`, 'i');
        if (scriptPattern.test(content)) found.add(kw);
      }
    }

    return Array.from(found);
  }, keywords);
}

// ============================================================================
// TIMER DETECTION
// ============================================================================

/**
 * Detect active countdown timers by observing DOM changes
 * @param {Page} page - Playwright page instance
 * @param {Object} timerConfig - Timer detection configuration
 * @returns {string|null} - Timer text or null
 */
async function detectActiveTimers(page, timerConfig = {}) {
  const {
    observationPeriodMs = 5000,
    minChanges = 3,
    intervalToleranceMs = 200
  } = timerConfig;
  
  log('TIMER', `Observing page for ${observationPeriodMs}ms to detect timers...`);
  
  const timerData = await page.evaluate(async (config) => {
    const { observationPeriodMs, minChanges, intervalToleranceMs } = config;
    const candidates = new Map();
    
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        let target = null;
        let newValue = null;
        
        if (mutation.type === 'characterData') {
          target = mutation.target.parentElement;
          newValue = mutation.target.textContent;
        } else if (mutation.type === 'childList') {
          const textNodesAdded = [...mutation.addedNodes].filter(n => n.nodeType === 3);
          if (textNodesAdded.length > 0) {
            target = mutation.target;
            newValue = textNodesAdded[0]?.textContent;
          }
        }
        
        if (target && newValue) {
          if (!candidates.has(target)) {
            candidates.set(target, { changes: [], element: target });
          }
          candidates.get(target).changes.push({
            text: newValue.trim(),
            time: Date.now()
          });
        }
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: true
    });
    
    await new Promise(resolve => setTimeout(resolve, observationPeriodMs));
    observer.disconnect();
    
    const results = [];
    candidates.forEach((data, el) => {
      if (data.changes.length < minChanges) return;
      
      const intervals = data.changes.slice(1).map((c, i) =>
        c.time - data.changes[i].time
      );
      
      if (intervals.length < 2) return;
      
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const isRegular = intervals.every(i => Math.abs(i - avgInterval) < intervalToleranceMs);
      
      const latestText = data.changes[data.changes.length - 1].text;
      const hasTimeFormat = /(\d+\s*[dhms:])+/i.test(latestText) ||
                           /\d{1,2}:\d{2}/.test(latestText);
      
      const isSecondInterval = avgInterval >= 800 && avgInterval <= 1200;
      
      if (isRegular && hasTimeFormat && isSecondInterval) {
        const fullText = el.textContent?.trim() || latestText;
        
        results.push({
          text: fullText,
          avgInterval: Math.round(avgInterval),
          changeCount: data.changes.length,
          confidence: (isRegular ? 0.4 : 0) + (hasTimeFormat ? 0.4 : 0) + (isSecondInterval ? 0.2 : 0)
        });
      }
    });
    
    return results;
  }, {
    observationPeriodMs,
    minChanges,
    intervalToleranceMs
  });
  
  if (timerData.length > 0) {
    timerData.sort((a, b) => b.confidence - a.confidence);
    const best = timerData[0];
    log('TIMER', `Detected active timer: "${best.text}" (confidence: ${best.confidence})`);
    return best.text;
  }
  
  log('TIMER', 'No active timer detected via observation, falling back to regex...');
  return await extractTimerFallback(page);
}

/**
 * Fallback timer extraction using regex
 * @param {Page} page - Playwright page instance
 * @returns {string|null} - Timer text or null
 */
async function extractTimerFallback(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    
    const dhmsMatch = text.match(/(\d+)\s*\n?\s*D\s*\n?\s*(\d+)\s*\n?\s*H\s*\n?\s*(\d+)\s*\n?\s*M\s*\n?\s*(\d+)\s*\n?\s*S/i);
    if (dhmsMatch) {
      return `${dhmsMatch[1]}d ${dhmsMatch[2]}h ${dhmsMatch[3]}m ${dhmsMatch[4]}s`;
    }
    
    const structuredMatch = text.match(/(\d+)\s*\n?\s*DAYS[\s\nD]*(\d+)\s*\n?\s*HOURS[\s\nH]*(\d+)\s*\n?\s*MINUTES[\s\nM]*(\d+)\s*\n?\s*SECONDS/i);
    if (structuredMatch) {
      return `${structuredMatch[1]}d ${structuredMatch[2]}h ${structuredMatch[3]}m ${structuredMatch[4]}s`;
    }
    
    const standardMatch = text.match(/(\d+)\s*[Dd]ays?\s*(\d+):(\d+):(\d+)/);
    if (standardMatch) {
      return `${standardMatch[1]}d ${standardMatch[2]}:${standardMatch[3]}:${standardMatch[4]}`;
    }
    
    const labeledMatch = text.match(/(\d+)\s*Days?\s*(\d+)\s*Hours?\s*(\d+)\s*Min(?:utes?)?\s*(\d+)\s*Sec(?:onds?)?/i);
    if (labeledMatch) {
      return `${labeledMatch[1]}d ${labeledMatch[2]}h ${labeledMatch[3]}m ${labeledMatch[4]}s`;
    }
    
    const timeMatch = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (timeMatch) {
      return `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`;
    }
    
    const daysMatch = text.match(/(\d+)\s*days?\s*(left|remaining)?/i);
    if (daysMatch) {
      return `${daysMatch[1]}d`;
    }
    
    return null;
  });
}

// ============================================================================
// URL-BASED SITE SWITCHING
// ============================================================================

/**
 * Detect if the current URL has a pattern that allows site-based navigation
 * Examples:
 * - example.com/leaderboard/shuffle → pattern: /leaderboard/{site}
 * - example.com/affiliate/gamdom/leaderboard → pattern: /affiliate/{site}/leaderboard
 * - example.com?site=packdraw → pattern: ?site={site}
 * 
 * @param {string} currentUrl - The current page URL
 * @param {Array} keywords - Known site keywords
 * @returns {Object|null} - URL pattern info or null
 */
function detectUrlSitePattern(currentUrl, keywords) {
  try {
    const url = new URL(currentUrl);
    const pathname = url.pathname.toLowerCase();
    const search = url.search.toLowerCase();
    
    const keywordsLower = keywords.map(k => k.toLowerCase());
    
    // Check for site name in URL path
    for (const keyword of keywordsLower) {
      const pathIndex = pathname.indexOf(keyword);
      if (pathIndex !== -1) {
        // Found keyword in path - determine the pattern
        const beforeKeyword = pathname.substring(0, pathIndex);
        const afterKeyword = pathname.substring(pathIndex + keyword.length);
        
        return {
          type: 'path',
          pattern: `${beforeKeyword}{SITE}${afterKeyword}`,
          baseUrl: `${url.origin}${beforeKeyword}`,
          suffix: afterKeyword,
          detectedSite: keyword,
          fullUrl: currentUrl
        };
      }
      
      // Check query parameters
      if (search.includes(keyword)) {
        const params = new URLSearchParams(url.search);
        for (const [key, value] of params.entries()) {
          if (value.toLowerCase() === keyword) {
            return {
              type: 'query',
              pattern: `${url.origin}${url.pathname}?${key}={SITE}`,
              baseUrl: `${url.origin}${url.pathname}`,
              paramName: key,
              detectedSite: keyword,
              fullUrl: currentUrl
            };
          }
        }
      }
    }
    
    // Check for common patterns even without keyword match
    const patterns = [
      /\/leaderboard[s]?\/([a-zA-Z0-9_-]+)/i,
      /\/affiliate\/([a-zA-Z0-9_-]+)\/leaderboard/i,
      /\/partner\/([a-zA-Z0-9_-]+)/i,
      /\/([a-zA-Z0-9_-]+)\/leaderboard[s]?/i
    ];
    
    for (const pattern of patterns) {
      const match = pathname.match(pattern);
      if (match && match[1]) {
        const siteName = match[1].toLowerCase();
        // Verify it's not a common path segment
        if (!['view', 'show', 'all', 'list', 'current', 'previous', 'history'].includes(siteName)) {
          const fullMatch = match[0];
          const templatePath = pathname.replace(siteName, '{SITE}');
          
          return {
            type: 'path',
            pattern: templatePath,
            baseUrl: url.origin,
            detectedSite: siteName,
            fullUrl: currentUrl
          };
        }
      }
    }
    
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Construct URLs for all detected sites based on a URL pattern
 * @param {Object} urlPattern - Pattern from detectUrlSitePattern
 * @param {Array} siteNames - List of site names to generate URLs for
 * @returns {Array} - Array of { siteName, url } objects
 */
function constructSiteUrls(urlPattern, siteNames) {
  if (!urlPattern) return [];
  
  const urls = [];
  
  for (const site of siteNames) {
    let siteUrl;
    
    if (urlPattern.type === 'path') {
      siteUrl = urlPattern.baseUrl + urlPattern.pattern.replace('{SITE}', site);
      if (urlPattern.suffix && !urlPattern.pattern.includes(urlPattern.suffix)) {
        siteUrl += urlPattern.suffix;
      }
    } else if (urlPattern.type === 'query') {
      siteUrl = urlPattern.pattern.replace('{SITE}', site);
    }
    
    if (siteUrl) {
      urls.push({
        siteName: site,
        url: siteUrl
      });
    }
  }
  
  return urls;
}

/**
 * Detect all site names from the page (combining multiple methods)
 * Used when we need to find all possible sites to construct URLs for
 * @param {Page} page - Playwright page instance
 * @param {Array} keywords - Known keywords
 * @returns {Array} - Array of detected site names
 */
async function detectAllSiteNames(page, keywords) {
  const detectedSites = new Set();

  // 1. Find from site switchers
  const switchers = await findSiteSwitchers(page, keywords);
  for (const sw of switchers) {
    if (sw.keyword) {
      detectedSites.add(sw.keyword.toLowerCase());
    }
  }

  // 2. Scan HTML for keywords
  const htmlKeywords = await thoroughHtmlScanForKeywords(page, keywords);
  for (const kw of htmlKeywords) {
    detectedSites.add(kw.toLowerCase());
  }

  // 3. OCR scan
  try {
    const ocrSites = await detectSiteNamesViaOCR(page, keywords);
    for (const site of ocrSites) {
      detectedSites.add(site.toLowerCase());
    }
  } catch (e) {
    // OCR failed, continue without it
  }

  // 4. DEDUPLICATION: Remove keywords that are substrings of other longer keywords
  // Example: if both "stake" and "rostake" are found, keep only "rostake"
  // This prevents duplicate leaderboards from the same URL
  const sitesArray = Array.from(detectedSites);
  const deduped = sitesArray.filter(site => {
    // Check if any other site contains this one as a substring
    const isSubstringOfAnother = sitesArray.some(other => {
      if (other === site) return false; // Don't compare with self
      // Check if 'site' appears at the end of 'other' (e.g., "stake" in "rostake")
      // or if 'other' contains 'site' as part of a compound word
      return other.length > site.length && other.includes(site);
    });

    if (isSubstringOfAnother) {
      log('DETECT', `Filtering out "${site}" - it's a substring of another detected keyword`);
    }
    return !isSubstringOfAnother;
  });

  return deduped;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Fingerprinting
  generateContentFingerprint,
  waitForContentChange,
  
  // Coordinate validation
  validateCoordinates,
  groupSwitchersBySpatialProximity,
  findBestSwitcherForKeyword,
  
  // Site switcher detection
  findSiteSwitchers,
  
  // OCR
  detectSiteNamesViaOCR,
  thoroughHtmlScanForKeywords,
  
  // Timer detection
  detectActiveTimers,
  extractTimerFallback,
  
  // URL-based navigation
  detectUrlSitePattern,
  constructSiteUrls,
  detectAllSiteNames
};
