/**
 * Site Profiles for LLM Teacher Mode
 * 
 * Manages persistent site learning data.
 * Each domain has its own JSON profile storing:
 * - Status (new, learning, verified, flagged)
 * - LLM-generated rules (selectors, patterns)
 * - Attempt tracking
 * - Layout fingerprints
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils');

// ============================================================================
// CONSTANTS
// ============================================================================

const PROFILE_STATUSES = {
  NEW: 'new',
  PENDING_VERIFICATION: 'pending_verification',
  LEARNING: 'learning',
  VERIFIED: 'verified',
  FLAGGED_FOR_REVIEW: 'flagged_for_review',
  LAYOUT_CHANGED: 'layout_changed'
};

const DEFAULT_MAX_ATTEMPTS = 3;

// ============================================================================
// HELPERS
// ============================================================================

function getProfilesDir(basePath) {
  return path.join(basePath, 'data', 'site-profiles');
}

function getProfilePath(basePath, domain) {
  const sanitizedDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '_');
  return path.join(getProfilesDir(basePath), `${sanitizedDomain}.json`);
}

function getFlaggedSitesPath(basePath) {
  return path.join(basePath, 'data', 'flagged-sites.json');
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ============================================================================
// PROFILE STRUCTURE
// ============================================================================

/**
 * Create empty profile for a new domain
 * @param {string} domain - Domain name
 * @returns {Object} - Empty profile
 */
