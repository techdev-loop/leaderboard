/**
 * Extraction Config Module
 * 
 * Manages per-leaderboard extraction configurations.
 * Enables "Learn Once, Run Forever" - once a successful extraction method
 * is found, it's saved and reused for subsequent scrapes.
 * 
 * Config Structure:
 * {
 *   leaderboards: {
 *     "diceblox": {
 *       navigation: { url, urlPattern, baseUrl, method, requiresClick },
 *       extraction: { method, layoutType, textParseConfig, apiConfig, geometricConfig },
 *       validation: { expectedEntries, hasPrizes, prizePositions },
 *       stats: { successCount, failCount, lastSuccessAt }
 *     }
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./utils');
const { getSiteProfile, saveSiteProfile } = require('./teacher/site-profiles');

// ============================================================================
// CONSTANTS
// ============================================================================

const CONFIG_EXPIRY_DAYS = 30;
const MAX_CONSECUTIVE_FAILURES = 3;
const MIN_SUCCESSES_TO_TRUST = 2;

// ============================================================================
// LEADERBOARD CONFIG MANAGEMENT
// ============================================================================

/**
 * Get extraction config for a specific leaderboard
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @returns {Object|null} - Leaderboard config or null if not found
 */
function getLeaderboardConfig(basePath, domain, leaderboardName) {
  try {
    if (!basePath || !domain || !leaderboardName) {
      return null;
    }
    
    const profile = getSiteProfile(basePath, domain);
    const leaderboards = profile?.extractionConfig?.leaderboards;
    
    if (!leaderboards) {
      return null;
    }
    
    // Case-insensitive lookup
    const key = Object.keys(leaderboards).find(
      k => k.toLowerCase() === leaderboardName.toLowerCase()
    );
    
    return key ? leaderboards[key] : null;
  } catch (err) {
    log('ERR', `Failed to get leaderboard config: ${err.message}`);
    return null;
  }
}

/**
 * Save extraction config for a specific leaderboard
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @param {Object} config - Leaderboard config
 */
function saveLeaderboardConfig(basePath, domain, leaderboardName, config) {
  try {
    if (!basePath || !domain || !leaderboardName || !config) {
      throw new Error('Missing required parameters');
    }
    
    const profile = getSiteProfile(basePath, domain);
    
    // Initialize extractionConfig if needed
    if (!profile.extractionConfig) {
      profile.extractionConfig = {
        discoveredAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        leaderboards: {}
      };
    }
    
    if (!profile.extractionConfig.leaderboards) {
      profile.extractionConfig.leaderboards = {};
    }
    
    // Check for existing config to preserve and increment stats
    const key = leaderboardName.toLowerCase();
    const existingConfig = profile.extractionConfig.leaderboards[key];
    const existingSuccessCount = existingConfig?.stats?.successCount || 0;
    const existingFailCount = existingConfig?.stats?.failCount || 0;
    
    // Save the leaderboard config, incrementing success count if exists
    profile.extractionConfig.leaderboards[key] = {
      ...config,
      stats: {
        successCount: existingSuccessCount + 1,
        failCount: existingFailCount > 0 ? 0 : 0, // Reset fail count on success
        lastSuccessAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
      }
    };
    
    profile.extractionConfig.lastUpdatedAt = new Date().toISOString();
    
    saveSiteProfile(basePath, profile);
    log('CONFIG', `Saved extraction config for ${domain}/${leaderboardName}`);
  } catch (err) {
    log('ERR', `Failed to save leaderboard config: ${err.message}`);
  }
}

/**
 * Check if a leaderboard config is valid and should be used
 * @param {Object} config - Leaderboard config
 * @returns {boolean} - Whether config is valid
 */
