/**
 * Data Extractor - Core Module
 *
 * RESPONSIBILITY: Parse raw page data into leaderboard entries
 * - Run ALL viable extraction strategies (hybrid approach)
 * - Cross-validate results between sources
 * - Fuse data from multiple strategies
 * - Calculate confidence with multi-source verification
 *
 * INPUT:  { html, markdown, apiCalls, rawJsonResponses, screenshot, config }
 * OUTPUT: { entries[], prizes[], metadata, confidence, extractionMethod, crossValidation, errors[] }
 *
 * Strategies are loaded from the strategies/ directory.
 * Fusion layer handles multi-source extraction and validation.
 */

const { log } = require('../shared/utils');
const { calculateConfidence, validateAndCleanEntries } = require('../shared/entry-validation');
const { fuseExtractionResults } = require('./data-fusion');

// Load external strategies
const { DEFAULT_STRATEGIES } = require('../strategies');

// ============================================================================
// TYPES (JSDoc for clarity)
// ============================================================================

/**
 * @typedef {Object} ExtractorInput
 * @property {string} html - Raw HTML content
 * @property {string} markdown - Markdown content
 * @property {Array} apiCalls - API URLs called
 * @property {Array} rawJsonResponses - Raw JSON API responses
 * @property {Buffer|null} screenshot - Screenshot for OCR fallback
 * @property {import('playwright').Page} [page] - Optional page for dynamic extraction
 * @property {Object} config - Extractor configuration
 */

/**
 * @typedef {Object} ExtractorOutput
 * @property {Array<{rank: number, username: string, wager: number, prize: number}>} entries
 * @property {Array<{rank: number, prize: number}>} prizes - Prize table
 * @property {Object} metadata - Extraction metadata
 * @property {number} confidence - Confidence score (0-100)
 * @property {string} extractionMethod - Method used (api|dom|geometric|ocr)
 * @property {string[]} errors - Any errors encountered
 */

/**
 * @typedef {Object} ExtractionStrategy
 * @property {string} name - Strategy name
 * @property {number} priority - Execution priority (lower = first)
 * @property {function} canExtract - Check if strategy can extract from this input
 * @property {function} extract - Perform extraction
 */

// ============================================================================
// MAIN EXTRACTION FUNCTION
// ============================================================================

/**
 * Extract leaderboard entries from raw page data
 * Uses hybrid extraction: runs ALL viable strategies and fuses results
 *
 * @param {ExtractorInput} input - Extractor input
 * @returns {Promise<ExtractorOutput>} - Extraction results
 */
async function extractLeaderboardData(input) {
  const { config = {} } = input;
  const {
    minConfidence = 50,
    strategies = DEFAULT_STRATEGIES,
    useFusion = true,
    siteName = null,
    learnedPatterns = null,
    knownKeywords = [],  // All known leaderboard keywords for filtering wrong-site APIs
    podiumLayout = null,  // Vision-learned: "center_first" | "left_to_right" | "no_podium"
    prizeBeforeWager = null,  // Vision-learned: true if prize column appears before wager
    expectedRank1 = null  // Vision-learned: { username, wager, prize } for rank #1 validation
  } = config;

  log('EXTRACT', `Starting data extraction (fusion: ${useFusion})...`);

  // Use fusion layer for multi-source extraction
  if (useFusion) {
    try {
      const fusionResult = await fuseExtractionResults(input, strategies, {
        minConfidence,
        siteName,
        learnedPatterns,
        knownKeywords,
        podiumLayout,
        prizeBeforeWager,
        expectedRank1
      });

      // Validate and clean fused entries
      if (fusionResult.entries && fusionResult.entries.length > 0) {
        const validationResult = validateAndCleanEntries(fusionResult.entries);
        const cleanedEntries = Array.isArray(validationResult) ? validationResult : validationResult.cleaned;

        if (cleanedEntries && cleanedEntries.length > 0) {
          log('EXTRACT', `Fusion complete: ${cleanedEntries.length} entries via ${fusionResult.extractionMethod} (confidence: ${fusionResult.confidence})`);

          return {
            entries: cleanedEntries,
            prizes: fusionResult.prizes || [],
            metadata: {
              extractedAt: new Date().toISOString(),
              strategiesTried: fusionResult.metadata?.sourcesUsed || [],
              sourceCount: fusionResult.metadata?.sourceCount || 1,
              apiUrl: fusionResult.sourceBreakdown?.api?.apiUrl
            },
            confidence: fusionResult.confidence,
            extractionMethod: fusionResult.extractionMethod,
            crossValidation: fusionResult.crossValidation,
            sourceBreakdown: fusionResult.sourceBreakdown,
            errors: fusionResult.errors || []
          };
        }
      }

      // Fusion found no valid entries
      log('EXTRACT', 'Fusion found no valid entries');
      return {
        entries: [],
        prizes: [],
        metadata: {
          extractedAt: new Date().toISOString(),
          strategiesTried: fusionResult.metadata?.sourcesUsed || []
        },
        confidence: 0,
        extractionMethod: 'none',
        crossValidation: fusionResult.crossValidation,
        errors: fusionResult.errors || []
      };

    } catch (fusionError) {
      log('ERR', `Fusion layer error: ${fusionError.message}, falling back to sequential`);
      // Fall through to legacy sequential extraction
    }
  }

  // Legacy fallback: first-success sequential extraction
  return extractLeaderboardDataLegacy(input, strategies, minConfidence);
}