function createEmptyProfile(domain) {
  return {
    domain,
    status: PROFILE_STATUSES.NEW,
    attempts: 0,
    maxAttempts: parseInt(process.env.LLM_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS,
    llmDisabled: false,
    llmCostTotal: 0.00,
    
    // Verification info
    verification: {
      firstVerifiedAt: null,
      lastVerifiedAt: null,
      verifiedByLlm: false,
      llmConfidence: 0
    },
    
    // Layout fingerprint for change detection
    layoutFingerprint: {
      hash: null,
      switcherCount: 0,
      switcherNames: [],
      layoutType: null,
      generatedAt: null
    },
    
    // Navigation info
    navigation: {
      leaderboardPath: null,
      authRequired: false
    },
    
    // LLM-discovered site switchers
    switchers: [],
    
    // LLM-discovered extraction rules
    extraction: {
      containerSelector: null,
      entrySelector: null,
      fields: {
        rank: null,
        username: null,
        wager: null,
        prize: null
      }
    },
    
    // API patterns
    apiPatterns: {
      entriesEndpoint: null,
      prizesEndpoint: null,
      siteParamFormat: null
    },
    
    // Full extraction configuration (Learn Once, Run Forever)
    // Once discovered, this config is reused without LLM
    extractionConfig: {
      method: null,  // "api" | "dom" | "hybrid"
      discoveredAt: null,
      discoveredBy: null,  // "llm" | "auto" | "manual"
      
      // API Configuration (if method = "api" or "hybrid")
      apiConfig: {
        baseUrl: null,
        endpoints: {
          providers: null,       // e.g., "/leaderboard/active-leaderboard-providers"
          leaderboardList: null, // e.g., "/leaderboard/list-winner/{SITE}/public?skip=0&take={TAKE}"
          leaderboardDetails: null, // e.g., "/leaderboard-user/leaderboard-leaders?leaderboardId={ID}"
          historical: null       // e.g., "/leaderboard/previous?site={SITE}&month={MONTH}&year={YEAR}"
        },
        substitutionRules: {},   // e.g., { "{SITE}": { source: "keywords", transform: "uppercase" } }
        authRequired: false,
        headers: {}
      },
      
      // DOM Configuration (if method = "dom" or "hybrid")
      domConfig: {
        containerSelector: null,
        entrySelector: null,
        fields: {
          rank: null,
          username: null,
          wager: null,
          prize: null
        }
      },
      
      // Button click sequence (if site requires interaction)
      clickSequence: [],  // e.g., [{ action: "click", selector: "[data-site='{SITE}']" }]
      
      // Discovered keywords/providers for this site
      knownProviders: [],
      
      // Historical farming config
      historicalConfig: {
        supported: false,
        minYear: 2025,
        minMonth: 1,
        method: null  // "month-year-params" | "id-based" | "pagination"
      }
    },
    
    // Data source preference per leaderboard (from LLM comparison)
    dataSourcePreference: {},
    // Format: { "luxdrop": { source: "api", reason: "...", decidedAt: "..." } }
    
    // LLM observations and notes
    llmObservations: [],
    
    // History of corrections
    corrections: [],
    
    // Inactive leaderboards (failed to load or don't exist)
    inactiveLeaderboards: [],
    // Format: [{ name, reason, lastChecked, failCount }]
    
    // Multi-path scan results
    pathScanResults: {
      bestPath: null,
      lastScannedAt: null,
      pathResults: []
    },
    
    // URL pattern for direct navigation (e.g., /leaderboard/{keyword})
    urlPattern: {
      pattern: null,        // e.g., '/leaderboard/{keyword}'
      baseUrl: null,        // e.g., 'https://example.com'
      discoveredAt: null,
      examples: []          // e.g., [{ keyword: 'csgoroll', url: '/leaderboard/csgoroll' }]
    },
    
    // Visual verification
    lastScreenshotVerifyAt: null,
    lastVisualVerification: null,
    
    // Metadata
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Get site profile, creating if doesn't exist
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {Object} - Site profile
 */
function getSiteProfile(basePath, domain) {
  // Input validation
  if (!basePath || typeof basePath !== 'string') {
    throw new Error('basePath is required and must be a string');
  }
  if (!domain || typeof domain !== 'string') {
    throw new Error('domain is required and must be a string');
  }
  
  const profilePath = getProfilePath(basePath, domain);
  
  try {
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      return profile;
    }
  } catch (err) {
    log('ERR', `Failed to load profile for ${domain}: ${err.message}`);
  }
  
  // Create new profile
  log('PROFILE', `Creating new profile for ${domain}`);
  const newProfile = createEmptyProfile(domain);
  saveSiteProfile(basePath, newProfile);
  return newProfile;
}

/**
 * Save site profile
 * @param {string} basePath - Base path to lbscraper directory
 * @param {Object} profile - Profile to save
 */
function saveSiteProfile(basePath, profile) {
  ensureDirectoryExists(getProfilesDir(basePath));
  const profilePath = getProfilePath(basePath, profile.domain);
  
  try {
    profile.updatedAt = new Date().toISOString();
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  } catch (err) {
    log('ERR', `Failed to save profile for ${profile.domain}: ${err.message}`);
  }
}

/**
 * Update site profile with partial updates
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {Object} updates - Partial updates to apply
 * @returns {Object} - Updated profile
 */
function updateSiteProfile(basePath, domain, updates) {
  // Input validation
  if (!basePath || typeof basePath !== 'string') {
    throw new Error('basePath is required and must be a string');
  }
  if (!domain || typeof domain !== 'string') {
    throw new Error('domain is required and must be a string');
  }
  if (!updates || typeof updates !== 'object') {
    throw new Error('updates is required and must be an object');
  }
  
  const profile = getSiteProfile(basePath, domain);
  
  // Deep merge updates
  const merged = deepMerge(profile, updates);
  merged.updatedAt = new Date().toISOString();
  
  saveSiteProfile(basePath, merged);
  return merged;
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const output = { ...target };
  
  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (target[key] && typeof target[key] === 'object') {
        output[key] = deepMerge(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    } else {
      output[key] = source[key];
    }
  }
  
  return output;
}

// ============================================================================
// STATUS MANAGEMENT
// ============================================================================

/**
 * Set site status with validation
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} status - New status
 * @returns {Object} - Updated profile
 */
function setSiteStatus(basePath, domain, status) {
  if (!Object.values(PROFILE_STATUSES).includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  
  log('PROFILE', `Setting ${domain} status to: ${status}`);
  return updateSiteProfile(basePath, domain, { status });
}

/**
 * Increment LLM attempts for a site
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {Object} - { attempts, maxReached }
 */
function incrementAttempts(basePath, domain) {
  const profile = getSiteProfile(basePath, domain);
  const newAttempts = profile.attempts + 1;
  
  updateSiteProfile(basePath, domain, { 
    attempts: newAttempts,
    status: PROFILE_STATUSES.LEARNING
  });
  
  log('PROFILE', `${domain} attempt ${newAttempts}/${profile.maxAttempts}`);
  
  return {
    attempts: newAttempts,
    maxReached: newAttempts >= profile.maxAttempts
  };
}

/**
 * Add LLM cost to site's total
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {number} cost - Cost in USD
 */
function addLlmCost(basePath, domain, cost) {
  const profile = getSiteProfile(basePath, domain);
  updateSiteProfile(basePath, domain, { 
    llmCostTotal: (profile.llmCostTotal || 0) + cost 
  });
}

// ============================================================================
// FLAGGING
// ============================================================================

/**
 * Flag site for manual review
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} reason - Reason for flagging
 */
function flagForManualReview(basePath, domain, reason) {
  log('PROFILE', `Flagging ${domain} for manual review: ${reason}`);
  
  // Update profile
  updateSiteProfile(basePath, domain, {
    status: PROFILE_STATUSES.FLAGGED_FOR_REVIEW,
    llmDisabled: true
  });
  
  // Add to flagged sites list
  const flaggedPath = getFlaggedSitesPath(basePath);
  let flagged = [];
  
  try {
    if (fs.existsSync(flaggedPath)) {
      flagged = JSON.parse(fs.readFileSync(flaggedPath, 'utf8'));
    }
  } catch (err) {
    // Start fresh
  }
  
  // Add or update entry
  const existingIndex = flagged.findIndex(f => f.domain === domain);
  const entry = {
    domain,
    reason,
    flaggedAt: new Date().toISOString(),
    resolved: false
  };
  
  if (existingIndex >= 0) {
    flagged[existingIndex] = entry;
  } else {
    flagged.push(entry);
  }
  
  ensureDirectoryExists(path.dirname(flaggedPath));
  fs.writeFileSync(flaggedPath, JSON.stringify(flagged, null, 2));
}

/**
 * Reset site for LLM (admin function)
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 */
function resetSiteForLLM(basePath, domain) {
  log('PROFILE', `Resetting ${domain} for LLM re-verification`);
  
  updateSiteProfile(basePath, domain, {
    status: PROFILE_STATUSES.LEARNING,
    attempts: 0,
    llmDisabled: false
  });
  
  // Remove from flagged list
  const flaggedPath = getFlaggedSitesPath(basePath);
  try {
    if (fs.existsSync(flaggedPath)) {
      let flagged = JSON.parse(fs.readFileSync(flaggedPath, 'utf8'));
      flagged = flagged.filter(f => f.domain !== domain);
      fs.writeFileSync(flaggedPath, JSON.stringify(flagged, null, 2));
    }
  } catch (err) {
    // Ignore
  }
}

// ============================================================================
// INACTIVE LEADERBOARD TRACKING
// ============================================================================

const INACTIVE_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Mark a leaderboard as inactive (failed to load or doesn't exist)
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Name of the inactive leaderboard
 * @param {string} reason - Why it's inactive
 */
function markLeaderboardInactive(basePath, domain, leaderboardName, reason) {
  const profile = getSiteProfile(basePath, domain);
  const inactiveList = profile.inactiveLeaderboards || [];
  
  const existingIndex = inactiveList.findIndex(
    lb => lb.name.toLowerCase() === leaderboardName.toLowerCase()
  );
  
  const now = new Date().toISOString();
  
  if (existingIndex >= 0) {
    // Update existing entry
    inactiveList[existingIndex].lastChecked = now;
    inactiveList[existingIndex].failCount = (inactiveList[existingIndex].failCount || 0) + 1;
    inactiveList[existingIndex].reason = reason;
  } else {
    // Add new entry
    inactiveList.push({
      name: leaderboardName,
      reason,
      lastChecked: now,
      failCount: 1,
      firstMarkedAt: now
    });
  }
  
  log('PROFILE', `Marked ${leaderboardName} as inactive on ${domain}: ${reason}`);
  updateSiteProfile(basePath, domain, { inactiveLeaderboards: inactiveList });
}

/**
 * Check if a leaderboard is currently marked as inactive
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Name to check
 * @returns {Object|null} - Inactive entry or null if active
 */
function getInactiveLeaderboard(basePath, domain, leaderboardName) {
  const profile = getSiteProfile(basePath, domain);
  const inactiveList = profile.inactiveLeaderboards || [];
  
  return inactiveList.find(
    lb => lb.name.toLowerCase() === leaderboardName.toLowerCase()
  ) || null;
}

/**
 * Check if an inactive leaderboard should be retried (>24h since last check)
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Name to check
 * @returns {boolean} - Whether to retry
 */
function shouldRetryInactiveLeaderboard(basePath, domain, leaderboardName) {
  const inactive = getInactiveLeaderboard(basePath, domain, leaderboardName);
  
  if (!inactive) {
    return true; // Not marked inactive, should try
  }
  
  const lastChecked = new Date(inactive.lastChecked).getTime();
  const now = Date.now();
  
  return (now - lastChecked) > INACTIVE_RETRY_COOLDOWN_MS;
}

/**
 * Remove a leaderboard from the inactive list (it's now working)
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Name to reactivate
 */
function reactivateLeaderboard(basePath, domain, leaderboardName) {
  const profile = getSiteProfile(basePath, domain);
  const inactiveList = profile.inactiveLeaderboards || [];
  
  const filtered = inactiveList.filter(
    lb => lb.name.toLowerCase() !== leaderboardName.toLowerCase()
  );
  
  if (filtered.length < inactiveList.length) {
    log('PROFILE', `Reactivated ${leaderboardName} on ${domain}`);
    updateSiteProfile(basePath, domain, { inactiveLeaderboards: filtered });
  }
}

/**
 * Get all inactive leaderboards for a domain
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {Array} - List of inactive leaderboards
 */
function getInactiveLeaderboards(basePath, domain) {
  const profile = getSiteProfile(basePath, domain);
  return profile.inactiveLeaderboards || [];
}

// ============================================================================
// VERIFICATION
// ============================================================================

/**
 * Mark site as verified by LLM
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {number} confidence - LLM confidence score
 */
function markAsVerified(basePath, domain, confidence) {
  const profile = getSiteProfile(basePath, domain);
  const now = new Date().toISOString();
  
  log('PROFILE', `Marking ${domain} as verified with confidence ${confidence}`);
  
  updateSiteProfile(basePath, domain, {
    status: PROFILE_STATUSES.VERIFIED,
    verification: {
      firstVerifiedAt: profile.verification.firstVerifiedAt || now,
      lastVerifiedAt: now,
      verifiedByLlm: true,
      llmConfidence: confidence
    }
  });
}

/**
 * Update profile from LLM response
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {Object} llmData - Parsed LLM response data
 * @param {number} confidence - Confidence score
 */
function updateProfileFromLLM(basePath, domain, llmData, confidence) {
  const updates = {};
  
  // Apply switcher rules
  if (llmData.switchers && llmData.switchers.length > 0) {
    updates.switchers = llmData.switchers;
  }
  
  // Apply extraction rules
  if (llmData.extraction) {
    updates.extraction = llmData.extraction;
  }
  
  // Apply API patterns
  if (llmData.apiPatterns) {
    updates.apiPatterns = llmData.apiPatterns;
  }
  
  // Apply layout fingerprint
  if (llmData.layoutFingerprint) {
    updates.layoutFingerprint = {
      ...llmData.layoutFingerprint,
      generatedAt: new Date().toISOString()
    };
  }
  
  // Add observations
  if (llmData.llmNotes?.observations) {
    const profile = getSiteProfile(basePath, domain);
    updates.llmObservations = [
      ...(profile.llmObservations || []),
      ...llmData.llmNotes.observations.map(obs => ({
        text: obs,
        addedAt: new Date().toISOString()
      }))
    ].slice(-20); // Keep last 20
  }
  
  // Update profile
  updateSiteProfile(basePath, domain, updates);
  
  // Check if verified
  const minConfidence = parseInt(process.env.LLM_MIN_CONFIDENCE) || 80;
  if (confidence >= minConfidence) {
    markAsVerified(basePath, domain, confidence);
  }
}

// ============================================================================
// EXTRACTION CONFIG MANAGEMENT
// ============================================================================

/**
 * Save extraction config for a site (Learn Once, Run Forever)
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {Object} extractionConfig - Extraction configuration
 * @param {string} discoveredBy - How it was discovered ("llm" | "auto" | "manual")
 */
function saveExtractionConfig(basePath, domain, extractionConfig, discoveredBy = 'auto') {
  log('PROFILE', `Saving extraction config for ${domain} (discovered by: ${discoveredBy})`);
  
  updateSiteProfile(basePath, domain, {
    extractionConfig: {
      ...extractionConfig,
      discoveredAt: new Date().toISOString(),
      discoveredBy
    }
  });
}

/**
 * Get extraction config for a site
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {Object|null} - Extraction config or null if not set
 */
function getExtractionConfig(basePath, domain) {
  const profile = getSiteProfile(basePath, domain);
  
  // Check if config has been set (has method)
  if (profile.extractionConfig && profile.extractionConfig.method) {
    return profile.extractionConfig;
  }
  
  return null;
}

/**
 * Check if a site has a saved extraction config
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {boolean} - True if config exists
 */
function hasExtractionConfig(basePath, domain) {
  return getExtractionConfig(basePath, domain) !== null;
}

/**
 * Update extraction config with new API endpoints discovered
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {Object} apiEndpoints - New endpoints to add
 */
function updateExtractionApiEndpoints(basePath, domain, apiEndpoints) {
  const profile = getSiteProfile(basePath, domain);
  const config = profile.extractionConfig || {};
  const apiConfig = config.apiConfig || {};
  const endpoints = apiConfig.endpoints || {};
  
  // Merge new endpoints
  const mergedEndpoints = { ...endpoints, ...apiEndpoints };
  
  updateSiteProfile(basePath, domain, {
    extractionConfig: {
      ...config,
      apiConfig: {
        ...apiConfig,
        endpoints: mergedEndpoints
      }
    }
  });
  
  log('PROFILE', `Updated API endpoints for ${domain}`);
}

/**
 * Add known providers/keywords to extraction config
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {Array} providers - New providers to add
 */
function addKnownProviders(basePath, domain, providers) {
  if (!providers || !Array.isArray(providers) || providers.length === 0) return;
  
  const profile = getSiteProfile(basePath, domain);
  const config = profile.extractionConfig || {};
  const existing = config.knownProviders || [];
  
  // Merge and dedupe
  const merged = [...new Set([...existing, ...providers.map(p => p.toLowerCase())])];
  
  updateSiteProfile(basePath, domain, {
    extractionConfig: {
      ...config,
      knownProviders: merged
    }
  });
  
  log('PROFILE', `Added ${providers.length} providers to ${domain}, now ${merged.length} total`);
}

/**
 * Mark extraction config as supporting historical farming
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {Object} historicalConfig - Historical config settings
 */
function setHistoricalConfig(basePath, domain, historicalConfig) {
  const profile = getSiteProfile(basePath, domain);
  const config = profile.extractionConfig || {};
  
  updateSiteProfile(basePath, domain, {
    extractionConfig: {
      ...config,
      historicalConfig: {
        ...historicalConfig,
        supported: true
      }
    }
  });
  
  log('PROFILE', `Enabled historical farming for ${domain}`);
}

// ============================================================================
// SWITCHER CONFIG MANAGEMENT (Phase 5: Learn Once, Run Forever)
// ============================================================================

/**
 * Save discovered switcher configuration for a domain
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {Object} switcherConfig - Switcher configuration
 */
function saveSwitcherConfig(basePath, domain, switcherConfig) {
  log('PROFILE', `Saving switcher config for ${domain}: ${switcherConfig.switchers?.length || 0} switchers`);
  
  const profile = getSiteProfile(basePath, domain);
  
  // Update profile with switcher data
  const updates = {
    switchers: switcherConfig.switchers || [],
    layoutFingerprint: {
      ...profile.layoutFingerprint,
      switcherCount: switcherConfig.switchers?.length || 0,
      switcherNames: (switcherConfig.switchers || []).map(s => s.keyword),
      generatedAt: new Date().toISOString()
    },
    extractionConfig: {
      ...profile.extractionConfig,
      // Save switcher navigation method
      switcherConfig: {
        discoveredAt: new Date().toISOString(),
        mainLeaderboardUrl: switcherConfig.mainLeaderboardUrl,
        navigationMethod: switcherConfig.navigationMethod || 'click-based',
        urlPattern: switcherConfig.urlPattern || null,
        allSwitchers: (switcherConfig.switchers || []).map(s => ({
          keyword: s.keyword,
          type: s.type,
          selector: s.selector || null,
          coordinates: s.coordinates || null,
          priority: s.priority,
          source: s.source,
          href: s.href || null,
          isActive: s.isActive || false
        })),
        dropdownInfo: switcherConfig.dropdownInfo || null
      },
      // Update click sequence for switchable sites
      clickSequence: (switcherConfig.switchers || [])
        .filter(s => s.type !== 'href-relative')
        .map(s => ({
          keyword: s.keyword,
          action: 'click',
          selector: s.selector || `[data-site="${s.keyword}"], [data-load-mode="${s.keyword}"]`,
          coordinates: s.coordinates,
          type: s.type
        }))
    }
  };
  
  updateSiteProfile(basePath, domain, updates);
}

/**
 * Get saved switcher configuration for a domain
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {Object|null} - Switcher config or null if not available
 */
function getSwitcherConfig(basePath, domain) {
  const profile = getSiteProfile(basePath, domain);
  
  // Check if we have switcher config
  if (profile.extractionConfig?.switcherConfig?.allSwitchers?.length > 0) {
    return profile.extractionConfig.switcherConfig;
  }
  
  // Fallback to legacy switchers array
  if (profile.switchers && profile.switchers.length > 0) {
    return {
      discoveredAt: profile.updatedAt,
      mainLeaderboardUrl: profile.navigation?.leaderboardPath,
      navigationMethod: 'click-based',
      allSwitchers: profile.switchers,
      urlPattern: profile.urlPattern?.pattern
    };
  }
  
  return null;
}

/**
 * Check if switcher config is still valid (not expired, not too old)
 * @param {Object} switcherConfig - Switcher configuration
 * @param {number} maxAgeDays - Maximum age in days (default 30)
 * @returns {boolean} - Whether config is valid
 */
function isSwitcherConfigValid(switcherConfig, maxAgeDays = 30) {
  if (!switcherConfig || !switcherConfig.discoveredAt) {
    return false;
  }
  
  const configAge = Date.now() - new Date(switcherConfig.discoveredAt).getTime();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  
  if (configAge > maxAgeMs) {
    return false;
  }
  
  // Must have at least one switcher
  if (!switcherConfig.allSwitchers || switcherConfig.allSwitchers.length === 0) {
    return false;
  }
  
  return true;
}

/**
 * Validate that saved switchers still exist on the page
 * @param {Page} page - Playwright page instance
 * @param {Array} savedSwitchers - Saved switcher array
 * @returns {Promise<Object>} - { valid: boolean, validCount: number, totalCount: number }
 */
async function validateSavedSwitchers(page, savedSwitchers) {
  if (!savedSwitchers || savedSwitchers.length === 0) {
    return { valid: false, validCount: 0, totalCount: 0 };
  }
  
  const validCount = await page.evaluate((switchers) => {
    let valid = 0;
    
    for (const s of switchers) {
      // Check by selector
      if (s.selector) {
        try {
          if (document.querySelector(s.selector)) {
            valid++;
            continue;
          }
        } catch (e) {}
      }
      
      // Check by coordinates (element at that position)
      if (s.coordinates) {
        const el = document.elementFromPoint(s.coordinates.x, s.coordinates.y);
        if (el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.closest('button, a'))) {
          valid++;
          continue;
        }
      }
      
      // Check by keyword in page content
      const html = document.body.innerHTML.toLowerCase();
      if (html.includes(s.keyword.toLowerCase())) {
        valid++;
      }
    }
    
    return valid;
  }, savedSwitchers);
  
  const totalCount = savedSwitchers.length;
  const validRatio = validCount / totalCount;
  
  // Consider valid if at least 70% of switchers are found
  return {
    valid: validRatio >= 0.7,
    validCount,
    totalCount
  };
}

/**
 * Save per-leaderboard switcher navigation info
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Name of the leaderboard
 * @param {Object} navInfo - Navigation info including switcher data
 */
function saveLeaderboardSwitcherInfo(basePath, domain, leaderboardName, navInfo) {
  const profile = getSiteProfile(basePath, domain);
  const config = profile.extractionConfig || {};
  const leaderboards = config.leaderboards || {};
  
  // Get or create leaderboard config
  const lbConfig = leaderboards[leaderboardName.toLowerCase()] || {
    navigation: {},
    extraction: {},
    stats: { successCount: 0, failCount: 0 }
  };
  
  // Update navigation with switcher info
  lbConfig.navigation = {
    ...lbConfig.navigation,
    url: navInfo.url,
    method: navInfo.method,
    requiresClick: navInfo.requiresClick || false,
    switcherInfo: navInfo.switcherData ? {
      type: navInfo.switcherData.type,
      selector: navInfo.switcherData.selector || null,
      coordinates: navInfo.switcherData.coordinates || null,
      clickMethod: navInfo.switcherData.coordinates ? 'coordinate' : 'selector',
      source: navInfo.switcherData.source,
      href: navInfo.switcherData.href || null
    } : null
  };
  
  // Update stats
  lbConfig.stats.lastSuccessAt = new Date().toISOString();
  lbConfig.stats.successCount = (lbConfig.stats.successCount || 0) + 1;
  lbConfig.stats.lastUpdatedAt = new Date().toISOString();
  
  // Save back
  leaderboards[leaderboardName.toLowerCase()] = lbConfig;
  
  updateSiteProfile(basePath, domain, {
    extractionConfig: {
      ...config,
      leaderboards
    }
  });
  
  log('PROFILE', `Saved switcher info for ${leaderboardName} on ${domain}`);
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get all site profiles
 * @param {string} basePath - Base path to lbscraper directory
 * @returns {Array} - Array of profiles
 */
function getAllProfiles(basePath) {
  const profilesDir = getProfilesDir(basePath);
  const profiles = [];
  
  try {
    if (fs.existsSync(profilesDir)) {
      const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const profile = JSON.parse(fs.readFileSync(path.join(profilesDir, file), 'utf8'));
          profiles.push(profile);
        } catch (err) {
          // Skip invalid files
        }
      }
    }
  } catch (err) {
    log('ERR', `Failed to list profiles: ${err.message}`);
  }
  
  return profiles;
}

/**
 * Get profiles by status
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} status - Status to filter by
 * @returns {Array} - Filtered profiles
 */
function getProfilesByStatus(basePath, status) {
  return getAllProfiles(basePath).filter(p => p.status === status);
}

/**
 * Get flagged sites
 * @param {string} basePath - Base path to lbscraper directory
 * @returns {Array} - Flagged sites
 */
function getFlaggedSites(basePath) {
  const flaggedPath = getFlaggedSitesPath(basePath);
  
  try {
    if (fs.existsSync(flaggedPath)) {
      return JSON.parse(fs.readFileSync(flaggedPath, 'utf8'));
    }
  } catch (err) {
    // Return empty
  }
  
  return [];
}

// ============================================================================
// NAVIGATION PATH MANAGEMENT
// ============================================================================

/**
 * Update site profile with discovered navigation path
 * @param {string} dataDir - Data directory path
 * @param {string} domain - Domain name
 * @param {string} leaderboardUrl - Discovered leaderboard URL
 */
async function updateSiteProfileNavigation(dataDir, domain, leaderboardUrl) {
  const profilePath = path.join(dataDir, 'site-profiles', `${domain}.json`);
  let profile = {};

  try {
    if (fs.existsSync(profilePath)) {
      profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } else {
      // Create new profile
      profile = createEmptyProfile(domain);
    }
  } catch (e) {
    // Create new profile
    profile = createEmptyProfile(domain);
  }

  // Update navigation section
  if (!profile.navigation) profile.navigation = {};
  profile.navigation.leaderboardPath = leaderboardUrl;
  profile.navigation.discoveredAt = new Date().toISOString();
  profile.updatedAt = new Date().toISOString();

  // Ensure directory exists
  const profileDir = path.dirname(profilePath);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  log('PROFILE', `Updated ${domain} profile with leaderboardPath: ${leaderboardUrl}`);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  PROFILE_STATUSES,
  
  // CRUD
  getSiteProfile,
  saveSiteProfile,
  updateSiteProfile,
  createEmptyProfile,
  
  // Status
  setSiteStatus,
  incrementAttempts,
  addLlmCost,
  
  // Flagging
  flagForManualReview,
  resetSiteForLLM,
  
  // Verification
  markAsVerified,
  updateProfileFromLLM,
  
  // Inactive leaderboard tracking
  markLeaderboardInactive,
  getInactiveLeaderboard,
  shouldRetryInactiveLeaderboard,
  reactivateLeaderboard,
  getInactiveLeaderboards,
  INACTIVE_RETRY_COOLDOWN_MS,
  
  // Extraction config management
  saveExtractionConfig,
  getExtractionConfig,
  hasExtractionConfig,
  updateExtractionApiEndpoints,
  addKnownProviders,
  setHistoricalConfig,
  
  // Switcher config management
  saveSwitcherConfig,
  getSwitcherConfig,
  isSwitcherConfigValid,
  validateSavedSwitchers,
  saveLeaderboardSwitcherInfo,
  
  // Queries
  getAllProfiles,
  getProfilesByStatus,
  getFlaggedSites,

  // Navigation
  updateSiteProfileNavigation
};
