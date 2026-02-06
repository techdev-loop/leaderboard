/**
 * Data Validator for LLM Teacher Mode
 * 
 * Detects anomalies and issues in scraped data:
 * - Duplicate entries (1:1 copies)
 * - Abnormal prize values
 * - Wager inconsistencies
 * - Data quality issues
 * 
 * When anomalies are detected, the validator can trigger
 * verification and learning for the scraper.
 */

const { log } = require('../utils');

// ============================================================================
// CONFIGURATION
// ============================================================================

const ANOMALY_THRESHOLDS = {
  // Prize values that are suspiciously high (likely parsing error)
  maxReasonablePrize: 100000, // $100,000 is suspicious for a single leaderboard prize
  
  // Minimum expected prize for top positions (if below, might be wrong)
  minExpectedTopPrize: 10, // $10 minimum expected for 1st place
  
  // Maximum wager that's reasonable (higher might be parsing error)
  maxReasonableWager: 50000000, // $50M is very high but possible
  
  // Minimum entries expected for a valid leaderboard
  minEntriesExpected: 3,
  
  // Similarity threshold for duplicate detection (1.0 = exact match)
  duplicateSimilarityThreshold: 0.95
};

// ============================================================================
// DUPLICATE DETECTION
// ============================================================================

/**
 * Detect duplicate entries within a single leaderboard
 * @param {Array} entries - Leaderboard entries
 * @returns {Object} - { hasDuplicates, duplicates, details }
 */
function detectDuplicateEntries(entries) {
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return { hasDuplicates: false, duplicates: [], details: 'No entries to check' };
  }
  
  const duplicates = [];
  const seen = new Map(); // Map of serialized entry -> indices
  
  entries.forEach((entry, index) => {
    // Create a fingerprint of the entry
    const fingerprint = createEntryFingerprint(entry);
    
    if (seen.has(fingerprint)) {
      duplicates.push({
        originalIndex: seen.get(fingerprint),
        duplicateIndex: index,
        entry: entry,
        type: 'exact_duplicate'
      });
    } else {
      seen.set(fingerprint, index);
    }
  });
  
  // Also check for similar usernames with same rank
  const rankMap = new Map();
  entries.forEach((entry, index) => {
    const rank = entry.rank || entry.position;
    if (rank) {
      if (rankMap.has(rank)) {
        const existing = rankMap.get(rank);
        duplicates.push({
          originalIndex: existing.index,
          duplicateIndex: index,
          entry: entry,
          type: 'duplicate_rank',
          details: `Rank ${rank} appears multiple times`
        });
      } else {
        rankMap.set(rank, { index, entry });
      }
    }
  });
  
  return {
    hasDuplicates: duplicates.length > 0,
    duplicates,
    details: duplicates.length > 0 
      ? `Found ${duplicates.length} duplicate entries` 
      : 'No duplicates detected'
  };
}

/**
 * Create a fingerprint for an entry to detect duplicates
 * @param {Object} entry - Leaderboard entry
 * @returns {string} - Fingerprint string
 */
function createEntryFingerprint(entry) {
  const normalized = {
    username: normalizeUsername(entry.username || entry.name || ''),
    wager: normalizeNumber(entry.wager || entry.wagered || 0),
    prize: normalizeNumber(entry.prize || entry.reward || 0),
    rank: entry.rank || entry.position || 0
  };
  
  return JSON.stringify(normalized);
}

/**
 * Normalize a username for comparison
 * @param {string} username - Username
 * @returns {string} - Normalized username
 */
function normalizeUsername(username) {
  return String(username)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[*]+/g, '*'); // Normalize censored parts
}

/**
 * Normalize a number for comparison
 * @param {number|string} value - Numeric value
 * @returns {number} - Normalized number
 */
function normalizeNumber(value) {
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return isNaN(parsed) ? 0 : Math.round(parsed * 100) / 100;
}