function isConfigValid(config) {
  if (!config || !config.extraction) {
    return false;
  }
  
  const stats = config.stats || {};
  
  // Check for too many consecutive failures
  if (stats.failCount >= MAX_CONSECUTIVE_FAILURES) {
    return false;
  }
  
  // Check for minimum successes
  if (stats.successCount < MIN_SUCCESSES_TO_TRUST) {
    return false;
  }
  
  // Check for expiry
  if (stats.lastSuccessAt) {
    const lastSuccess = new Date(stats.lastSuccessAt);
    const daysSinceSuccess = (Date.now() - lastSuccess.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceSuccess > CONFIG_EXPIRY_DAYS) {
      return false;
    }
  }
  
  return true;
}

/**
 * Increment success count for a leaderboard config
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 */
function incrementConfigSuccess(basePath, domain, leaderboardName) {
  try {
    const profile = getSiteProfile(basePath, domain);
    const key = leaderboardName.toLowerCase();
    const config = profile?.extractionConfig?.leaderboards?.[key];
    
    if (!config) {
      return;
    }
    
    config.stats = config.stats || {};
    config.stats.successCount = (config.stats.successCount || 0) + 1;
    config.stats.failCount = 0; // Reset consecutive failures on success
    config.stats.lastSuccessAt = new Date().toISOString();
    
    saveSiteProfile(basePath, profile);
  } catch (err) {
    log('ERR', `Failed to increment config success: ${err.message}`);
  }
}

/**
 * Increment failure count for a leaderboard config
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 */
function incrementConfigFailure(basePath, domain, leaderboardName) {
  try {
    const profile = getSiteProfile(basePath, domain);
    const key = leaderboardName.toLowerCase();
    const config = profile?.extractionConfig?.leaderboards?.[key];
    
    if (!config) {
      return;
    }
    
    config.stats = config.stats || {};
    config.stats.failCount = (config.stats.failCount || 0) + 1;
    config.stats.lastFailedAt = new Date().toISOString();
    
    saveSiteProfile(basePath, profile);
    
    if (config.stats.failCount >= MAX_CONSECUTIVE_FAILURES) {
      log('CONFIG', `Config for ${domain}/${leaderboardName} disabled after ${MAX_CONSECUTIVE_FAILURES} failures`);
    }
  } catch (err) {
    log('ERR', `Failed to increment config failure: ${err.message}`);
  }
}

/**
 * Reset a leaderboard config (re-enable after fixes)
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 */
function resetLeaderboardConfig(basePath, domain, leaderboardName) {
  try {
    const profile = getSiteProfile(basePath, domain);
    const key = leaderboardName.toLowerCase();
    
    if (profile?.extractionConfig?.leaderboards?.[key]) {
      delete profile.extractionConfig.leaderboards[key];
      saveSiteProfile(basePath, profile);
      log('CONFIG', `Reset config for ${domain}/${leaderboardName}`);
    }
  } catch (err) {
    log('ERR', `Failed to reset leaderboard config: ${err.message}`);
  }
}

// ============================================================================
// CONFIG BUILDING FROM EXTRACTION RESULTS
// ============================================================================

/**
 * Build a leaderboard config from extraction results
 * @param {Object} result - Extraction result from extractLeaderboard()
 * @param {Object} navigationInfo - Navigation info (url, pattern, etc.)
 * @returns {Object} - Leaderboard config
 */
