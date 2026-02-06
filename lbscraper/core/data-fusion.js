/**
 * Data Fusion Module
 *
 * RESPONSIBILITY: Orchestrate multi-source extraction and fuse results
 * - Run ALL viable extraction strategies (not stop at first success)
 * - Collect results from each strategy with metadata
 * - Cross-validate between sources
 * - Merge results using confidence-weighted fusion
 * - Tag entries with verification status
 *
 * Replaces the "first-success-wins" pattern in data-extractor.js
 */

const { log } = require('../shared/utils');
const { mergeApiResponses } = require('../strategies/api-merger');
const { crossValidate, normalizeUsername, buildEntryMap } = require('./cross-validator');

// ============================================================================
// FUSION CONFIGURATION
// ============================================================================

const FUSION_CONFIG = {
  MIN_SOURCES_FOR_VERIFICATION: 2,
  AGREEMENT_THRESHOLD: 0.75,
  MIN_CONFIDENCE_BOOST: 5,
  MAX_CONFIDENCE_BOOST: 20,
  SINGLE_SOURCE_PENALTY: 5
};

// ============================================================================
// MAIN FUSION FUNCTION
// ============================================================================

/**
 * Run all viable strategies and fuse their results
 * @param {Object} input - Extractor input (html, markdown, rawJsonResponses, etc.)
 * @param {Array} strategies - Array of extraction strategies
 * @param {Object} [options] - Fusion options
 * @returns {Promise<Object>} - Fused extraction result
 */
