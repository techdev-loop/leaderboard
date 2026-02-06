/**
 * Teacher Mode Orchestrator
 * 
 * Main entry point for LLM Teacher Mode.
 * Implements two-phase evaluation:
 * - Phase 1: Quick analysis with single LLM call
 * - Phase 2: Interactive browsing if Phase 1 fails
 * 
 * Core principle: "Learn Once, Run Forever"
 */

const path = require('path');
const { log } = require('../utils');
const { callClaude, isTeacherModeEnabled, isLLMAvailable } = require('./llm-client');
const { checkBudget, trackUsage } = require('./cost-tracker');
const { 
  getSiteProfile, 
  updateSiteProfile, 
  incrementAttempts, 
  flagForManualReview,
  updateProfileFromLLM,
  addLlmCost,
  PROFILE_STATUSES 
} = require('./site-profiles');
const { parseLLMResponse, extractFields, wantsToContinue } = require('./llm-parser');
const { 
  buildQuickContext, 
  buildInteractiveContext, 
  QUICK_ANALYSIS_PROMPT, 
  INTERACTIVE_PROMPT 
} = require('./llm-context');
const { LLMBrowserController } = require('./llm-browser');
const { generateLayoutFingerprint, hasLayoutChanged, shouldReVerify } = require('./fingerprint');
const { 
  validateExtractionResults, 
  generateLearningInstructions,
  detectDuplicateEntries,
  detectPrizeAnomalies 
} = require('./data-validator');

// ============================================================================
// DECISION LOGIC
// ============================================================================

/**
 * Determine if Teacher Mode should be invoked
 * @param {Object} profile - Site profile
 * @param {number} confidenceScore - Current confidence score
 * @param {Object} consensus - Optional consensus data from extraction
 * @returns {Object} - { invoke: boolean, reason: string }
 */
function shouldInvokeTeacherMode(profile, confidenceScore, consensus = null) {
  // Check if Teacher Mode is enabled
  if (!isTeacherModeEnabled()) {
    return { invoke: false, reason: 'disabled' };
  }
  
  // Check if LLM is available
  if (!isLLMAvailable()) {
    log('TEACHER', 'LLM not available (SDK not installed or API key missing)');
    return { invoke: false, reason: 'llm_unavailable' };
  }
  
  // Rule 1: New sites MUST be verified
  if (!profile || profile.status === PROFILE_STATUSES.NEW) {
    log('TEACHER', 'New site - verification required');
    return { invoke: true, reason: 'new_site' };
  }
  
  // Rule 4: Flagged sites don't use LLM
  if (profile.status === PROFILE_STATUSES.FLAGGED_FOR_REVIEW || profile.llmDisabled) {
    log('TEACHER', 'Site flagged or LLM disabled');
    return { invoke: false, reason: 'flagged_or_disabled' };
  }
  
  // Rule: Low consensus triggers review (data quality concern)
  if (consensus) {
    // Very low source agreement - multiple sources disagree significantly
    if (consensus.sourceAgreement < 0.3) {
      log('TEACHER', `Low consensus agreement (${Math.round(consensus.sourceAgreement * 100)}%) - verification needed`);
      return { invoke: true, reason: 'low_consensus' };
    }
    
    // Too many single-source entries compared to verified
    if (consensus.singleSource && consensus.verified && 
        consensus.singleSource.length > consensus.verified.length * 2) {
      log('TEACHER', `Single-source entries (${consensus.singleSource.length}) dominate over verified (${consensus.verified.length}) - verification needed`);
      return { invoke: true, reason: 'single_source_dominant' };
    }
    
    // Too few verified entries
    if (consensus.verified && consensus.verified.length < 3 && consensus.totalUnique >= 5) {
      log('TEACHER', `Only ${consensus.verified.length} verified entries out of ${consensus.totalUnique} - verification needed`);
      return { invoke: true, reason: 'insufficient_verified' };
    }
  }
  
  // Rule 5: Verified sites run independently (if confidence still high)
  if (profile.status === PROFILE_STATUSES.VERIFIED && confidenceScore >= 80) {
    log('TEACHER', 'Site verified with high confidence - running independently');
    return { invoke: false, reason: 'verified_high_confidence' };
  }
  
  // Layout changed sites need re-verification
  if (profile.status === PROFILE_STATUSES.LAYOUT_CHANGED) {
    log('TEACHER', 'Layout changed - re-verification required');
    return { invoke: true, reason: 'layout_changed' };
  }
  
  // Learning sites or low confidence need help
  if (profile.status === PROFILE_STATUSES.LEARNING || confidenceScore < 80) {
    log('TEACHER', `Confidence ${confidenceScore} < 80 - assistance needed`);
    return { invoke: true, reason: 'low_confidence' };
  }
  
  return { invoke: false, reason: 'none' };
}

