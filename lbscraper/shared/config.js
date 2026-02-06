/**
 * Configuration Loader for Leaderboard Scraper
 * 
 * Priority order:
 * 1. Database values (highest priority)
 * 2. Environment variables
 * 3. Hardcoded defaults (lowest priority)
 * 
 * Features:
 * - Caches database values to avoid constant DB queries
 * - Supports runtime refresh without restart
 * - Gracefully falls back when database unavailable
 */

const path = require('path');
const { log } = require('./utils');

// ============================================================================
// DEFAULT CONFIGURATION VALUES
// ============================================================================

const DEFAULT_CONFIG = {
  // Scraping intervals and timing
  scrape_interval_minutes: 15,
  scrape_timeout_seconds: 300,
  scrape_retry_count: 3,
  scrape_batch_delay_ms: 5000,
  
  // Feature toggles
  scrape_enabled: true,
  screenshot_enabled: true,
  headless_mode: true,
  debug_mode: false,
  
  // Validation thresholds
  min_confidence_threshold: 70,
  max_concurrent_pages: 3,
  
  // Fingerprint settings
  fingerprint_max_wait_ms: 12000,
  fingerprint_poll_interval_ms: 500,
  fingerprint_min_username_changes: 2,
  fingerprint_duplicate_threshold: 0.7,
  
  // Timer detection
  timer_observation_period_ms: 5000,
  timer_min_changes: 3,
  timer_interval_tolerance_ms: 200,
  
  // Extraction settings
  extraction_min_valid_entries: 7,
  extraction_target_entries: 10,
  extraction_geometric_tolerance: 0.15,
  extraction_x_alignment_tolerance: 10,
  
  // Validation settings
  validation_min_confidence: 85,
  validation_require_prize_for_top3: true,
  validation_min_prize_ratio: 0.001,
  validation_max_prize_ratio: 10,
  
  // Production mode settings
  production_min_confidence: 70,
  production_max_retries: 3,
  production_retry_delay_ms: 2000,
  production_reject_duplicates: true,
  production_strict_site_validation: true,
  
  // API learning
  api_learning_enabled: true,
  api_learning_max_patterns_per_domain: 10,
  api_learning_pattern_expiry_days: 7,
  
  // Direct API settings
  direct_api_enabled: true,
  direct_api_timeout: 10000,
  direct_api_max_retries: 2,
  direct_api_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  
  // LLM Teacher Mode settings
  llm_teacher_enabled: false,  // Disabled by default - opt-in
  llm_max_attempts: 3,
  llm_min_confidence: 80,
  llm_max_tokens_per_call: 8000,
  llm_max_calls_per_site: 5,
  llm_max_calls_per_day: 100,
  llm_monthly_budget_usd: 50.00
};

// ============================================================================
// CONFIG KEYS ENUM
// ============================================================================

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

// ============================================================================
// DATABASE CONFIG CACHE
// ============================================================================

let dbConfig = null;
let lastConfigFetch = 0;
const CONFIG_CACHE_MS = 60000; // Refresh from DB every 60 seconds
let prismaClient = null;

/**
 * Initialize the config loader with a Prisma client
 * @param {PrismaClient} client - The Prisma client instance
 */
function initConfigLoader(client) {
  prismaClient = client;
  log('CONFIG', 'Config loader initialized with database connection');
}

/**
 * Parse config value from string to appropriate type
 */
function parseConfigValue(key, stringValue) {
  const defaultValue = DEFAULT_CONFIG[key];
  
  if (defaultValue === undefined) {
    return stringValue;
  }
  
  const type = typeof defaultValue;
  
  switch (type) {
    case 'number':
      const num = parseFloat(stringValue);
      return isNaN(num) ? defaultValue : num;
    
    case 'boolean':
      return stringValue === 'true' || stringValue === '1';
    
    default:
      return stringValue;
  }
}

/**
 * Load configuration from database
 * @returns {Promise<Object>} - Configuration object
 */
async function loadConfigFromDatabase() {
  if (!prismaClient) {
    log('CONFIG', 'No database connection, using defaults and environment variables');
    return null;
  }
  
  try {
    const configs = await prismaClient.scraperConfig.findMany();
    
    const result = {};
    for (const config of configs) {
      result[config.key] = parseConfigValue(config.key, config.value);
    }
    
    dbConfig = result;
    lastConfigFetch = Date.now();
    
    log('CONFIG', `Loaded ${configs.length} config values from database`);
    return result;
  } catch (err) {
    log('ERR', `Failed to load config from database: ${err.message}`);
    return null;
  }
}