/**
 * Detect duplicate leaderboards across different scraped results
 * @param {Array} currentResults - Current leaderboard results
 * @param {Array} previousResults - Previous leaderboard results
 * @returns {Object} - { hasIdenticalLeaderboards, matches }
 */
function detectIdenticalLeaderboards(currentResults, previousResults) {
  if (!currentResults || !previousResults) {
    return { hasIdenticalLeaderboards: false, matches: [] };
  }
  
  const matches = [];
  
  for (const current of currentResults) {
    for (const previous of previousResults) {
      if (current.name !== previous.name) continue; // Different leaderboards
      
      const similarity = calculateEntrySimilarity(current.entries, previous.entries);
      
      if (similarity >= ANOMALY_THRESHOLDS.duplicateSimilarityThreshold) {
        matches.push({
          leaderboard: current.name,
          currentUrl: current.url,
          previousUrl: previous.url,
          similarity: similarity,
          issue: similarity === 1.0 
            ? 'EXACT_MATCH: Data is identical - scraper might not be refreshing'
            : 'HIGH_SIMILARITY: Data is suspiciously similar'
        });
      }
    }
  }
  
  return {
    hasIdenticalLeaderboards: matches.length > 0,
    matches,
    details: matches.length > 0
      ? `${matches.length} leaderboard(s) have identical/similar data to previous scrape`
      : 'No identical leaderboards detected'
  };
}

/**
 * Calculate similarity between two sets of entries
 * @param {Array} entries1 - First set of entries
 * @param {Array} entries2 - Second set of entries
 * @returns {number} - Similarity score (0-1)
 */
function calculateEntrySimilarity(entries1, entries2) {
  if (!entries1 || !entries2) return 0;
  if (entries1.length === 0 || entries2.length === 0) return 0;
  
  const fingerprints1 = new Set(entries1.map(createEntryFingerprint));
  const fingerprints2 = new Set(entries2.map(createEntryFingerprint));
  
  let matches = 0;
  for (const fp of fingerprints1) {
    if (fingerprints2.has(fp)) matches++;
  }
  
  const totalUnique = new Set([...fingerprints1, ...fingerprints2]).size;
  return matches / totalUnique;
}

// ============================================================================
// ANOMALY DETECTION
// ============================================================================

/**
 * Detect anomalies in prize values
 * @param {Array} entries - Leaderboard entries
 * @param {string} leaderboardName - Name of the leaderboard
 * @returns {Object} - { hasAnomalies, anomalies, suggestions }
 */