async function fuseExtractionResults(input, strategies, options = {}) {
  const {
    minConfidence = 50,
    siteName = null,
    learnedPatterns = null,
    knownKeywords = [],  // All known leaderboard keywords for this site
    expectedRank1 = null  // Vision-learned: { username, wager, prize } for validation
  } = options;

  log('FUSION', `Starting multi-source extraction with ${strategies.length} strategies`);

  // Pre-process: Merge API responses if multiple exist
  // Also filter out API responses that belong to OTHER leaderboards
  if (input.rawJsonResponses && input.rawJsonResponses.length > 0) {
    input.rawJsonResponses = mergeApiResponses(input.rawJsonResponses, siteName, knownKeywords);
    log('FUSION', `API responses merged: ${input.rawJsonResponses.length} response(s)`);
  }

  // Apply learned patterns if available
  if (learnedPatterns && learnedPatterns.fieldMappings) {
    input._learnedFieldMappings = learnedPatterns.fieldMappings;
    log('FUSION', 'Applied learned field mappings');
  }

  // Pass siteName to input so strategies can use it for debugging
  if (siteName) {
    input.siteName = siteName;
  }

  // Pass Vision-learned config (podiumLayout, prizeBeforeWager) to strategies
  if (options.podiumLayout) {
    input._podiumLayout = options.podiumLayout;
    log('FUSION', `Using podium layout hint: ${options.podiumLayout}`);
  }
  if (options.prizeBeforeWager !== undefined) {
    input._prizeBeforeWager = options.prizeBeforeWager;
    log('FUSION', `Using column order hint: prizeBeforeWager=${options.prizeBeforeWager}`);
  }

  // Run ALL viable strategies
  const strategyResults = {};
  const errors = [];

  // Sort by priority but run ALL
  const sortedStrategies = [...strategies].sort((a, b) => a.priority - b.priority);

  for (const strategy of sortedStrategies) {
    if (!strategy.canExtract(input)) {
      log('FUSION', `Strategy ${strategy.name}: cannot extract (missing input)`);
      continue;
    }

    // Skip OCR when we already have any usable result (OCR is expensive and can throw in Node worker)
    if (strategy.name === 'ocr') {
      const hasGoodResult = Object.values(strategyResults).some(
        r => r.entries.length >= 2 && (r.confidence || 0) >= 65
      );
      if (hasGoodResult) {
        log('FUSION', 'Strategy ocr: skipped (already have sufficient result from other strategy)');
        continue;
      }
    }

    try {
      const result = await strategy.extract(input);

      if (result && result.entries && result.entries.length > 0) {
        const confidence = result.confidence || 50;

        // Filter out very low confidence results (e.g., bad OCR) from fusion
        // They create garbage entries that corrupt the final output
        if (confidence < minConfidence) {
          log('FUSION', `Strategy ${strategy.name}: ${result.entries.length} entries but confidence ${confidence} < ${minConfidence} (skipped)`);
          continue;
        }

        strategyResults[strategy.name] = {
          entries: result.entries,
          prizes: result.prizes || [],
          confidence: confidence,
          apiUrl: result.apiUrl,
          metadata: result.metadata || {}
        };
        log('FUSION', `Strategy ${strategy.name}: ${result.entries.length} entries, confidence ${confidence}`);
      } else {
        log('FUSION', `Strategy ${strategy.name}: no entries found`);
      }
    } catch (error) {
      log('ERR', `Strategy ${strategy.name} error: ${error.message}`);
      errors.push(`${strategy.name}: ${error.message}`);
    }
  }

  let sourceCount = Object.keys(strategyResults).length;

  if (sourceCount === 0) {
    log('FUSION', 'No strategies produced results');
    return {
      entries: [],
      prizes: [],
      confidence: 0,
      extractionMethod: 'none',
      crossValidation: null,
      sourceBreakdown: {},
      errors
    };
  }

  // Check for stale API data before fusion
  // If API and markdown both have entries but no wagers match, API data is likely stale/cached
  if (strategyResults.api && strategyResults.markdown && sourceCount >= 2) {
    const apiWagers = new Set(
      strategyResults.api.entries.map(e => Math.round(e.wager || 0))
    );
    const markdownWagers = new Set(
      strategyResults.markdown.entries.map(e => Math.round(e.wager || 0))
    );

    // Check for ANY exact wager match between API and markdown
    let matchCount = 0;
    for (const wager of apiWagers) {
      if (wager > 0 && markdownWagers.has(wager)) {
        matchCount++;
      }
    }

    // Also check for approximate matches (within 1%)
    if (matchCount === 0) {
      const apiWagerArray = Array.from(apiWagers).filter(w => w > 0);
      const markdownWagerArray = Array.from(markdownWagers).filter(w => w > 0);

      for (const apiWager of apiWagerArray) {
        for (const mdWager of markdownWagerArray) {
          const diff = Math.abs(apiWager - mdWager);
          const threshold = Math.max(apiWager, mdWager) * 0.01; // 1% tolerance
          if (diff <= threshold) {
            matchCount++;
            break;
          }
        }
        if (matchCount > 0) break;
      }
    }

    // If no wager matches at all AND API has fewer/equal entries than markdown,
    // the API data is likely stale - remove it from fusion.
    // BUT: If API has MORE entries than markdown, it's likely the more complete source
    // (markdown may only be extracting podium entries), so keep it.
    const apiEntryCount = strategyResults.api.entries.length;
    const markdownEntryCount = strategyResults.markdown.entries.length;

    if (matchCount === 0 && apiWagers.size > 0 && markdownWagers.size > 0) {
      if (apiEntryCount <= markdownEntryCount) {
        log('FUSION', `Stale API data detected: no wager matches and API (${apiEntryCount} entries) <= markdown (${markdownEntryCount} entries)`);
        log('FUSION', `Removing stale API data from fusion to prevent data corruption`);
        delete strategyResults.api;
        sourceCount = Object.keys(strategyResults).length;
      } else {
        log('FUSION', `API has more entries (${apiEntryCount}) than markdown (${markdownEntryCount}) - keeping API despite no wager matches`);
      }
    }
  }

  // Vision validation: If Vision provided expectedRank1, validate strategies against it
  // Strategies that match Vision's expected data get a confidence boost
  // Strategies that don't match get penalized
  if (expectedRank1 && expectedRank1.wager > 0) {
    log('FUSION', `Vision validation: expecting rank #1 wager=$${expectedRank1.wager}, prize=$${expectedRank1.prize || 0}`);

    const visionWager = expectedRank1.wager;
    const visionPrize = expectedRank1.prize || 0;

    for (const [strategyName, result] of Object.entries(strategyResults)) {
      const rank1 = result.entries.find(e => e.rank === 1) || result.entries[0];
      if (!rank1) continue;

      const stratWager = rank1.wager || 0;
      const stratPrize = rank1.prize || 0;

      // Check if this strategy's rank #1 matches Vision (within 5% tolerance)
      const wagerMatch = visionWager > 0 && Math.abs(visionWager - stratWager) / visionWager < 0.05;
      const prizeMatch = visionPrize > 0 && Math.abs(visionPrize - stratPrize) / Math.max(visionPrize, 1) < 0.05;

      if (wagerMatch) {
        // Strategy matches Vision's expected rank #1 - boost confidence
        const boost = 15;
        result.confidence = Math.min(100, result.confidence + boost);
        result._visionValidated = true;
        log('FUSION', `  ${strategyName}: MATCHES Vision rank #1 (wager $${stratWager}) - confidence +${boost} → ${result.confidence}`);
      } else {
        // Strategy doesn't match - penalize it (might be extracting from wrong leaderboard)
        const penalty = 20;
        result.confidence = Math.max(0, result.confidence - penalty);
        result._visionMismatch = true;
        log('FUSION', `  ${strategyName}: MISMATCH Vision rank #1 (expected $${visionWager}, got $${stratWager}) - confidence -${penalty} → ${result.confidence}`);
      }
    }

    sourceCount = Object.keys(strategyResults).length;
  }

  // Cross-validate if multiple sources
  let crossValidation = null;
  if (sourceCount >= FUSION_CONFIG.MIN_SOURCES_FOR_VERIFICATION) {
    crossValidation = crossValidate(strategyResults);
    log('FUSION', `Cross-validation: ${(crossValidation.overallAgreement * 100).toFixed(1)}% agreement`);
  }

  // Fuse results
  const fused = fuseResults(strategyResults, crossValidation);

  // Calculate final confidence
  const baseConfidence = calculateBaseConfidence(strategyResults, crossValidation);
  const adjustedConfidence = Math.min(100, Math.max(0,
    baseConfidence + (crossValidation?.confidenceAdjustment || 0)
  ));

  // Determine primary extraction method: prefer by confidence, then API > DOM > OCR (strategy priority)
  const SOURCE_PRIORITY = { api: 0, markdown: 1, dom: 2, geometric: 3, ocr: 4 };
  const primaryMethod = crossValidation?.recommendedSource ||
    Object.keys(strategyResults).sort((a, b) => {
      const confDiff = strategyResults[b].confidence - strategyResults[a].confidence;
      if (confDiff !== 0) return confDiff;
      return (SOURCE_PRIORITY[a] ?? 5) - (SOURCE_PRIORITY[b] ?? 5);
    })[0];

  log('FUSION', `Fused ${fused.entries.length} entries, confidence ${adjustedConfidence}, primary: ${primaryMethod}`);

  return {
    entries: fused.entries,
    prizes: fused.prizes,
    confidence: adjustedConfidence,
    extractionMethod: primaryMethod,
    crossValidation,
    sourceBreakdown: strategyResults,
    metadata: {
      fusedAt: new Date().toISOString(),
      sourcesUsed: Object.keys(strategyResults),
      sourceCount
    },
    errors
  };
}