/**
 * Get a single config value
 * Priority: DB cache -> Environment variable -> Default
 * @param {string} key - The config key
 * @returns {any} - The config value
 */
function getConfigValue(key) {
  // 1. Check database cache
  if (dbConfig && dbConfig[key] !== undefined) {
    return dbConfig[key];
  }
  
  // 2. Check environment variable
  const envKey = key.toUpperCase();
  if (process.env[envKey] !== undefined) {
    return parseConfigValue(key, process.env[envKey]);
  }
  
  // 3. Return default
  return DEFAULT_CONFIG[key];
}

/**
 * Get the full configuration object
 * Merges defaults, env vars, and DB values
 * @returns {Object} - Complete configuration object
 */
function getFullConfig() {
  const config = { ...DEFAULT_CONFIG };
  
  // Override with environment variables
  for (const key of CONFIG_KEYS) {
    const envKey = key.toUpperCase();
    if (process.env[envKey] !== undefined) {
      config[key] = parseConfigValue(key, process.env[envKey]);
    }
  }
  
  // Override with database values
  if (dbConfig) {
    for (const key of Object.keys(dbConfig)) {
      config[key] = dbConfig[key];
    }
  }
  
  return config;
}

/**
 * Refresh config from database if cache is stale
 * @returns {Promise<Object>} - Configuration object
 */
async function refreshConfigIfStale() {
  const now = Date.now();
  
  if (now - lastConfigFetch > CONFIG_CACHE_MS) {
    return await loadConfigFromDatabase();
  }
  
  return dbConfig;
}

/**
 * Force refresh config from database
 * @returns {Promise<Object>} - Configuration object
 */
async function forceRefreshConfig() {
  lastConfigFetch = 0;
  return await loadConfigFromDatabase();
}

/**
 * Build the legacy CONFIG object structure for backwards compatibility
 * This maps to the original test-scraper.js CONFIG structure
 */
function buildLegacyConfig(basePath = __dirname) {
  const config = getFullConfig();
  
  return {
    paths: {
      // Data files (cache, patterns, OCR data)
      dataDir: path.join(basePath, 'data'),
      cache: path.join(basePath, 'data', 'leaderboard-cache.json'),
      apiPatterns: path.join(basePath, 'data', 'api-patterns.json'),
      ocrData: path.join(basePath, 'data', 'eng.traineddata'),
      
      // Configuration files (in root)
      keywords: path.join(basePath, 'keywords.txt'),
      websites: path.join(basePath, 'websites.txt'),
      
      // Results output
      resultsDir: path.join(basePath, 'results'),
      results: path.join(basePath, 'results', 'scrape-results.json'),
      allResults: path.join(basePath, 'results', 'all-results.json'),
      currentResultsDir: path.join(basePath, 'results', 'current'),
      previousResultsDir: path.join(basePath, 'results', 'previous'),
      
      // Logs
      logsDir: path.join(basePath, 'logs'),
      failedScrapes: path.join(basePath, 'logs', 'failed-scrapes.json')
    },
    fingerprint: {
      maxWaitMs: config.fingerprint_max_wait_ms,
      pollIntervalMs: config.fingerprint_poll_interval_ms,
      retryOnStale: true,
      minUsernameChanges: config.fingerprint_min_username_changes,
      duplicateThreshold: config.fingerprint_duplicate_threshold
    },
    timer: {
      observationPeriodMs: config.timer_observation_period_ms,
      minChanges: config.timer_min_changes,
      intervalToleranceMs: config.timer_interval_tolerance_ms
    },
    extraction: {
      minValidEntries: config.extraction_min_valid_entries,
      targetEntries: config.extraction_target_entries,
      geometricTolerance: config.extraction_geometric_tolerance,
      xAlignmentTolerance: config.extraction_x_alignment_tolerance
    },
    validation: {
      minConfidence: config.validation_min_confidence,
      requirePrizeForTop3: config.validation_require_prize_for_top3,
      minPrizeRatio: config.validation_min_prize_ratio,
      maxPrizeRatio: config.validation_max_prize_ratio
    },
    production: {
      enabled: process.env.NODE_ENV === 'production' || process.argv.includes('--production'),
      minConfidence: config.production_min_confidence,
      maxRetries: config.production_max_retries,
      retryDelayMs: config.production_retry_delay_ms,
      rejectDuplicates: config.production_reject_duplicates,
      strictSiteValidation: config.production_strict_site_validation
    },
    apiLearning: {
      enabled: config.api_learning_enabled,
      maxPatternsPerDomain: config.api_learning_max_patterns_per_domain,
      patternExpiryDays: config.api_learning_pattern_expiry_days
    },
    batch: {
      enabled: true,
      delayBetweenSitesMs: config.scrape_batch_delay_ms,
      savePerSiteResults: true
    },
    directApi: {
      enabled: config.direct_api_enabled,
      timeout: config.direct_api_timeout,
      userAgent: config.direct_api_user_agent,
      maxRetries: config.direct_api_max_retries
    },
    llm: {
      enabled: process.env.LLM_TEACHER_ENABLED === 'true' || config.llm_teacher_enabled,
      maxAttempts: parseInt(process.env.LLM_MAX_ATTEMPTS) || config.llm_max_attempts,
      minConfidence: parseInt(process.env.LLM_MIN_CONFIDENCE) || config.llm_min_confidence,
      maxTokensPerCall: parseInt(process.env.LLM_MAX_TOKENS_PER_CALL) || config.llm_max_tokens_per_call,
      maxCallsPerSite: parseInt(process.env.LLM_MAX_CALLS_PER_SITE) || config.llm_max_calls_per_site,
      maxCallsPerDay: parseInt(process.env.LLM_MAX_CALLS_PER_DAY) || config.llm_max_calls_per_day,
      monthlyBudgetUsd: parseFloat(process.env.LLM_MONTHLY_BUDGET_USD) || config.llm_monthly_budget_usd
    }
  };
}