function detectPrizeAnomalies(entries, leaderboardName = 'unknown') {
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return { hasAnomalies: false, anomalies: [], suggestions: [] };
  }
  
  const anomalies = [];
  const suggestions = [];
  
  // Sort by rank to analyze prize distribution
  const sortedEntries = [...entries].sort((a, b) => 
    (a.rank || a.position || 999) - (b.rank || b.position || 999)
  );
  
  sortedEntries.forEach((entry, index) => {
    const prize = normalizeNumber(entry.prize || entry.reward);
    const wager = normalizeNumber(entry.wager || entry.wagered);
    const rank = entry.rank || entry.position || index + 1;
    
    // Check for suspiciously high prizes
    if (prize > ANOMALY_THRESHOLDS.maxReasonablePrize) {
      anomalies.push({
        type: 'ABNORMAL_PRIZE_HIGH',
        severity: 'high',
        entry,
        rank,
        value: prize,
        threshold: ANOMALY_THRESHOLDS.maxReasonablePrize,
        message: `Prize $${prize.toLocaleString()} for rank ${rank} is unusually high (>${ANOMALY_THRESHOLDS.maxReasonablePrize})`
      });
      suggestions.push(`Verify prize for rank ${rank} on ${leaderboardName} - might be parsing error`);
    }
    
    // Check for prizes that seem swapped with wagers
    if (prize > wager * 2 && wager > 0 && prize > 10000) {
      anomalies.push({
        type: 'PRIZE_WAGER_SWAP',
        severity: 'medium',
        entry,
        rank,
        prize,
        wager,
        message: `Prize ($${prize.toLocaleString()}) is much larger than wager ($${wager.toLocaleString()}) - possible swap`
      });
      suggestions.push(`Check if prize and wager columns are swapped for ${leaderboardName}`);
    }
    
    // Check first place has reasonable prize
    if (rank === 1 && prize < ANOMALY_THRESHOLDS.minExpectedTopPrize && prize > 0) {
      anomalies.push({
        type: 'ABNORMAL_PRIZE_LOW',
        severity: 'medium',
        entry,
        rank,
        value: prize,
        threshold: ANOMALY_THRESHOLDS.minExpectedTopPrize,
        message: `First place prize $${prize} seems too low`
      });
    }
  });
  
  // Check prize distribution (should generally decrease with rank)
  let previousPrize = Infinity;
  let prizeIncreases = 0;
  
  sortedEntries.forEach((entry, index) => {
    const prize = normalizeNumber(entry.prize || entry.reward);
    if (prize > previousPrize && prize > 0 && previousPrize !== Infinity) {
      prizeIncreases++;
    }
    previousPrize = prize;
  });
  
  if (prizeIncreases > sortedEntries.length / 2) {
    anomalies.push({
      type: 'INVERTED_PRIZE_ORDER',
      severity: 'high',
      message: 'Prize values increase with rank - data might be inverted or misaligned'
    });
    suggestions.push(`Prize distribution is inverted for ${leaderboardName} - verify data structure`);
  }
  
  return {
    hasAnomalies: anomalies.length > 0,
    anomalies,
    suggestions,
    summary: anomalies.length > 0
      ? `Found ${anomalies.length} anomaly/anomalies in prize data`
      : 'Prize data looks normal'
  };
}

/**
 * Detect anomalies in wager values
 * @param {Array} entries - Leaderboard entries
 * @returns {Object} - { hasAnomalies, anomalies }
 */
function detectWagerAnomalies(entries) {
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return { hasAnomalies: false, anomalies: [] };
  }
  
  const anomalies = [];
  
  // Calculate statistics
  const wagers = entries
    .map(e => normalizeNumber(e.wager || e.wagered))
    .filter(w => w > 0);
  
  if (wagers.length === 0) {
    anomalies.push({
      type: 'NO_WAGER_DATA',
      severity: 'high',
      message: 'No valid wager data found in any entry'
    });
    return { hasAnomalies: true, anomalies };
  }
  
  const avgWager = wagers.reduce((a, b) => a + b, 0) / wagers.length;
  const maxWager = Math.max(...wagers);
  const minWager = Math.min(...wagers);
  
  // Check for suspicious patterns
  if (maxWager > ANOMALY_THRESHOLDS.maxReasonableWager) {
    anomalies.push({
      type: 'ABNORMAL_WAGER_HIGH',
      severity: 'medium',
      value: maxWager,
      threshold: ANOMALY_THRESHOLDS.maxReasonableWager,
      message: `Maximum wager $${maxWager.toLocaleString()} exceeds threshold`
    });
  }
  
  // Check for all identical wagers (suspicious)
  if (maxWager === minWager && entries.length > 1) {
    anomalies.push({
      type: 'IDENTICAL_WAGERS',
      severity: 'high',
      value: maxWager,
      message: 'All entries have identical wager values - likely parsing error'
    });
  }
  
  // Check wager should decrease with rank (for current leaderboards)
  const sortedByRank = [...entries].sort((a, b) => 
    (a.rank || a.position || 999) - (b.rank || b.position || 999)
  );
  
  let previousWager = Infinity;
  let wagerIncreases = 0;
  
  sortedByRank.forEach(entry => {
    const wager = normalizeNumber(entry.wager || entry.wagered);
    if (wager > previousWager && wager > 0 && previousWager !== Infinity) {
      wagerIncreases++;
    }
    previousWager = wager;
  });
  
  if (wagerIncreases > sortedByRank.length / 2) {
    anomalies.push({
      type: 'INVERTED_WAGER_ORDER',
      severity: 'high',
      message: 'Wager values increase with rank - data order might be wrong'
    });
  }
  
  return {
    hasAnomalies: anomalies.length > 0,
    anomalies,
    summary: `Wager analysis: avg=$${avgWager.toLocaleString()}, max=$${maxWager.toLocaleString()}, min=$${minWager.toLocaleString()}`
  };
}

