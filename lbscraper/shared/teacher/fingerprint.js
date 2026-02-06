/**
 * Layout Fingerprinting for Teacher Mode
 * 
 * Generates fingerprints of page layouts to detect when sites change.
 * When a verified site's fingerprint changes significantly,
 * it triggers re-verification by the LLM.
 */

const crypto = require('crypto');

// ============================================================================
// FINGERPRINT GENERATION
// ============================================================================

/**
 * Generate a layout fingerprint for the current page
 * @param {Page} page - Playwright page instance
 * @param {Array} keywords - Site keywords to look for
 * @returns {Object} - Layout fingerprint
 */
async function generateLayoutFingerprint(page, keywords) {
  const elements = await page.evaluate((kw) => {
    const result = {
      switcherCount: 0,
      switcherNames: [],
      layoutType: 'unknown',
      entryCount: 0,
      hasPodium: false,
      hasTable: false,
      structuralElements: []
    };
    
    // Find site switchers
    const keywordsLower = kw.map(k => k.toLowerCase());
    const allClickables = document.querySelectorAll('button, [role="button"], [tabindex="0"], a, [class*="tab"], [class*="switch"]');
    
    for (const el of allClickables) {
      const text = (el.textContent || '').toLowerCase();
      const html = el.outerHTML.toLowerCase();
      
      for (const keyword of keywordsLower) {
        if (text.includes(keyword) || html.includes(keyword)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 20 && rect.width < 400) {
            result.switcherCount++;
            if (!result.switcherNames.includes(keyword)) {
              result.switcherNames.push(keyword);
            }
            break;
          }
        }
      }
    }
    
    // Detect podium (top 3 cards)
    const podiumSelectors = [
      '[class*="podium"]',
      '[class*="winner"]',
      '[class*="top-3"]',
      '[class*="top3"]',
      '[class*="first-place"]',
      '[class*="card"][class*="rank"]'
    ];
    
    for (const selector of podiumSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length >= 2 && elements.length <= 4) {
        result.hasPodium = true;
        break;
      }
    }
    
    // Detect table
    const tableSelectors = [
      'table[class*="leaderboard"]',
      'table[class*="ranking"]',
      '[class*="leaderboard"] table',
      '[class*="entry-list"]',
      '[class*="entries"]'
    ];
    
    for (const selector of tableSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        result.hasTable = true;
        break;
      }
    }
    
    // Count leaderboard entries
    const entrySelectors = [
      '[class*="entry"]',
      '[class*="row"][class*="leader"]',
      '[class*="player"]',
      'tr[class*="rank"]'
    ];
    
    for (const selector of entrySelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length >= 3) {
        result.entryCount = elements.length;
        break;
      }
    }
    
    // Determine layout type
    if (result.hasPodium && result.hasTable) {
      result.layoutType = 'podium-table';
    } else if (result.hasPodium) {
      result.layoutType = 'podium-only';
    } else if (result.hasTable) {
      result.layoutType = 'table-only';
    } else if (result.entryCount > 0) {
      result.layoutType = 'list';
    }
    
    // Collect structural elements for hashing
    const structuralSelectors = [
      '[class*="leaderboard"]',
      '[class*="container"]',
      '[class*="wrapper"]',
      'main',
      '[role="main"]'
    ];
    
    for (const selector of structuralSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 100) {
          result.structuralElements.push({
            tag: el.tagName.toLowerCase(),
            classes: (el.className || '').split(' ').slice(0, 3).join(' '),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
        }
      }
    }
    
    // Limit structural elements
    result.structuralElements = result.structuralElements.slice(0, 10);
    
    return result;
  }, keywords);
  
  // Generate hash
  const hashInput = JSON.stringify({
    switcherCount: elements.switcherCount,
    switcherNames: elements.switcherNames.sort(),
    layoutType: elements.layoutType,
    structuralElements: elements.structuralElements
  });
  
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
  
  return {
    hash,
    switcherCount: elements.switcherCount,
    switcherNames: elements.switcherNames,
    layoutType: elements.layoutType,
    entryCount: elements.entryCount,
    hasPodium: elements.hasPodium,
    hasTable: elements.hasTable,
    generatedAt: new Date().toISOString()
  };
}