// ============================================================================
// RESULT FUSION
// ============================================================================

/**
 * Fuse results from multiple strategies
 * @param {Object} strategyResults - Map of strategy name -> result
 * @param {Object|null} crossValidation - Cross-validation report
 * @returns {Object} - Fused entries and prizes
 */
function fuseResults(strategyResults, crossValidation) {
  const sources = Object.entries(strategyResults);

  if (sources.length === 0) {
    return { entries: [], prizes: [] };
  }

  if (sources.length === 1) {
    // Single source - tag entries as unverified
    const [name, result] = sources[0];
    const entries = result.entries.map(entry => ({
      ...entry,
      _fusion: {
        sources: [name],
        agreementScore: 0,
        verificationStatus: 'single_source'
      }
    }));
    return { entries, prizes: result.prizes };
  }

  // Multiple sources - fuse by rank+wager (handles different username masking across sources)
  const entryMaps = sources.map(([name, result]) => ({
    name,
    map: buildEntryMap(result.entries),
    confidence: result.confidence
  }));

  // Collect all unique keys (rank|wager)
  const allKeys = new Set();
  for (const { map } of entryMaps) {
    for (const key of map.keys()) {
      allKeys.add(key);
    }
  }

  // Build fused entries
  const fusedEntries = [];

  for (const key of allKeys) {
    // Find entries across sources
    const entriesForUser = [];
    for (const { name, map, confidence } of entryMaps) {
      const entry = map.get(key);
      if (entry) {
        entriesForUser.push({ source: name, entry, confidence });
      }
    }

    // Fuse this entry
    const fusedEntry = fuseEntry(entriesForUser, crossValidation);
    if (fusedEntry) {
      fusedEntries.push(fusedEntry);
    }
  }

  // Sort by rank
  fusedEntries.sort((a, b) => a.rank - b.rank);

  // Find the max rank from multi-source (verified) entries
  // AND from API (which is generally reliable even without DOM confirmation)
  let maxVerifiedRank = 0;
  let maxApiRank = 0;
  let maxMarkdownRank = 0;
  let maxDomRank = 0;
  let markdownConfidence = 0;
  let domConfidence = 0;
  const multiSourceWagers = new Set();
  for (const entry of fusedEntries) {
    if (entry._fusion?.sources?.length > 1) {
      if (entry.rank > maxVerifiedRank) {
        maxVerifiedRank = entry.rank;
      }
      const wager = Math.round(entry.wager);
      if (wager > 0) {
        multiSourceWagers.add(wager);
      }
    }
    // Track max rank from API source (API is reliable even without cross-validation)
    if (entry._fusion?.sources?.includes('api') && entry.rank > maxApiRank) {
      maxApiRank = entry.rank;
    }
    // Track max rank from markdown source
    if (entry._fusion?.sources?.includes('markdown') && entry.rank > maxMarkdownRank) {
      maxMarkdownRank = entry.rank;
    }
    // Track max rank from DOM source
    if (entry._fusion?.sources?.includes('dom') && entry.rank > maxDomRank) {
      maxDomRank = entry.rank;
    }
  }

  // Get strategy confidences if available
  if (strategyResults.markdown) {
    markdownConfidence = strategyResults.markdown.confidence || 0;
  }
  if (strategyResults.dom) {
    domConfidence = strategyResults.dom.confidence || 0;
  }

  // Determine effective max rank for filtering
  // Use the higher of verified rank or API rank as the baseline
  // BUT: If a source has high confidence AND found significantly more entries,
  // trust that source's max rank instead (don't filter its entries based on incomplete parsing)
  let effectiveMaxRank = Math.max(maxVerifiedRank, maxApiRank);

  // If markdown has high confidence and significantly more entries than the effective max,
  // trust markdown's full range (it's likely the most accurate source)
  if (markdownConfidence >= 70 && maxMarkdownRank > effectiveMaxRank * 2 && maxMarkdownRank >= 20) {
    log('FUSION', `Trusting high-confidence markdown source (${markdownConfidence}%): max rank ${maxMarkdownRank} vs verified/API max ${effectiveMaxRank}`);
    effectiveMaxRank = maxMarkdownRank;
  }

  // IMPORTANT: If DOM has high confidence and found MORE entries than markdown,
  // trust DOM's full range. This handles cases where markdown table parsing fails
  // (e.g., multi-line table rows) but DOM correctly extracted all entries.
  // Only do this if DOM found at least 5 entries (to avoid trusting garbage DOM)
  if (domConfidence >= 85 && maxDomRank > effectiveMaxRank && maxDomRank >= 5) {
    log('FUSION', `Trusting high-confidence DOM source (${domConfidence}%): max rank ${maxDomRank} vs current effective max ${effectiveMaxRank}`);
    effectiveMaxRank = maxDomRank;
  }

  const cleanedEntries = fusedEntries.filter(entry => {
    // Keep multi-source entries (they're verified)
    if (entry._fusion?.sources?.length > 1) return true;

    // Keep single-source API entries - API data is structured and reliable
    // Only filter DOM-only entries beyond the verified/API max rank
    const source = entry._fusion?.sources?.[0];
    if (source === 'api') return true;

    // Keep single-source markdown entries if markdown has high confidence
    // Markdown extraction is reliable and should not be filtered by low-quality OCR
    if (source === 'markdown' && markdownConfidence >= 70) return true;

    // Reject single-source DOM/OCR entries with ranks beyond the effective max
    // These are extraction noise (picking up elements outside the leaderboard)
    if (effectiveMaxRank > 0 && entry.rank > effectiveMaxRank) {
      log('FUSION', `Filtering out-of-range entry: ${entry.username} (rank ${entry.rank}) - beyond max rank ${effectiveMaxRank} from single source ${source}`);
      return false;
    }

    // Check if this single-source entry has the same wager as a verified multi-source entry
    const wager = Math.round(entry.wager);
    if (wager > 0 && multiSourceWagers.has(wager)) {
      // Single-source entry duplicates a verified entry's wager = likely parsing bug
      log('FUSION', `Filtering suspicious entry: ${entry.username} (rank ${entry.rank}) - duplicate wager $${wager} from single source ${source}`);
      return false;
    }

    return true;
  });

  // Fuse prizes (prefer source with most complete prize data)
  const fusedPrizes = fusePrizes(strategyResults);

  // NOTE: Prize ordering validation was removed in v7.25
  // The previous logic (clearing ALL DOM prizes on any ordering "violation") was too aggressive
  // and caused valid prizes to be lost on sites like wrewards.com where:
  // - API provides prizes for ranks 2-50
  // - HTML/DOM provides the special #1 prize that's not in API
  // Clearing all DOM prizes lost the #1 prize ($30,000) entirely
  //
  // Instead, we now trust the fusion logic to prefer higher-confidence sources
  // and merge prizes from multiple sources when API data is incomplete.

  return { entries: cleanedEntries, prizes: fusedPrizes };
}