function buildConfigFromResult(result, navigationInfo) {
  if (!result || !result.entries || result.entries.length === 0) {
    return null;
  }
  
  const entries = result.entries;
  const method = result.extractionMethod || 'unknown';
  
  // Detect layout type
  const podiumEntries = entries.filter(e => 
    e.source?.includes('podium') || e.source?.includes('text-parse-podium')
  );
  const tableEntries = entries.filter(e => 
    e.source?.includes('list') || e.source?.includes('text-parse') && !e.source?.includes('podium')
  );
  
  const layoutType = podiumEntries.length > 0 ? 'podium-plus-table' : 'table-only';
  
  // Detect prize positions
  const prizePositions = entries
    .filter(e => e.prize && e.prize > 0)
    .map(e => e.rank)
    .sort((a, b) => a - b);
  
  // Build text parse config if applicable
  let textParseConfig = null;
  if (method.includes('text-parse')) {
    textParseConfig = {
      podiumCount: podiumEntries.length,
      tableStartRank: podiumEntries.length + 1,
      totalEntries: entries.length
    };
  }
  
  // Build API config if applicable
  let apiConfig = null;
  if (result.usedApiUrl) {
    apiConfig = {
      urlTemplate: templateizeApiUrl(result.usedApiUrl),
      validated: result.apiSiteValidated || false
    };
  }
  
  // Build geometric config if applicable
  let geometricConfig = null;
  const geometricEntries = entries.filter(e => e.source?.includes('geometric'));
  if (geometricEntries.length > 0) {
    geometricConfig = {
      podiumCount: geometricEntries.filter(e => e.source === 'geometric-podium').length,
      listCount: geometricEntries.filter(e => e.source === 'geometric-list').length
    };
  }
  
  // Extract field mappings from fusion metadata if available
  let fieldMappings = null;
  if (result.sourceBreakdown) {
    fieldMappings = extractFieldMappingsFromFusion(result);
  }

  return {
    navigation: {
      url: navigationInfo?.url || null,
      urlPattern: navigationInfo?.urlPattern || null,
      baseUrl: navigationInfo?.baseUrl || null,
      method: navigationInfo?.method || 'url',
      requiresClick: navigationInfo?.requiresClick || false,
      selector: navigationInfo?.selector || null
    },
    extraction: {
      method,
      layoutType,
      textParseConfig,
      apiConfig,
      geometricConfig,
      fieldMappings,  // NEW: Learned field mappings from successful extraction
      preferredSource: result.extractionMethod || null  // NEW: Best source for this site
    },
    validation: {
      expectedEntries: entries.length,
      hasPrizes: prizePositions.length > 0,
      prizePositions
    },
    crossValidation: result.crossValidation ? {
      overallAgreement: result.crossValidation.overallAgreement,
      sourcesUsed: Object.keys(result.sourceBreakdown || {})
    } : null,
    stats: {
      successCount: 1,
      failCount: 0,
      lastSuccessAt: new Date().toISOString()
    }
  };
}

/**
 * Extract field mappings from fusion result
 * Learns which field names worked for this site
 * @param {Object} result - Fusion extraction result
 * @returns {Object|null} - Field mappings or null
 */
function extractFieldMappingsFromFusion(result) {
  if (!result.entries || result.entries.length === 0) return null;

  const fieldMappings = {
    wager: [],
    prize: [],
    username: [],
    rank: []
  };

  // Check fusion metadata for field sources
  for (const entry of result.entries) {
    if (entry._fusion && entry._fusion.fieldSources) {
      const fs = entry._fusion.fieldSources;

      // Record which field names were used successfully
      // This information can be used by api-extraction to prioritize these fields
      if (fs.wager && fs.wager.source && !fieldMappings.wager.includes(fs.wager.source)) {
        fieldMappings.wager.push(fs.wager.source);
      }
      if (fs.prize && fs.prize.source && !fieldMappings.prize.includes(fs.prize.source)) {
        fieldMappings.prize.push(fs.prize.source);
      }
    }
  }

  // If we found useful mappings, return them
  if (fieldMappings.wager.length > 0 || fieldMappings.prize.length > 0) {
    return fieldMappings;
  }

  return null;
}

/**
 * Convert an API URL to a template by replacing site-specific parts
 * @param {string} url - Full API URL
 * @returns {string} - Templated URL
 */
function templateizeApiUrl(url) {
  if (!url) return null;
  
  try {
    // Common patterns to templatize
    // Example: casinoProvider=GAMDOM -> casinoProvider={SITE}
    // Example: /leaderboard/gamdom -> /leaderboard/{SITE}
    
    let template = url;
    
    // Replace query parameter values for known site params
    const siteParams = ['casinoProvider', 'site', 'provider', 'casino'];
    for (const param of siteParams) {
      const regex = new RegExp(`(${param}=)([A-Za-z0-9_-]+)`, 'gi');
      template = template.replace(regex, '$1{SITE}');
    }
    
    return template;
  } catch (err) {
    return url;
  }
}

