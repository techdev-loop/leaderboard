/**
 * Extraction Strategies - Index
 *
 * Pluggable extraction strategies for the data-extractor.
 * Each strategy implements the same interface:
 *
 *   strategy = {
 *     name: string,
 *     priority: number,      // Lower = tried first
 *     canExtract(input): boolean,
 *     extract(input): Promise<{entries, prizes, confidence} | null>
 *   }
 *
 * Priority order:
 *   1. API (most reliable when available)
 *   1.5. Markdown (parses markdown content)
 *   2. DOM (parses HTML structure)
 *   3. Geometric (visual/spatial analysis)
 *   4. OCR (last resort, screenshot-based)
 *
 * Usage:
 *   const { strategies, DEFAULT_STRATEGIES } = require('./strategies');
 *
 *   // Use specific strategy
 *   const result = await strategies.api.strategy.extract(input);
 *
 *   // Use all strategies in order
 *   for (const strategy of DEFAULT_STRATEGIES) {
 *     if (strategy.canExtract(input)) {
 *       const result = await strategy.extract(input);
 *       if (result && result.confidence >= threshold) {
 *         return result;
 *       }
 *     }
 *   }
 */

const api = require('./api-extraction');
const markdown = require('./markdown-extraction');
const dom = require('./dom-extraction');
const geometric = require('./geometric-extraction');
const ocr = require('./ocr-extraction');

// All strategies
const strategies = {
  api,
  markdown,
  dom,
  geometric,
  ocr
};

// Default strategy order (sorted by priority)
const DEFAULT_STRATEGIES = [
  api.strategy,
  markdown.strategy,
  dom.strategy,
  geometric.strategy,
  ocr.strategy
].sort((a, b) => a.priority - b.priority);

// Strategy names for logging/debugging
const STRATEGY_NAMES = DEFAULT_STRATEGIES.map(s => s.name);

/**
 * Get a strategy by name
 * @param {string} name - Strategy name
 * @returns {Object|null} - Strategy object or null
 */
function getStrategy(name) {
  const strategyModule = strategies[name];
  return strategyModule ? strategyModule.strategy : null;
}

/**
 * Get strategies above a certain priority threshold
 * @param {number} maxPriority - Maximum priority (inclusive)
 * @returns {Array} - Strategies with priority <= maxPriority
 */
function getStrategiesUpTo(maxPriority) {
  return DEFAULT_STRATEGIES.filter(s => s.priority <= maxPriority);
}

module.exports = {
  // Individual strategy modules
  strategies,

  // Default strategy order
  DEFAULT_STRATEGIES,

  // Strategy names
  STRATEGY_NAMES,

  // Helper functions
  getStrategy,
  getStrategiesUpTo,

  // Direct exports for convenience
  apiStrategy: api.strategy,
  markdownStrategy: markdown.strategy,
  domStrategy: dom.strategy,
  geometricStrategy: geometric.strategy,
  ocrStrategy: ocr.strategy
};
