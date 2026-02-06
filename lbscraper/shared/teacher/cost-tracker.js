/**
 * Cost Tracker for LLM Teacher Mode
 * 
 * Tracks token usage and enforces budget limits.
 * All costs are in USD.
 * 
 * IMPORTANT: This module enforces hard spending limits to prevent runaway costs.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PRICING = {
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },  // per 1K tokens
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'default': { input: 0.003, output: 0.015 }
};

// Default limits (can be overridden via env vars)
const DEFAULT_LIMITS = {
  maxTokensPerCall: 8000,
  maxCallsPerSite: 5,
  maxCallsPerDay: 100,
  monthlyBudgetUsd: 50.00
};

// ============================================================================
// HELPERS
// ============================================================================

function getUsageFilePath(basePath) {
  return path.join(basePath, 'data', 'llm-usage.json');
}

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7); // "2026-01"
}

function getToday() {
  return new Date().toISOString().split('T')[0]; // "2026-01-24"
}

function getLimits() {
  return {
    maxTokensPerCall: parseInt(process.env.LLM_MAX_TOKENS_PER_CALL) || DEFAULT_LIMITS.maxTokensPerCall,
    maxCallsPerSite: parseInt(process.env.LLM_MAX_CALLS_PER_SITE) || DEFAULT_LIMITS.maxCallsPerSite,
    maxCallsPerDay: parseInt(process.env.LLM_MAX_CALLS_PER_DAY) || DEFAULT_LIMITS.maxCallsPerDay,
    monthlyBudgetUsd: parseFloat(process.env.LLM_MONTHLY_BUDGET_USD) || DEFAULT_LIMITS.monthlyBudgetUsd
  };
}

// ============================================================================
// USAGE DATA MANAGEMENT
// ============================================================================

/**
 * Load usage data from JSON file
 * @param {string} basePath - Base path to lbscraper directory
 * @returns {Object} - Usage data object
 */
function loadUsageData(basePath) {
  const filePath = getUsageFilePath(basePath);
  const currentMonth = getCurrentMonth();
  
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Reset if new month
      if (data.currentMonth !== currentMonth) {
        log('COST', 'New month detected, resetting usage data');
        return createEmptyUsageData(currentMonth);
      }
      
      return data;
    }
  } catch (err) {
    log('ERR', `Failed to load usage data: ${err.message}`);
  }
  
  return createEmptyUsageData(currentMonth);
}

/**
 * Create empty usage data structure
 * @param {string} month - Current month string
 * @returns {Object} - Empty usage data
 */