/**
 * Expand a templated API URL with actual values
 * @param {string} template - Templated URL
 * @param {string} siteName - Site name to substitute
 * @returns {string} - Expanded URL
 */
function expandApiTemplate(template, siteName) {
  if (!template || !siteName) return template;
  
  return template
    .replace(/\{SITE\}/gi, siteName.toUpperCase())
    .replace(/\{site\}/g, siteName.toLowerCase());
}

// ============================================================================
// QUERYING
// ============================================================================

/**
 * Get all leaderboard configs for a domain
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {Object} - Map of leaderboard name -> config
 */
function getAllLeaderboardConfigs(basePath, domain) {
  try {
    const profile = getSiteProfile(basePath, domain);
    return profile?.extractionConfig?.leaderboards || {};
  } catch (err) {
    log('ERR', `Failed to get all leaderboard configs: ${err.message}`);
    return {};
  }
}

/**
 * Check if any leaderboard configs exist for a domain
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {boolean} - Whether any configs exist
 */
function hasAnyLeaderboardConfigs(basePath, domain) {
  const configs = getAllLeaderboardConfigs(basePath, domain);
  return Object.keys(configs).length > 0;
}

/**
 * Get valid (usable) leaderboard configs for a domain
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @returns {Object} - Map of leaderboard name -> valid config
 */
function getValidLeaderboardConfigs(basePath, domain) {
  const configs = getAllLeaderboardConfigs(basePath, domain);
  const valid = {};
  
  for (const [name, config] of Object.entries(configs)) {
    if (isConfigValid(config)) {
      valid[name] = config;
    }
  }
  
  return valid;
}

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * Get learned patterns for extraction
 * Returns patterns that can be applied to improve extraction
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @returns {Object|null} - Learned patterns or null
 */
function getLearnedPatterns(basePath, domain, leaderboardName) {
  const config = getLeaderboardConfig(basePath, domain, leaderboardName);

  if (!config || !isConfigValid(config)) {
    return null;
  }

  const columnOrder = config.extraction?.visionConfig?.column_order;
  const prizeBeforeWager = columnOrder === 'prize_before_wager';

  return {
    fieldMappings: config.extraction?.fieldMappings || null,
    preferredSource: config.extraction?.preferredSource || null,
    expectedEntries: config.validation?.expectedEntries || null,
    hasPrizes: config.validation?.hasPrizes || false,
    apiConfig: config.extraction?.apiConfig || null,
    prizeBeforeWager: prizeBeforeWager || undefined
  };
}

/**
 * Record a successful extraction to improve future runs
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @param {Object} result - Successful extraction result
 * @param {Object} navigationInfo - Navigation info
 */
function recordSuccessfulExtraction(basePath, domain, leaderboardName, result, navigationInfo) {
  if (!result || !result.entries || result.entries.length === 0) {
    return;
  }

  // Only learn from high-confidence extractions
  if (result.confidence < 70) {
    log('CONFIG', `Not recording patterns for ${leaderboardName}: confidence too low (${result.confidence})`);
    return;
  }

  const config = buildConfigFromResult(result, navigationInfo);
  if (config) {
    saveLeaderboardConfig(basePath, domain, leaderboardName, config);
    log('CONFIG', `Recorded successful extraction patterns for ${domain}/${leaderboardName}`);
  }
}

module.exports = {
  // Constants
  CONFIG_EXPIRY_DAYS,
  MAX_CONSECUTIVE_FAILURES,
  MIN_SUCCESSES_TO_TRUST,

  // Config management
  getLeaderboardConfig,
  saveLeaderboardConfig,
  isConfigValid,
  incrementConfigSuccess,
  incrementConfigFailure,
  resetLeaderboardConfig,

  // Config building
  buildConfigFromResult,
  templateizeApiUrl,
  expandApiTemplate,
  extractFieldMappingsFromFusion,

  // Learned patterns (NEW)
  getLearnedPatterns,
  recordSuccessfulExtraction,

  // Querying
  getAllLeaderboardConfigs,
  hasAnyLeaderboardConfigs,
  getValidLeaderboardConfigs
};