// ============================================================================
// JSON LOGGING CONFIGURATION
// ============================================================================

/**
 * Get JSON logging configuration
 * Priority: Database -> Environment -> Defaults
 * @returns {Promise<Object>} - { enabled, autoCleanupEnabled, retentionHours }
 */
async function getJsonLoggingConfig() {
  const defaults = {
    enabled: true,
    autoCleanupEnabled: true,
    retentionHours: 48
  };

  // 1. Try database ScraperConfig first
  if (prismaClient) {
    try {
      const configs = await prismaClient.scraperConfig.findMany({
        where: {
          key: { in: ['JSON_LOGGING_ENABLED', 'JSON_AUTO_CLEANUP_ENABLED', 'JSON_RETENTION_HOURS'] }
        }
      });

      for (const config of configs) {
        if (config.key === 'JSON_LOGGING_ENABLED') {
          defaults.enabled = config.value === 'true';
        } else if (config.key === 'JSON_AUTO_CLEANUP_ENABLED') {
          defaults.autoCleanupEnabled = config.value === 'true';
        } else if (config.key === 'JSON_RETENTION_HOURS') {
          defaults.retentionHours = parseInt(config.value) || 48;
        }
      }
      return defaults;
    } catch (e) {
      // Fall through to ENV
      log('CONFIG', `Failed to load JSON logging config from DB: ${e.message}`);
    }
  }

  // 2. Fall back to ENV
  return {
    enabled: process.env.SCRAPER_JSON_LOGGING !== 'false',
    autoCleanupEnabled: process.env.SCRAPER_JSON_AUTO_CLEANUP !== 'false',
    retentionHours: parseInt(process.env.SCRAPER_JSON_RETENTION_HOURS) || 48
  };
}

/**
 * Check if JSON logging is enabled
 * @returns {Promise<boolean>}
 */
async function isJsonLoggingEnabled() {
  const config = await getJsonLoggingConfig();
  return config.enabled;
}

/**
 * Check if auto-cleanup is enabled
 * @returns {Promise<boolean>}
 */
async function isAutoCleanupEnabled() {
  const config = await getJsonLoggingConfig();
  return config.autoCleanupEnabled;
}

/**
 * Get retention hours setting
 * @returns {Promise<number>}
 */
async function getRetentionHours() {
  const config = await getJsonLoggingConfig();
  return config.retentionHours;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  DEFAULT_CONFIG,
  CONFIG_KEYS,
  CONFIG_CACHE_MS,

  // Initialization
  initConfigLoader,

  // Config access
  loadConfigFromDatabase,
  getConfigValue,
  getFullConfig,
  refreshConfigIfStale,
  forceRefreshConfig,

  // Legacy compatibility
  buildLegacyConfig,

  // JSON Logging config
  getJsonLoggingConfig,
  isJsonLoggingEnabled,
  isAutoCleanupEnabled,
  getRetentionHours
};