// ============================================================================
// CHANGE DETECTION
// ============================================================================

/**
 * Check if layout has changed significantly
 * @param {Object} storedFingerprint - Previously stored fingerprint
 * @param {Object} currentFingerprint - Current fingerprint
 * @returns {Object} - { changed, reason, significance }
 */
function hasLayoutChanged(storedFingerprint, currentFingerprint) {
  if (!storedFingerprint) {
    return { changed: false, reason: 'no_previous_fingerprint', significance: 'none' };
  }
  
  if (!currentFingerprint) {
    return { changed: false, reason: 'no_current_fingerprint', significance: 'none' };
  }
  
  const changes = [];
  
  // Check hash (quick overall comparison)
  if (storedFingerprint.hash !== currentFingerprint.hash) {
    // Hash changed, investigate why
    
    // Check switcher count change
    if (storedFingerprint.switcherCount !== currentFingerprint.switcherCount) {
      const diff = Math.abs(storedFingerprint.switcherCount - currentFingerprint.switcherCount);
      changes.push({
        type: 'switcher_count',
        from: storedFingerprint.switcherCount,
        to: currentFingerprint.switcherCount,
        significance: diff >= 2 ? 'high' : 'low'
      });
    }
    
    // Check layout type change
    if (storedFingerprint.layoutType !== currentFingerprint.layoutType) {
      changes.push({
        type: 'layout_type',
        from: storedFingerprint.layoutType,
        to: currentFingerprint.layoutType,
        significance: 'high'
      });
    }
    
    // Check for new switcher names
    const storedNames = new Set(storedFingerprint.switcherNames || []);
    const currentNames = new Set(currentFingerprint.switcherNames || []);
    
    const newNames = [...currentNames].filter(n => !storedNames.has(n));
    const removedNames = [...storedNames].filter(n => !currentNames.has(n));
    
    if (newNames.length > 0) {
      changes.push({
        type: 'new_switchers',
        names: newNames,
        significance: newNames.length >= 2 ? 'high' : 'medium'
      });
    }
    
    if (removedNames.length > 0) {
      changes.push({
        type: 'removed_switchers',
        names: removedNames,
        significance: removedNames.length >= 2 ? 'high' : 'medium'
      });
    }
  }
  
  if (changes.length === 0) {
    return { changed: false, reason: 'no_significant_changes', significance: 'none' };
  }
  
  // Determine overall significance
  const hasHighSignificance = changes.some(c => c.significance === 'high');
  const hasMediumSignificance = changes.some(c => c.significance === 'medium');
  
  let overallSignificance = 'low';
  if (hasHighSignificance) overallSignificance = 'high';
  else if (hasMediumSignificance) overallSignificance = 'medium';
  
  return {
    changed: true,
    reason: changes.map(c => c.type).join(', '),
    significance: overallSignificance,
    changes
  };
}

/**
 * Determine if layout change should trigger re-verification
 * @param {Object} changeResult - Result from hasLayoutChanged
 * @returns {boolean}
 */
function shouldReVerify(changeResult) {
  if (!changeResult.changed) return false;
  
  // Re-verify on high significance changes
  if (changeResult.significance === 'high') return true;
  
  // Re-verify if layout type changed
  const hasLayoutTypeChange = changeResult.changes?.some(c => c.type === 'layout_type');
  if (hasLayoutTypeChange) return true;
  
  // Re-verify if multiple switchers added
  const newSwitchers = changeResult.changes?.find(c => c.type === 'new_switchers');
  if (newSwitchers && newSwitchers.names.length >= 2) return true;
  
  return false;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  generateLayoutFingerprint,
  hasLayoutChanged,
  shouldReVerify
};