/**
 * Legacy extraction: first-success-wins pattern
 * Used as fallback when fusion fails
 * @param {ExtractorInput} input - Extractor input
 * @param {Array} strategies - Extraction strategies
 * @param {number} minConfidence - Minimum confidence threshold
 * @returns {Promise<ExtractorOutput>} - Extraction results
 */
async function extractLeaderboardDataLegacy(input, strategies, minConfidence) {
  const result = {
    entries: [],
    prizes: [],
    metadata: {
      extractedAt: new Date().toISOString(),
      strategiesTried: [],
      legacyMode: true
    },
    confidence: 0,
    extractionMethod: 'none',
    errors: []
  };

  log('EXTRACT', 'Using legacy sequential extraction...');

  // Sort strategies by priority
  const sortedStrategies = [...strategies].sort((a, b) => a.priority - b.priority);

  // Try each strategy in order
  for (const strategy of sortedStrategies) {
    result.metadata.strategiesTried.push(strategy.name);

    if (!strategy.canExtract(input)) {
      log('EXTRACT', `Strategy ${strategy.name}: cannot extract (missing input)`);
      continue;
    }

    try {
      const strategyResult = await strategy.extract(input);

      if (strategyResult && strategyResult.entries && strategyResult.entries.length > 0) {
        // Validate and clean entries
        const validationResult = validateAndCleanEntries(strategyResult.entries);
        const cleanedEntries = Array.isArray(validationResult) ? validationResult : validationResult.cleaned;

        if (cleanedEntries && cleanedEntries.length > 0) {
          const confidence = strategyResult.confidence || calculateConfidence(cleanedEntries);

          log('EXTRACT', `Strategy ${strategy.name}: ${cleanedEntries.length} entries, confidence ${confidence}`);

          // Check if this meets minimum confidence
          if (confidence >= minConfidence) {
            result.entries = cleanedEntries;
            result.prizes = strategyResult.prizes || [];
            result.confidence = confidence;
            result.extractionMethod = strategy.name;
            result.metadata.apiUrl = strategyResult.apiUrl;

            log('EXTRACT', `Extraction complete: ${cleanedEntries.length} entries via ${strategy.name}`);
            return result;
          }

          // Store as potential result if nothing better found
          if (confidence > result.confidence) {
            result.entries = cleanedEntries;
            result.prizes = strategyResult.prizes || [];
            result.confidence = confidence;
            result.extractionMethod = strategy.name;
            result.metadata.apiUrl = strategyResult.apiUrl;
          }
        }
      }
    } catch (error) {
      log('ERR', `Strategy ${strategy.name} error: ${error.message}`);
      result.errors.push(`${strategy.name}: ${error.message}`);
    }
  }

  // Return best result found (even if below minConfidence)
  if (result.entries.length > 0) {
    log('EXTRACT', `Best result: ${result.entries.length} entries via ${result.extractionMethod} (confidence: ${result.confidence})`);
  } else {
    log('EXTRACT', 'No entries extracted from any strategy');
  }

  return result;
}



// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main extraction
  extractLeaderboardData,

  // Legacy extraction (for backwards compatibility)
  extractLeaderboardDataLegacy,

  // Re-export strategies for convenience
  DEFAULT_STRATEGIES
};