// ============================================================================
// COMPREHENSIVE VALIDATION
// ============================================================================

/**
 * Run comprehensive validation on extraction results
 * @param {Object} extractionResult - Full extraction result from scraper
 * @param {Object} previousResult - Previous scrape result for comparison
 * @returns {Object} - Complete validation report
 */
function validateExtractionResults(extractionResult, previousResult = null) {
  log('TEACHER', 'Running data validation checks...');
  
  const report = {
    valid: true,
    timestamp: new Date().toISOString(),
    checks: {
      duplicates: null,
      prizeAnomalies: null,
      wagerAnomalies: null,
      identicalToPrevious: null,
      entryCount: null
    },
    issues: [],
    warnings: [],
    suggestions: [],
    requiresVerification: false,
    requiresLearning: false
  };
  
  const results = extractionResult.results || extractionResult;
  
  if (!Array.isArray(results) || results.length === 0) {
    report.valid = false;
    report.issues.push('No results to validate');
    return report;
  }
  
  // Check each leaderboard
  for (const lb of results) {
    const entries = lb.entries || lb.data || [];
    const lbName = lb.name || lb.leaderboard || 'unknown';
    
    // Entry count check
    if (entries.length < ANOMALY_THRESHOLDS.minEntriesExpected) {
      report.warnings.push(`${lbName}: Only ${entries.length} entries (expected >=${ANOMALY_THRESHOLDS.minEntriesExpected})`);
    }
    
    // Duplicate check
    const duplicateResult = detectDuplicateEntries(entries);
    if (duplicateResult.hasDuplicates) {
      report.issues.push(`${lbName}: ${duplicateResult.details}`);
      report.checks.duplicates = duplicateResult;
      report.requiresVerification = true;
    }
    
    // Prize anomaly check
    const prizeResult = detectPrizeAnomalies(entries, lbName);
    if (prizeResult.hasAnomalies) {
      const highSeverity = prizeResult.anomalies.filter(a => a.severity === 'high');
      if (highSeverity.length > 0) {
        report.issues.push(`${lbName}: ${prizeResult.summary}`);
        report.requiresVerification = true;
      } else {
        report.warnings.push(`${lbName}: ${prizeResult.summary}`);
      }
      report.checks.prizeAnomalies = prizeResult;
      report.suggestions.push(...prizeResult.suggestions);
    }
    
    // Wager anomaly check
    const wagerResult = detectWagerAnomalies(entries);
    if (wagerResult.hasAnomalies) {
      const highSeverity = wagerResult.anomalies.filter(a => a.severity === 'high');
      if (highSeverity.length > 0) {
        report.issues.push(`${lbName}: Wager data issues detected`);
        report.requiresLearning = true;
      }
      report.checks.wagerAnomalies = wagerResult;
    }
  }
  
  // Check against previous results
  if (previousResult) {
    const identicalResult = detectIdenticalLeaderboards(
      results, 
      previousResult.results || previousResult
    );
    
    if (identicalResult.hasIdenticalLeaderboards) {
      report.warnings.push(identicalResult.details);
      report.checks.identicalToPrevious = identicalResult;
      report.requiresVerification = true;
    }
  }
  
  // Set overall validity
  report.valid = report.issues.length === 0;
  
  // Log summary
  if (report.issues.length > 0) {
    log('TEACHER', `Validation found ${report.issues.length} issue(s):`);
    report.issues.forEach(issue => log('TEACHER', `  - ${issue}`));
  }
  
  if (report.warnings.length > 0) {
    log('TEACHER', `Validation warnings: ${report.warnings.length}`);
  }
  
  return report;
}

