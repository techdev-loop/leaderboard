/**
 * Quality Scorer Module
 *
 * RESPONSIBILITY: Calculate multi-dimensional quality scores for extraction results
 * - Entry completeness (all expected fields present)
 * - Source agreement (multiple sources agree)
 * - Data validity (no anomalies detected)
 * - Historical consistency (matches previous runs)
 * - Learned pattern match (matches site profile)
 * - Teacher verification (LLM verified if available)
 *
 * Provides comprehensive quality assessment beyond simple confidence scores.
 */

const { log } = require('../shared/utils');

// ============================================================================
// SCORE WEIGHTS
// ============================================================================

const QUALITY_WEIGHTS = {
  entryCompleteness: 0.20,    // All expected fields present
  sourceAgreement: 0.25,       // Multiple sources agree
  dataValidity: 0.20,          // No anomalies detected
  historicalConsistency: 0.15, // Matches previous runs
  learnedPatternMatch: 0.10,   // Matches site profile
  teacherVerification: 0.10    // LLM verified if available
};

// ============================================================================
// INDIVIDUAL SCORE CALCULATIONS
// ============================================================================

/**
 * Score entry completeness
 * @param {Array} entries - Extracted entries
 * @returns {number} - Score 0-100
 */
function scoreEntryCompleteness(entries) {
  if (!entries || entries.length === 0) return 0;

  let totalFields = 0;
  let filledFields = 0;

  for (const entry of entries) {
    // Required fields
    totalFields += 4; // rank, username, wager, prize

    if (entry.rank && entry.rank > 0) filledFields++;
    if (entry.username && entry.username.length > 0) filledFields++;
    if (entry.wager !== undefined && entry.wager !== null) filledFields++;
    if (entry.prize !== undefined && entry.prize !== null) filledFields++;
  }

  // Bonus for wager values being non-zero (actually extracted)
  const wagerFilled = entries.filter(e => e.wager > 0).length;
  const wagerPercent = wagerFilled / entries.length;

  // Bonus for prize values (less common but valuable)
  const prizeFilled = entries.filter(e => e.prize > 0).length;
  const prizePercent = prizeFilled / entries.length;

  const baseScore = totalFields > 0 ? (filledFields / totalFields) * 70 : 0;
  const wagerBonus = wagerPercent * 20;
  const prizeBonus = prizePercent * 10;

  return Math.min(100, Math.round(baseScore + wagerBonus + prizeBonus));
}

/**
 * Score source agreement from cross-validation
 * @param {Object|null} crossValidation - Cross-validation report
 * @returns {number} - Score 0-100
 */
function scoreSourceAgreement(crossValidation) {
  if (!crossValidation) return 50; // Neutral when no cross-validation

  const agreement = crossValidation.overallAgreement || 0;

  // Scale 0-1 to 0-100 with curve favoring higher agreement
  if (agreement >= 0.9) return 100;
  if (agreement >= 0.8) return 90;
  if (agreement >= 0.7) return 80;
  if (agreement >= 0.5) return 60;
  if (agreement >= 0.3) return 40;
  return 20;
}

/**
 * Score data validity (detect anomalies)
 * @param {Array} entries - Extracted entries
 * @returns {Object} - { score, anomalies }
 */