// ============================================================================
// MAIN EVALUATION FUNCTION
// ============================================================================

/**
 * Evaluate extraction results with LLM Teacher
 * @param {Page} page - Playwright page
 * @param {Object} networkData - Network capture data
 * @param {Object} extractionResult - Scraper's extraction result
 * @param {Object} profile - Site profile
 * @param {Object} config - Configuration
 * @returns {Object} - { improved, correctedResult, phase, reason }
 */
async function evaluateWithTeacher(page, networkData, extractionResult, profile, config) {
  // Use path.dirname for cross-platform compatibility (Windows uses \ not /)
  const basePath = config.paths?.dataDir ? path.dirname(config.paths.dataDir) : path.resolve(__dirname, '..', '..');
  const domain = profile.domain;
  
  log('TEACHER', `\n${'═'.repeat(60)}`);
  log('TEACHER', `TEACHER MODE: ${domain}`);
  log('TEACHER', `   Status: ${profile.status}, Attempts: ${profile.attempts}/${profile.maxAttempts}`);
  log('TEACHER', `${'═'.repeat(60)}\n`);
  
  // Check attempt limit
  if (profile.attempts >= profile.maxAttempts) {
    log('TEACHER', 'Max attempts reached - flagging for review');
    await flagForManualReview(basePath, domain, 'max_attempts_reached');
    return { 
      improved: false, 
      reason: 'flagged',
      correctedResult: extractionResult 
    };
  }
  
  // Check budget
  const budgetCheck = checkBudget(basePath, domain);
  if (!budgetCheck.allowed) {
    log('TEACHER', `Budget limit: ${budgetCheck.reason}`);
    return { 
      improved: false, 
      reason: budgetCheck.reason,
      correctedResult: extractionResult 
    };
  }
  
  try {
    // =========================================================================
    // PRE-VALIDATION: Data Quality Checks
    // =========================================================================
    log('TEACHER', 'Pre-validation: Running data quality checks...');
    
    const validationReport = validateExtractionResults(extractionResult, config.previousResult);
    
    // Handle critical data issues before LLM evaluation
    if (!validationReport.valid) {
      log('TEACHER', `Data validation failed: ${validationReport.issues.join(', ')}`);
      
      // Check for duplicates that need automatic removal
      const results = extractionResult.results || extractionResult;
      let correctedResults = results;
      
      if (validationReport.checks.duplicates?.hasDuplicates) {
        log('TEACHER', 'Auto-removing duplicate entries...');
        correctedResults = results.map(lb => {
          const seen = new Set();
          const dedupedEntries = (lb.entries || []).filter(entry => {
            const fingerprint = JSON.stringify({
              username: (entry.username || '').toLowerCase(),
              rank: entry.rank || entry.position
            });
            if (seen.has(fingerprint)) return false;
            seen.add(fingerprint);
            return true;
          });
          return { ...lb, entries: dedupedEntries, deduplicationApplied: true };
        });
      }
      
      // Store validation issues in profile for learning
      await updateSiteProfile(basePath, domain, {
        lastValidationIssues: validationReport.issues,
        lastValidationAt: new Date().toISOString()
      });
      
      // Generate learning instructions if needed
      if (validationReport.requiresLearning) {
        const learningInstructions = generateLearningInstructions(validationReport, domain);
        if (learningInstructions) {
          await updateSiteProfile(basePath, domain, {
            learningInstructions,
            status: PROFILE_STATUSES.LEARNING
          });
          log('TEACHER', `Generated ${learningInstructions.scraperAdjustments.length} scraper adjustments`);
        }
      }
      
      // If validation found serious anomalies, flag for verification
      if (validationReport.requiresVerification) {
        log('TEACHER', 'Anomalies detected - proceeding with LLM verification');
        // Continue to Phase 1 with the validation context
      }
    } else {
      log('TEACHER', 'Data validation passed - no anomalies detected');
    }
    
    // =========================================================================
    // PHASE 1: QUICK ANALYSIS
    // =========================================================================
    log('TEACHER', 'Phase 1: Quick Analysis');
    
    // Take screenshot
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const screenshotBase64 = screenshot.toString('base64');
    
    // Build context
    const context = await buildQuickContext(page, networkData, extractionResult, profile, config);
    
    // Call LLM
    const phase1Response = await callClaude({
      systemPrompt: QUICK_ANALYSIS_PROMPT,
      userMessage: JSON.stringify(context, null, 2),
      basePath,
      domain,
      imageBase64: screenshotBase64,
      maxTokens: 4000
    });
    
    if (!phase1Response.success) {
      log('ERR', `Phase 1 failed: ${phase1Response.error}`, { domain });
      await incrementAttempts(basePath, domain);
      return { 
        improved: false, 
        reason: 'llm_error',
        error: phase1Response.error,
        correctedResult: extractionResult 
      };
    }
    
    // Track cost
    if (phase1Response.usage) {
      await addLlmCost(basePath, domain, phase1Response.usage.cost);
    }
    
    // Parse response
    const phase1Parsed = parseLLMResponse(phase1Response.content);
    
    if (!phase1Parsed.valid) {
      log('ERR', `Phase 1 parse error: ${phase1Parsed.errors.join(', ')}`, { domain });
      await incrementAttempts(basePath, domain);
      return { 
        improved: false, 
        reason: 'parse_error',
        errors: phase1Parsed.errors,
        correctedResult: extractionResult 
      };
    }
    
    const phase1Fields = extractFields(phase1Parsed.data);
    log('TEACHER', `Phase 1 confidence: ${phase1Fields.confidence}`);
    
    // Check if Phase 1 is sufficient
    const minConfidence = parseInt(process.env.LLM_MIN_CONFIDENCE) || 80;
    
    if (phase1Fields.confidence >= minConfidence) {
      log('TEACHER', `Phase 1 SUCCESS - confidence ${phase1Fields.confidence} >= ${minConfidence}`);
      
      // Apply corrections
      const correctedResult = applyLLMCorrections(extractionResult, phase1Parsed.data);
      
      // Update profile
      await updateProfileFromLLM(basePath, domain, phase1Parsed.data, phase1Fields.confidence);
      
      // Generate and store fingerprint
      const fingerprint = await generateLayoutFingerprint(page, context.training.knownSites);
      await updateSiteProfile(basePath, domain, { layoutFingerprint: fingerprint });
      
      return { 
        improved: true, 
        phase: 1,
        confidence: phase1Fields.confidence,
        correctedResult 
      };
    }
    
    // =========================================================================
    // PHASE 2: INTERACTIVE BROWSING
    // =========================================================================
    log('TEACHER', 'Phase 2: Interactive Browsing');
    log('TEACHER', `Phase 1 confidence ${phase1Fields.confidence} < ${minConfidence} - deeper investigation needed`);
    
    const browser = new LLMBrowserController(page, networkData);
    let iterations = 0;
    const maxIterations = config.llm?.maxCallsPerSite || parseInt(process.env.LLM_MAX_CALLS_PER_SITE) || 5;
    let lastParsed = phase1Parsed;
    
    while (iterations < maxIterations) {
      iterations++;
      log('TEACHER', `Phase 2 iteration ${iterations}/${maxIterations}`);
      
      // Check budget again
      const iterBudget = checkBudget(basePath, domain);
      if (!iterBudget.allowed) {
        log('TEACHER', 'Budget limit hit during iteration');
        break;
      }
      
      // Execute any browser commands from previous response
      if (lastParsed.data.browserCommands && lastParsed.data.browserCommands.length > 0) {
        log('TEACHER', `Executing ${lastParsed.data.browserCommands.length} browser commands`);
        await browser.executeCommands(lastParsed.data.browserCommands);
      }
      
      // Capture current state
      const state = await browser.captureState();
      
      // Build interactive context
      const interactiveContext = buildInteractiveContext(context, state, iterations);
      
      // Call LLM
      const iterResponse = await callClaude({
        systemPrompt: INTERACTIVE_PROMPT,
        userMessage: JSON.stringify(interactiveContext, null, 2),
        basePath,
        domain,
        imageBase64: state.screenshot,
        maxTokens: 4000
      });
      
      if (!iterResponse.success) {
        log('ERR', `Iteration ${iterations} failed: ${iterResponse.error}`, { domain });
        break;
      }
      
      // Track cost
      if (iterResponse.usage) {
        await addLlmCost(basePath, domain, iterResponse.usage.cost);
      }
      
      // Parse response
      const iterParsed = parseLLMResponse(iterResponse.content);
      
      if (!iterParsed.valid) {
        log('TEACHER', `Iteration ${iterations} parse error: ${iterParsed.errors.join(', ')}`);
        continue;
      }
      
      lastParsed = iterParsed;
      const iterFields = extractFields(iterParsed.data);
      log('TEACHER', `Iteration ${iterations} confidence: ${iterFields.confidence}`);
      
      // Check if LLM is satisfied
      if (iterFields.confidence >= minConfidence || iterFields.finished) {
        log('TEACHER', `Phase 2 SUCCESS after ${iterations} iterations`);
        
        // Apply corrections
        const correctedResult = applyLLMCorrections(extractionResult, iterParsed.data);
        
        // Update profile
        await updateProfileFromLLM(basePath, domain, iterParsed.data, iterFields.confidence);
        
        // Generate and store fingerprint
        const fingerprint = await generateLayoutFingerprint(page, context.training.knownSites);
        await updateSiteProfile(basePath, domain, { layoutFingerprint: fingerprint });
        
        return { 
          improved: true, 
          phase: 2,
          iterations,
          confidence: iterFields.confidence,
          correctedResult 
        };
      }
      
      // Check if LLM wants to continue
      if (!wantsToContinue(iterParsed.data)) {
        log('TEACHER', 'LLM indicated no more actions needed');
        break;
      }
    }
    
    // Phase 2 exhausted without success
    log('TEACHER', `Phase 2 exhausted after ${iterations} iterations`);
    
    const attemptResult = await incrementAttempts(basePath, domain);
    
    if (attemptResult.maxReached) {
      await flagForManualReview(basePath, domain, 'max_llm_iterations');
    }
    
    // Still apply what we learned
    const partialResult = applyLLMCorrections(extractionResult, lastParsed.data);
    const lastFields = extractFields(lastParsed.data);
    await updateProfileFromLLM(basePath, domain, lastParsed.data, lastFields.confidence);
    
    return { 
      improved: false, 
      reason: 'max_iterations',
      phase: 2,
      iterations,
      confidence: lastFields.confidence,
      correctedResult: partialResult 
    };
    
  } catch (error) {
    log('ERR', `Teacher fatal error: ${error.message}`, { domain, stack: error.stack });
    await incrementAttempts(basePath, domain);
    
    return { 
      improved: false, 
      reason: 'error',
      error: error.message,
      correctedResult: extractionResult 
    };
  }
}

