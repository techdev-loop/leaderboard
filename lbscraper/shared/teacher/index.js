/**
 * LLM Teacher Mode - Main Entry Point
 * 
 * Exports all Teacher Mode functionality for easy imports.
 * 
 * Usage:
 *   const { shouldInvokeTeacherMode, evaluateWithTeacher } = require('./shared/teacher');
 */

// Core orchestration
const {
  shouldInvokeTeacherMode,
  evaluateWithTeacher,
  applyLLMCorrections,
  checkLayoutChange
} = require('./teacher-mode');

// Site profiles
const {
  getSiteProfile,
  saveSiteProfile,
  updateSiteProfile,
  setSiteStatus,
  incrementAttempts,
  flagForManualReview,
  resetSiteForLLM,
  markAsVerified,
  updateProfileFromLLM,
  getAllProfiles,
  getProfilesByStatus,
  getFlaggedSites,
  addLlmCost,
  PROFILE_STATUSES,
  // Inactive leaderboard tracking
  markLeaderboardInactive,
  getInactiveLeaderboard,
  shouldRetryInactiveLeaderboard,
  reactivateLeaderboard,
  getInactiveLeaderboards,
  INACTIVE_RETRY_COOLDOWN_MS
} = require('./site-profiles');

// Cost tracking
const {
  checkBudget,
  trackUsage,
  calculateCost,
  getUsageSummary,
  resetUsageData,
  getLimits,
  PRICING,
  DEFAULT_LIMITS
} = require('./cost-tracker');

// LLM client
const {
  callClaude,
  isLLMAvailable,
  isTeacherModeEnabled
} = require('./llm-client');

// Response parsing
const {
  parseLLMResponse,
  extractJSON,
  validateResponse,
  extractFields,
  wantsToContinue,
  VALID_BROWSER_COMMANDS
} = require('./llm-parser');

// Layout fingerprinting
const {
  generateLayoutFingerprint,
  hasLayoutChanged,
  shouldReVerify
} = require('./fingerprint');

// Browser control
const { LLMBrowserController } = require('./llm-browser');

// Context building
const {
  buildQuickContext,
  buildInteractiveContext,
  buildTrainingContext,
  QUICK_ANALYSIS_PROMPT,
  INTERACTIVE_PROMPT
} = require('./llm-context');

// Data validation
const {
  validateExtractionResults,
  generateLearningInstructions,
  detectDuplicateEntries,
  detectIdenticalLeaderboards,
  detectPrizeAnomalies,
  detectWagerAnomalies,
  ANOMALY_THRESHOLDS
} = require('./data-validator');

// Visual verification
const {
  verifyLeaderboardsWithScreenshot,
  needsVisualVerification,
  exploreDropdown,
  verifyWithInteraction,
  VISUAL_VERIFY_COOLDOWN_MS,
  DROPDOWN_EXPLORATION_PROMPT
} = require('./visual-verifier');

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main functions
  shouldInvokeTeacherMode,
  evaluateWithTeacher,
  applyLLMCorrections,
  checkLayoutChange,
  
  // Site profiles
  getSiteProfile,
  saveSiteProfile,
  updateSiteProfile,
  setSiteStatus,
  incrementAttempts,
  flagForManualReview,
  resetSiteForLLM,
  markAsVerified,
  updateProfileFromLLM,
  getAllProfiles,
  getProfilesByStatus,
  getFlaggedSites,
  addLlmCost,
  PROFILE_STATUSES,
  
  // Inactive leaderboard tracking
  markLeaderboardInactive,
  getInactiveLeaderboard,
  shouldRetryInactiveLeaderboard,
  reactivateLeaderboard,
  getInactiveLeaderboards,
  INACTIVE_RETRY_COOLDOWN_MS,
  
  // Cost tracking
  checkBudget,
  trackUsage,
  calculateCost,
  getUsageSummary,
  resetUsageData,
  getLimits,
  PRICING,
  DEFAULT_LIMITS,
  
  // LLM client
  callClaude,
  isLLMAvailable,
  isTeacherModeEnabled,
  
  // Response parsing
  parseLLMResponse,
  extractJSON,
  validateResponse,
  extractFields,
  wantsToContinue,
  VALID_BROWSER_COMMANDS,
  
  // Layout fingerprinting
  generateLayoutFingerprint,
  hasLayoutChanged,
  shouldReVerify,
  
  // Browser control
  LLMBrowserController,
  
  // Context building
  buildQuickContext,
  buildInteractiveContext,
  buildTrainingContext,
  QUICK_ANALYSIS_PROMPT,
  INTERACTIVE_PROMPT,
  
  // Data validation
  validateExtractionResults,
  generateLearningInstructions,
  detectDuplicateEntries,
  detectIdenticalLeaderboards,
  detectPrizeAnomalies,
  detectWagerAnomalies,
  ANOMALY_THRESHOLDS,
  
  // Visual verification
  verifyLeaderboardsWithScreenshot,
  needsVisualVerification,
  exploreDropdown,
  verifyWithInteraction,
  VISUAL_VERIFY_COOLDOWN_MS,
  DROPDOWN_EXPLORATION_PROMPT
};