/**
 * Generate learning instructions for the scraper based on validation results
 * @param {Object} validationReport - Report from validateExtractionResults
 * @param {string} domain - Domain name
 * @returns {Object} - Learning instructions
 */
function generateLearningInstructions(validationReport, domain) {
  const instructions = {
    domain,
    timestamp: new Date().toISOString(),
    corrections: [],
    verificationNeeded: [],
    scraperAdjustments: []
  };
  
  if (!validationReport.requiresLearning && !validationReport.requiresVerification) {
    return null; // No learning needed
  }
  
  // Generate corrections based on anomalies
  if (validationReport.checks.prizeAnomalies?.hasAnomalies) {
    const prizeAnomalies = validationReport.checks.prizeAnomalies.anomalies;
    
    for (const anomaly of prizeAnomalies) {
      if (anomaly.type === 'PRIZE_WAGER_SWAP') {
        instructions.scraperAdjustments.push({
          type: 'column_swap_check',
          description: 'Prize and wager columns may be swapped - verify column order',
          action: 'SWAP_PRIZE_WAGER_COLUMNS'
        });
      }
      
      if (anomaly.type === 'INVERTED_PRIZE_ORDER') {
        instructions.scraperAdjustments.push({
          type: 'data_order_check',
          description: 'Data appears inverted - check if parsing order is correct',
          action: 'REVERSE_ENTRY_ORDER'
        });
      }
      
      if (anomaly.type === 'ABNORMAL_PRIZE_HIGH') {
        instructions.verificationNeeded.push({
          type: 'verify_prize_value',
          rank: anomaly.rank,
          currentValue: anomaly.value,
          threshold: anomaly.threshold,
          action: 'VISIT_PAGE_AND_VERIFY'
        });
      }
    }
  }
  
  if (validationReport.checks.duplicates?.hasDuplicates) {
    instructions.corrections.push({
      type: 'remove_duplicates',
      duplicates: validationReport.checks.duplicates.duplicates,
      action: 'DEDUPLICATE_ENTRIES'
    });
  }
  
  if (validationReport.checks.identicalToPrevious?.hasIdenticalLeaderboards) {
    instructions.verificationNeeded.push({
      type: 'verify_data_refresh',
      matches: validationReport.checks.identicalToPrevious.matches,
      action: 'VERIFY_DATA_IS_CURRENT'
    });
  }
  
  return instructions;
}

// ============================================================================
// LLM DATA SOURCE COMPARISON
// ============================================================================

/**
 * Compare API and DOM data sources using LLM
 * LLM decides which source is more accurate and saves the preference
 * @param {Array} apiEntries - Entries from API
 * @param {Array} domEntries - Entries from DOM
 * @param {string} siteName - Site name for this leaderboard
 * @param {Object} config - Configuration with LLM settings
 * @returns {Promise<Object>} - { winner, reason, confidence, preferenceToSave }
 */