// ============================================================================
// CORRECTION APPLICATION
// ============================================================================

/**
 * Apply LLM corrections to extraction result
 * @param {Object} originalResult - Original extraction result
 * @param {Object} llmData - Parsed LLM response data
 * @returns {Object} - Corrected result
 */
function applyLLMCorrections(originalResult, llmData) {
  const corrected = JSON.parse(JSON.stringify(originalResult)); // Deep clone
  
  // Apply data corrections
  if (llmData.dataVerification && !llmData.dataVerification.isCorrect) {
    const issues = llmData.dataVerification.issues || [];
    
    for (const issue of issues) {
      if (issue.correctedData && issue.leaderboard) {
        // Find and update the leaderboard
        const lbIndex = corrected.results?.findIndex(r => 
          r.name.toLowerCase() === issue.leaderboard.toLowerCase()
        );
        
        if (lbIndex >= 0 && issue.correctedData.length > 0) {
          log('TEACHER', `Applying correction to ${issue.leaderboard}: ${issue.problem}`);
          corrected.results[lbIndex].entries = issue.correctedData;
          corrected.results[lbIndex].llmCorrected = true;
        }
      }
    }
  }
  
  // Add LLM metadata
  corrected.llmVerified = true;
  corrected.llmConfidence = llmData.llmNotes?.confidence || 0;
  corrected.llmObservations = llmData.llmNotes?.observations || [];
  corrected.llmWarnings = llmData.llmNotes?.warnings || [];
  
  // Recalculate overall confidence
  if (llmData.llmNotes?.confidence) {
    corrected.confidence = Math.min(100, Math.max(
      corrected.confidence || 0,
      llmData.llmNotes.confidence
    ));
  }
  
  return corrected;
}