function scoreDataValidity(entries) {
  if (!entries || entries.length === 0) return { score: 0, anomalies: [] };

  const anomalies = [];
  let penaltyPoints = 0;

  // Check for wager ordering (should be descending by rank)
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].wager > entries[i - 1].wager && entries[i - 1].wager > 0) {
      anomalies.push({
        type: 'wager_order',
        message: `Rank ${entries[i].rank} has higher wager than rank ${entries[i - 1].rank}`
      });
      penaltyPoints += 5;
    }
  }

  // Check for rank sequence
  const expectedRanks = entries.map((_, i) => i + 1);
  const actualRanks = entries.map(e => e.rank);
  if (JSON.stringify(expectedRanks) !== JSON.stringify(actualRanks)) {
    anomalies.push({
      type: 'rank_sequence',
      message: 'Ranks are not sequential (1, 2, 3...)'
    });
    penaltyPoints += 10;
  }

  // Check for extreme outliers in wager
  const wagers = entries.map(e => e.wager).filter(w => w > 0);
  if (wagers.length >= 3) {
    const median = wagers.sort((a, b) => a - b)[Math.floor(wagers.length / 2)];
    const outliers = entries.filter(e => e.wager > median * 100);
    if (outliers.length > 0) {
      anomalies.push({
        type: 'extreme_outlier',
        message: `${outliers.length} entries have wagers 100x above median`
      });
      penaltyPoints += 15;
    }
  }

  // Check for duplicate usernames
  const usernames = entries.map(e => e.username?.toLowerCase());
  const uniqueUsernames = new Set(usernames);
  if (uniqueUsernames.size < usernames.length) {
    anomalies.push({
      type: 'duplicate_usernames',
      message: `${usernames.length - uniqueUsernames.size} duplicate usernames found`
    });
    penaltyPoints += 20;
  }

  // Check for all-zero wagers (likely extraction failure)
  const allZeroWagers = entries.every(e => e.wager === 0);
  if (allZeroWagers && entries.length > 3) {
    anomalies.push({
      type: 'all_zero_wagers',
      message: 'All wager values are 0 - likely extraction failure'
    });
    penaltyPoints += 25;
  }

  const score = Math.max(0, 100 - penaltyPoints);
  return { score, anomalies };
}

/**
 * Score historical consistency against previous extraction
 * @param {Array} currentEntries - Current entries
 * @param {Array|null} previousEntries - Previous extraction entries
 * @returns {number} - Score 0-100
 */
function scoreHistoricalConsistency(currentEntries, previousEntries) {
  if (!previousEntries || previousEntries.length === 0) return 70; // Neutral for first extraction

  // Compare username overlap (some churn is expected)
  const currentUsernames = new Set(currentEntries.map(e => e.username?.toLowerCase()));
  const previousUsernames = new Set(previousEntries.map(e => e.username?.toLowerCase()));

  let overlap = 0;
  for (const name of currentUsernames) {
    if (previousUsernames.has(name)) overlap++;
  }

  const overlapPercent = overlap / Math.min(currentUsernames.size, previousUsernames.size);

  // 50-80% overlap is healthy (some users move up/down)
  // <30% is suspicious (complete data change)
  // >90% is also suspicious (no movement at all)

  if (overlapPercent >= 0.5 && overlapPercent <= 0.9) return 90;
  if (overlapPercent >= 0.3 && overlapPercent < 0.5) return 70;
  if (overlapPercent > 0.9) return 60; // Too similar
  if (overlapPercent < 0.3) return 40; // Too different

  return 50;
}

/**
 * Score learned pattern match
 * @param {Object} result - Extraction result
 * @param {Object|null} learnedPatterns - Site profile patterns
 * @returns {number} - Score 0-100
 */
function scoreLearnedPatternMatch(result, learnedPatterns) {
  if (!learnedPatterns) return 50; // Neutral when no learned patterns

  let matchScore = 50;

  // Check if extraction method matches preferred source
  if (learnedPatterns.preferredSource) {
    if (result.extractionMethod === learnedPatterns.preferredSource) {
      matchScore += 30;
    } else {
      matchScore -= 10;
    }
  }

  // Check entry count against expected
  if (learnedPatterns.expectedEntries) {
    const diff = Math.abs(result.entries.length - learnedPatterns.expectedEntries);
    if (diff === 0) matchScore += 20;
    else if (diff <= 3) matchScore += 10;
    else if (diff > 10) matchScore -= 10;
  }

  return Math.min(100, Math.max(0, matchScore));
}

/**
 * Score teacher/LLM verification
 * @param {Object} result - Extraction result
 * @returns {number} - Score 0-100
 */
function scoreTeacherVerification(result) {
  if (result.llmVerified) return 95;
  if (result.llmConfidence && result.llmConfidence >= 80) return 85;
  if (result.llmConfidence && result.llmConfidence >= 60) return 70;
  return 50; // No LLM verification
}

// ============================================================================
// MAIN QUALITY SCORING
// ============================================================================