async function compareDataSources(apiEntries, domEntries, siteName, config) {
  // Quick validation
  if (!apiEntries || apiEntries.length === 0) {
    return { winner: 'dom', reason: 'no_api_data', confidence: 100, preferenceToSave: 'dom' };
  }
  if (!domEntries || domEntries.length === 0) {
    return { winner: 'api', reason: 'no_dom_data', confidence: 100, preferenceToSave: 'api' };
  }
  
  // Check for obvious issues before calling LLM
  const apiIssues = [];
  const domIssues = [];
  
  // Check for website names as usernames
  const { looksLikeWebsiteName } = require('../entry-validation');
  
  const apiWebsiteNames = apiEntries.filter(e => looksLikeWebsiteName(e.username));
  const domWebsiteNames = domEntries.filter(e => looksLikeWebsiteName(e.username));
  
  if (apiWebsiteNames.length > 0) {
    apiIssues.push(`Contains ${apiWebsiteNames.length} website names as usernames: ${apiWebsiteNames.map(e => e.username).join(', ')}`);
  }
  if (domWebsiteNames.length > 0) {
    domIssues.push(`Contains ${domWebsiteNames.length} website names as usernames: ${domWebsiteNames.map(e => e.username).join(', ')}`);
  }
  
  // Check for $0 prizes in top 3
  const apiZeroPrizes = apiEntries.slice(0, 3).filter(e => !e.prize || e.prize === 0).length;
  const domZeroPrizes = domEntries.slice(0, 3).filter(e => !e.prize || e.prize === 0).length;
  
  if (apiZeroPrizes > 0) apiIssues.push(`${apiZeroPrizes} of top 3 have $0 prize`);
  if (domZeroPrizes > 0) domIssues.push(`${domZeroPrizes} of top 3 have $0 prize`);
  
  // Check wager reasonability
  const apiAvgWager = apiEntries.reduce((s, e) => s + (e.wager || 0), 0) / apiEntries.length;
  const domAvgWager = domEntries.reduce((s, e) => s + (e.wager || 0), 0) / domEntries.length;
  
  if (apiAvgWager < 100) apiIssues.push('Suspiciously low average wager');
  if (domAvgWager < 100) domIssues.push('Suspiciously low average wager');
  
  // If one source has clear issues and other doesn't, decide without LLM
  if (apiIssues.length > 0 && domIssues.length === 0) {
    log('TEACHER', `API has issues (${apiIssues.join('; ')}), using DOM`);
    return { 
      winner: 'dom', 
      reason: `API issues: ${apiIssues.join('; ')}`, 
      confidence: 90, 
      preferenceToSave: 'dom',
      apiIssues,
      domIssues
    };
  }
  
  if (domIssues.length > 0 && apiIssues.length === 0) {
    log('TEACHER', `DOM has issues (${domIssues.join('; ')}), using API`);
    return { 
      winner: 'api', 
      reason: `DOM issues: ${domIssues.join('; ')}`, 
      confidence: 90, 
      preferenceToSave: 'api',
      apiIssues,
      domIssues
    };
  }
  
  // Both have issues or neither has issues - use LLM if available
  if (config?.llm?.enabled && config?.llm?.apiKey) {
    try {
      const { callClaude } = require('./llm-client');
      
      const prompt = `Compare these two data sources for the "${siteName}" leaderboard and determine which is more accurate.

## API Data (${apiEntries.length} entries):
${JSON.stringify(apiEntries.slice(0, 5), null, 2)}
${apiEntries.length > 5 ? `... and ${apiEntries.length - 5} more entries` : ''}

## DOM Data (${domEntries.length} entries):
${JSON.stringify(domEntries.slice(0, 5), null, 2)}
${domEntries.length > 5 ? `... and ${domEntries.length - 5} more entries` : ''}

## Known Issues:
API Issues: ${apiIssues.length > 0 ? apiIssues.join('; ') : 'None detected'}
DOM Issues: ${domIssues.length > 0 ? domIssues.join('; ') : 'None detected'}

## Evaluation Criteria:
1. Website names incorrectly parsed as usernames (e.g., "Gamdom.com", "Stake")
2. Missing or zero prizes for top positions
3. Reasonable wager amounts (typically $10,000 - $10,000,000)
4. Correct rank ordering
5. Data completeness

Return ONLY a JSON object with this exact format:
{
  "winner": "api" or "dom",
  "reason": "Brief explanation of why this source is more accurate",
  "confidence": 0-100,
  "issues_found": ["list of specific issues in the losing source"]
}`;

      const response = await callClaude(prompt, {
        ...config,
        maxTokens: 500
      });
      
      // Parse LLM response
      try {
        // Extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          log('TEACHER', `LLM chose ${parsed.winner} (confidence: ${parsed.confidence}%): ${parsed.reason}`);
          
          return {
            winner: parsed.winner,
            reason: parsed.reason,
            confidence: parsed.confidence,
            preferenceToSave: parsed.winner,
            issuesFound: parsed.issues_found,
            llmDecision: true,
            apiIssues,
            domIssues
          };
        }
      } catch (parseErr) {
        log('ERR', `Failed to parse LLM response: ${parseErr.message}`);
      }
    } catch (llmErr) {
      log('ERR', `LLM comparison failed: ${llmErr.message}`);
    }
  }
  
  // Fallback: use heuristics
  // Prefer API if it has more entries and both have issues
  if (apiEntries.length > domEntries.length && domIssues.length >= apiIssues.length) {
    return { 
      winner: 'api', 
      reason: 'More entries and fewer/equal issues', 
      confidence: 60, 
      preferenceToSave: 'api',
      apiIssues,
      domIssues
    };
  }
  
  // Prefer DOM if it has more entries or fewer issues
  if (domEntries.length >= apiEntries.length || domIssues.length < apiIssues.length) {
    return { 
      winner: 'dom', 
      reason: 'More entries or fewer issues', 
      confidence: 60, 
      preferenceToSave: 'dom',
      apiIssues,
      domIssues
    };
  }
  
  // Default to API (usually more structured)
  return { 
    winner: 'api', 
    reason: 'Default preference for structured API data', 
    confidence: 50, 
    preferenceToSave: 'api',
    apiIssues,
    domIssues
  };
}