/**
 * Fuse a single entry from multiple sources
 * @param {Array} entriesForUser - Array of { source, entry, confidence }
 * @param {Object|null} crossValidation - Cross-validation report
 * @returns {Object|null} - Fused entry
 */
function fuseEntry(entriesForUser, crossValidation) {
  if (entriesForUser.length === 0) return null;

  const sources = entriesForUser.map(e => e.source);

  // Single source
  if (entriesForUser.length === 1) {
    const { source, entry } = entriesForUser[0];
    return {
      ...entry,
      _fusion: {
        sources: [source],
        agreementScore: 0,
        verificationStatus: 'single_source',
        fieldSources: {
          username: { source, confidence: entriesForUser[0].confidence },
          rank: { source, confidence: entriesForUser[0].confidence },
          wager: { source, confidence: entriesForUser[0].confidence },
          prize: { source, confidence: entriesForUser[0].confidence }
        }
      }
    };
  }

  // Multiple sources - pick best value for each field
  const bestEntry = {
    rank: 0,
    username: '',
    wager: 0,
    prize: 0
  };
  const fieldSources = {};

  // Username: pick from highest confidence source
  const sortedByConfidence = [...entriesForUser].sort((a, b) => b.confidence - a.confidence);
  bestEntry.username = sortedByConfidence[0].entry.username;
  fieldSources.username = {
    source: sortedByConfidence[0].source,
    confidence: sortedByConfidence[0].confidence
  };

  // Rank: prefer most common value, then highest confidence
  const rankVotes = {};
  for (const { source, entry, confidence } of entriesForUser) {
    const rank = entry.rank;
    if (!rankVotes[rank]) rankVotes[rank] = [];
    rankVotes[rank].push({ source, confidence });
  }
  const bestRank = Object.entries(rankVotes)
    .sort((a, b) => {
      // Sort by vote count, then by max confidence
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return Math.max(...b[1].map(v => v.confidence)) - Math.max(...a[1].map(v => v.confidence));
    })[0];
  bestEntry.rank = parseInt(bestRank[0]);
  fieldSources.rank = {
    source: bestRank[1][0].source,
    confidence: bestRank[1][0].confidence
  };

  // Wager: prefer highest non-zero value from high-confidence source
  const wagerOptions = entriesForUser
    .filter(e => e.entry.wager > 0)
    .sort((a, b) => b.confidence - a.confidence);
  if (wagerOptions.length > 0) {
    bestEntry.wager = wagerOptions[0].entry.wager;
    fieldSources.wager = {
      source: wagerOptions[0].source,
      confidence: wagerOptions[0].confidence
    };
  } else {
    bestEntry.wager = 0;
    fieldSources.wager = { source: 'none', confidence: 0 };
  }

  // Prize: prefer highest non-zero value from high-confidence source
  // But REJECT garbage DOM prizes where prize ≈ rank number (common extraction bug)
  const prizeOptions = entriesForUser
    .filter(e => {
      if (e.entry.prize <= 0) return false;

      // Detect garbage DOM prize: prize value equals or is near the rank number
      // This happens when DOM extraction picks up rank numbers as prizes
      // E.g., rank 32 with prize $21-32 is almost certainly garbage
      if (e.source === 'dom') {
        const rank = e.entry.rank || bestEntry.rank;
        const prize = e.entry.prize;
        // Garbage pattern: prize is within ±15 of rank AND prize < 100
        // (Real prizes at position 32+ would never be exactly $21-$45)
        if (prize < 100 && Math.abs(prize - rank) <= 15) {
          log('FUSION', `Rejecting garbage DOM prize: rank ${rank} prize $${prize} (likely rank number)`);
          return false;
        }
        // Also reject if prize equals rank exactly (even for larger values)
        if (prize === rank) {
          log('FUSION', `Rejecting garbage DOM prize: rank ${rank} prize $${prize} (equals rank)`);
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence);
  if (prizeOptions.length > 0) {
    bestEntry.prize = prizeOptions[0].entry.prize;
    fieldSources.prize = {
      source: prizeOptions[0].source,
      confidence: prizeOptions[0].confidence
    };
  } else {
    bestEntry.prize = 0;
    fieldSources.prize = { source: 'none', confidence: 0 };
  }

  // Calculate agreement score
  const normalized = normalizeUsername(bestEntry.username);
  const entryAgreement = crossValidation?.entryAgreement?.[normalized];
  const agreementScore = entryAgreement?.status === 'agreed' ? 1 :
    entryAgreement?.status === 'disputed' ? 0.5 : 0;

  // Determine verification status
  let verificationStatus = 'single_source';
  if (sources.length >= 2) {
    verificationStatus = agreementScore >= FUSION_CONFIG.AGREEMENT_THRESHOLD ? 'verified' : 'disputed';
  }

  return {
    ...bestEntry,
    _fusion: {
      sources,
      agreementScore,
      verificationStatus,
      fieldSources
    }
  };
}

/**
 * Fuse prize tables from multiple sources
 * @param {Object} strategyResults - Map of strategy name -> result
 * @returns {Array} - Fused prize table with _totalPrizePool if available
 */
function fusePrizes(strategyResults) {
  // Find source with most complete prize data
  let bestPrizes = [];
  let bestCount = 0;
  let totalPrizePool = 0;

  for (const [name, result] of Object.entries(strategyResults)) {
    if (result.prizes && result.prizes.length > bestCount) {
      bestPrizes = result.prizes;
      bestCount = result.prizes.length;
      // Preserve _totalPrizePool from best source
      if (result.prizes._totalPrizePool) {
        totalPrizePool = result.prizes._totalPrizePool;
      }
    }
    // Also capture totalPrizePool even if it's not the best prize source
    if (result.prizes?._totalPrizePool && result.prizes._totalPrizePool > totalPrizePool) {
      totalPrizePool = result.prizes._totalPrizePool;
    }
  }

  // Also check for injected prizes in entries
  for (const [name, result] of Object.entries(strategyResults)) {
    const injectedPrizes = result.entries
      .filter(e => e._prizeInjected && e.prize > 0)
      .map(e => ({ rank: e.rank, prize: e.prize }));

    if (injectedPrizes.length > bestCount) {
      bestPrizes = injectedPrizes;
      bestCount = injectedPrizes.length;
    }
  }

  // Preserve _totalPrizePool on the result array
  if (totalPrizePool > 0) {
    bestPrizes._totalPrizePool = totalPrizePool;
  }

  return bestPrizes;
}

// ============================================================================
// CONFIDENCE CALCULATION
// ============================================================================

/**
 * Calculate base confidence from strategy results
 * @param {Object} strategyResults - Map of strategy name -> result
 * @param {Object|null} crossValidation - Cross-validation report
 * @returns {number} - Base confidence (0-100)
 */
function calculateBaseConfidence(strategyResults, crossValidation) {
  const sources = Object.values(strategyResults);

  if (sources.length === 0) return 0;

  // Start with average of source confidences
  const avgConfidence = sources.reduce((sum, s) => sum + s.confidence, 0) / sources.length;

  // Bonus for multiple sources
  let bonus = 0;
  if (sources.length >= 3) {
    bonus = FUSION_CONFIG.MAX_CONFIDENCE_BOOST;
  } else if (sources.length >= 2) {
    bonus = FUSION_CONFIG.MIN_CONFIDENCE_BOOST;
  } else {
    bonus = -FUSION_CONFIG.SINGLE_SOURCE_PENALTY;
  }

  // Bonus for high cross-validation agreement
  if (crossValidation) {
    if (crossValidation.overallAgreement >= 0.9) {
      bonus += 10;
    } else if (crossValidation.overallAgreement >= 0.7) {
      bonus += 5;
    }
  }

  return Math.round(avgConfidence + bonus);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main function
  fuseExtractionResults,

  // Fusion helpers
  fuseResults,
  fuseEntry,
  fusePrizes,

  // Confidence
  calculateBaseConfidence,

  // Config
  FUSION_CONFIG
};