function createEmptyUsageData(month) {
  return {
    currentMonth: month,
    totalTokensInput: 0,
    totalTokensOutput: 0,
    totalCostUsd: 0,
    callCount: 0,
    callsByDay: {},
    callsBySite: {},
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Save usage data to JSON file
 * @param {string} basePath - Base path to lbscraper directory
 * @param {Object} data - Usage data to save
 */
function saveUsageData(basePath, data) {
  const filePath = getUsageFilePath(basePath);
  const dir = path.dirname(filePath);
  
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    log('ERR', `Failed to save usage data: ${err.message}`);
  }
}

// ============================================================================
// COST CALCULATION
// ============================================================================

/**
 * Calculate cost for a single API call
 * @param {Object} usage - { inputTokens, outputTokens, model }
 * @returns {number} - Cost in USD
 */
function calculateCost(usage) {
  const pricing = PRICING[usage.model] || PRICING['default'];
  const inputCost = (usage.inputTokens / 1000) * pricing.input;
  const outputCost = (usage.outputTokens / 1000) * pricing.output;
  return inputCost + outputCost;
}

// ============================================================================
// BUDGET CHECKING
// ============================================================================

/**
 * Check if LLM calls are allowed based on budget
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Optional domain for per-site limit check
 * @returns {Object} - { allowed, reason, remainingBudget, usage }
 */
function checkBudget(basePath, domain = null) {
  const limits = getLimits();
  const usage = loadUsageData(basePath);
  const today = getToday();
  
  // Check monthly budget
  if (usage.totalCostUsd >= limits.monthlyBudgetUsd) {
    log('COST', `Monthly budget exhausted: $${usage.totalCostUsd.toFixed(2)}/$${limits.monthlyBudgetUsd}`);
    return {
      allowed: false,
      reason: 'monthly_budget_exceeded',
      remainingBudget: 0,
      usage
    };
  }
  
  // Check daily call limit
  const todayCalls = usage.callsByDay[today] || 0;
  if (todayCalls >= limits.maxCallsPerDay) {
    log('COST', `Daily limit reached: ${todayCalls}/${limits.maxCallsPerDay} calls`);
    return {
      allowed: false,
      reason: 'daily_limit_exceeded',
      remainingBudget: limits.monthlyBudgetUsd - usage.totalCostUsd,
      usage
    };
  }
  
  // Check per-site limit
  if (domain) {
    const siteCalls = usage.callsBySite[domain] || 0;
    if (siteCalls >= limits.maxCallsPerSite) {
      log('COST', `Site limit reached for ${domain}: ${siteCalls}/${limits.maxCallsPerSite} calls`);
      return {
        allowed: false,
        reason: 'site_limit_exceeded',
        remainingBudget: limits.monthlyBudgetUsd - usage.totalCostUsd,
        usage
      };
    }
  }
  
  return {
    allowed: true,
    reason: null,
    remainingBudget: limits.monthlyBudgetUsd - usage.totalCostUsd,
    todayCalls,
    siteCalls: domain ? (usage.callsBySite[domain] || 0) : null,
    usage
  };
}

// ============================================================================
// USAGE TRACKING
// ============================================================================

/**
 * Track usage after an LLM call
 * @param {string} basePath - Base path to lbscraper directory
 * @param {Object} usage - { inputTokens, outputTokens, model }
 * @param {string} domain - Domain the call was for
 * @returns {Object} - { cost, totalCost, callCount }
 */
function trackUsage(basePath, usage, domain = 'unknown') {
  const data = loadUsageData(basePath);
  const cost = calculateCost(usage);
  const today = getToday();
  
  // Update totals
  data.totalTokensInput += usage.inputTokens;
  data.totalTokensOutput += usage.outputTokens;
  data.totalCostUsd += cost;
  data.callCount++;
  
  // Track by day
  data.callsByDay[today] = (data.callsByDay[today] || 0) + 1;
  
  // Track by site
  data.callsBySite[domain] = (data.callsBySite[domain] || 0) + 1;
  
  // Save
  saveUsageData(basePath, data);
  
  // Log
  log('COST', `LLM call for ${domain}: ${usage.inputTokens}+${usage.outputTokens} tokens, $${cost.toFixed(4)} (total: $${data.totalCostUsd.toFixed(2)})`);
  
  return {
    cost,
    totalCost: data.totalCostUsd,
    callCount: data.callCount,
    todayCalls: data.callsByDay[today]
  };
}

// ============================================================================
// ADMIN FUNCTIONS
// ============================================================================

/**
 * Get current usage summary
 * @param {string} basePath - Base path to lbscraper directory
 * @returns {Object} - Usage summary
 */
function getUsageSummary(basePath) {
  const limits = getLimits();
  const usage = loadUsageData(basePath);
  const today = getToday();
  
  return {
    month: usage.currentMonth,
    totalCost: `$${usage.totalCostUsd.toFixed(2)}`,
    budget: `$${limits.monthlyBudgetUsd.toFixed(2)}`,
    budgetRemaining: `$${(limits.monthlyBudgetUsd - usage.totalCostUsd).toFixed(2)}`,
    budgetUsedPercent: `${((usage.totalCostUsd / limits.monthlyBudgetUsd) * 100).toFixed(1)}%`,
    totalCalls: usage.callCount,
    todayCalls: usage.callsByDay[today] || 0,
    dailyLimit: limits.maxCallsPerDay,
    tokensInput: usage.totalTokensInput,
    tokensOutput: usage.totalTokensOutput,
    topSites: Object.entries(usage.callsBySite)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([site, calls]) => ({ site, calls }))
  };
}

/**
 * Reset usage data (admin function)
 * @param {string} basePath - Base path to lbscraper directory
 */
function resetUsageData(basePath) {
  const currentMonth = getCurrentMonth();
  const emptyData = createEmptyUsageData(currentMonth);
  saveUsageData(basePath, emptyData);
  log('COST', `Usage data reset for ${currentMonth}`);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core functions
  checkBudget,
  trackUsage,
  calculateCost,
  
  // Data management
  loadUsageData,
  saveUsageData,
  
  // Admin
  getUsageSummary,
  resetUsageData,
  
  // Helpers
  getLimits,
  
  // Constants
  PRICING,
  DEFAULT_LIMITS
};