/**
 * Save data source preference to site profile
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} siteName - Site/leaderboard name
 * @param {Object} comparison - Result from compareDataSources
 */
function saveDataSourcePreference(basePath, domain, siteName, comparison) {
  try {
    const { updateSiteProfile, getSiteProfile } = require('./site-profiles');
    
    const profile = getSiteProfile(basePath, domain);
    const preferences = profile.dataSourcePreference || {};
    
    preferences[siteName.toLowerCase()] = {
      source: comparison.winner,
      reason: comparison.reason,
      confidence: comparison.confidence,
      decidedAt: new Date().toISOString(),
      llmDecision: comparison.llmDecision || false
    };
    
    updateSiteProfile(basePath, domain, { dataSourcePreference: preferences });
    
    log('TEACHER', `Saved data source preference for ${domain}/${siteName}: ${comparison.winner}`);
  } catch (err) {
    log('ERR', `Failed to save data source preference: ${err.message}`);
  }
}

/**
 * Get saved data source preference for a site
 * @param {string} basePath - Base path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} siteName - Site/leaderboard name
 * @returns {Object|null} - Saved preference or null
 */
function getDataSourcePreference(basePath, domain, siteName) {
  try {
    const { getSiteProfile } = require('./site-profiles');
    
    const profile = getSiteProfile(basePath, domain);
    const preferences = profile.dataSourcePreference || {};
    
    return preferences[siteName.toLowerCase()] || null;
  } catch (err) {
    return null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Configuration
  ANOMALY_THRESHOLDS,
  
  // Duplicate detection
  detectDuplicateEntries,
  detectIdenticalLeaderboards,
  calculateEntrySimilarity,
  
  // Anomaly detection
  detectPrizeAnomalies,
  detectWagerAnomalies,
  
  // Comprehensive validation
  validateExtractionResults,
  generateLearningInstructions,
  
  // LLM data source comparison
  compareDataSources,
  saveDataSourcePreference,
  getDataSourcePreference,
  
  // Utilities
  createEntryFingerprint,
  normalizeUsername,
  normalizeNumber
};