/**
 * Calculate comprehensive quality score
 * @param {Object} result - Extraction result
 * @param {Object} options - Scoring options
 * @returns {Object} - Quality score report
 */
function calculateQualityScore(result, options = {}) {
  const {
    crossValidation = null,
    previousEntries = null,
    learnedPatterns = null
  } = options;

  const entries = result.entries || [];

  // Calculate individual scores
  const scores = {
    entryCompleteness: scoreEntryCompleteness(entries),
    sourceAgreement: scoreSourceAgreement(crossValidation),
    dataValidity: scoreDataValidity(entries).score,
    historicalConsistency: scoreHistoricalConsistency(entries, previousEntries),
    learnedPatternMatch: scoreLearnedPatternMatch(result, learnedPatterns),
    teacherVerification: scoreTeacherVerification(result)
  };

  // Get anomalies for the report
  const validityResult = scoreDataValidity(entries);
  const anomalies = validityResult.anomalies;

  // Calculate weighted total
  let totalScore = 0;
  for (const [dimension, weight] of Object.entries(QUALITY_WEIGHTS)) {
    totalScore += scores[dimension] * weight;
  }

  // Identify quality flags
  const flags = identifyQualityFlags(scores, anomalies);

  // Generate recommendations
  const recommendations = generateRecommendations(scores, flags);

  log('QUALITY', `Quality score: ${Math.round(totalScore)} (completeness: ${scores.entryCompleteness}, agreement: ${scores.sourceAgreement}, validity: ${scores.dataValidity})`);

  return {
    overall: Math.round(totalScore),
    breakdown: scores,
    weights: QUALITY_WEIGHTS,
    anomalies,
    flags,
    recommendations,
    timestamp: new Date().toISOString()
  };
}

/**
 * Identify quality flags based on scores
 * @param {Object} scores - Individual scores
 * @param {Array} anomalies - Detected anomalies
 * @returns {Array} - Quality flags
 */
function identifyQualityFlags(scores, anomalies) {
  const flags = [];

  if (scores.sourceAgreement < 50) {
    flags.push({
      type: 'LOW_AGREEMENT',
      severity: 'high',
      message: 'Multiple sources disagree significantly'
    });
  }

  if (scores.entryCompleteness < 60) {
    flags.push({
      type: 'INCOMPLETE_DATA',
      severity: 'medium',
      message: 'Missing fields in extracted entries'
    });
  }

  if (scores.historicalConsistency < 40) {
    flags.push({
      type: 'HISTORICAL_DEVIATION',
      severity: 'medium',
      message: 'Data differs significantly from previous extractions'
    });
  }

  if (scores.dataValidity < 60) {
    flags.push({
      type: 'DATA_ANOMALIES',
      severity: 'high',
      message: `${anomalies.length} data anomalies detected`
    });
  }

  if (scores.learnedPatternMatch < 40) {
    flags.push({
      type: 'PATTERN_MISMATCH',
      severity: 'low',
      message: 'Extraction differs from learned patterns'
    });
  }

  return flags;
}

/**
 * Generate recommendations based on quality scores
 * @param {Object} scores - Individual scores
 * @param {Array} flags - Quality flags
 * @returns {Array} - Recommendations
 */
function generateRecommendations(scores, flags) {
  const recommendations = [];

  if (scores.sourceAgreement < 50) {
    recommendations.push('Run Teacher Mode to verify correct extraction method');
  }

  if (scores.entryCompleteness < 60) {
    recommendations.push('Check field mappings - wager/prize fields may be missing');
  }

  if (scores.dataValidity < 60) {
    recommendations.push('Review extraction for parsing errors or UI text contamination');
  }

  if (scores.historicalConsistency < 40) {
    recommendations.push('Verify page navigation - may be extracting wrong leaderboard');
  }

  return recommendations;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main function
  calculateQualityScore,

  // Individual scorers
  scoreEntryCompleteness,
  scoreSourceAgreement,
  scoreDataValidity,
  scoreHistoricalConsistency,
  scoreLearnedPatternMatch,
  scoreTeacherVerification,

  // Helpers
  identifyQualityFlags,
  generateRecommendations,

  // Config
  QUALITY_WEIGHTS
};