// ============================================================================
// LAYOUT CHANGE DETECTION
// ============================================================================

/**
 * Check if site layout has changed and needs re-verification
 * @param {Page} page - Playwright page
 * @param {Object} profile - Site profile
 * @param {Array} keywords - Site keywords
 * @param {string} basePath - Base path for updates
 * @returns {Object} - { changed, reason }
 */
async function checkLayoutChange(page, profile, keywords, basePath) {
  if (!profile.layoutFingerprint || !profile.layoutFingerprint.hash) {
    return { changed: false, reason: 'no_previous_fingerprint' };
  }
  
  const currentFingerprint = await generateLayoutFingerprint(page, keywords);
  const changeResult = hasLayoutChanged(profile.layoutFingerprint, currentFingerprint);
  
  if (shouldReVerify(changeResult)) {
    log('TEACHER', `Layout change detected: ${changeResult.reason}`);
    await updateSiteProfile(basePath, profile.domain, { 
      status: PROFILE_STATUSES.LAYOUT_CHANGED 
    });
    return { changed: true, reason: changeResult.reason };
  }
  
  return { changed: false, reason: 'no_significant_changes' };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main functions
  shouldInvokeTeacherMode,
  evaluateWithTeacher,
  
  // Helpers
  applyLLMCorrections,
  checkLayoutChange
};
