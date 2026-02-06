# Self-Healing Extraction System - Implementation Plan

> **Version**: v1.0 Draft
> **Author**: AI Assistant
> **Date**: January 31, 2026
> **Status**: PROPOSAL - Awaiting Review

---

## Executive Summary

This document outlines a comprehensive plan to implement a **self-healing extraction system** for the ARGUS leaderboard scraper. The system will automatically detect when extractions produce anomalous results and attempt to correct them without manual intervention.

### Problem Statement

The current scraper handles 500+ sites with different formats. Issues include:
- Wager/prize values getting swapped
- Sudden rows with $0 values
- Incorrect column order detection
- Sites changing layouts without detection
- Manual testing required for each site

### Proposed Solution

A 4-phase self-healing system that:
1. **Stores baselines** from successful extractions
2. **Detects anomalies** by comparing current results to baselines
3. **Self-heals** by trying alternative parsing configurations
4. **Learns** from successful corrections

### Expected Outcomes

| Metric | Current | Expected |
|--------|---------|----------|
| Manual site testing required | 100% | <20% |
| Anomaly detection rate | 0% | >80% |
| Auto-correction success | 0% | >60% |
| Time to detect bad data | Hours (manual) | <1 minute |

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Phase 1: Baseline Storage](#phase-1-baseline-storage)
3. [Phase 2: Anomaly Detection](#phase-2-anomaly-detection)
4. [Phase 3: Self-Healing Loop](#phase-3-self-healing-loop)
5. [Phase 4: Review Queue & Admin](#phase-4-review-queue--admin)
6. [File Structure](#file-structure)
7. [Data Flow Diagrams](#data-flow-diagrams)
8. [Integration Points](#integration-points)
9. [Testing Strategy](#testing-strategy)
10. [Rollout Plan](#rollout-plan)
11. [Risk Assessment](#risk-assessment)

---

## Architecture Overview

### Current Data Flow

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Crawler   │───►│   Scraper   │───►│  Extractor  │───►│   Output    │
│  (Discover) │    │  (Collect)  │    │   (Parse)   │    │   (Save)    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### Proposed Data Flow (With Self-Healing)

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Crawler   │───►│   Scraper   │───►│  Extractor  │
│  (Discover) │    │  (Collect)  │    │   (Parse)   │
└─────────────┘    └─────────────┘    └──────┬──────┘
                                             │
                                             ▼
                   ┌─────────────────────────────────────────────┐
                   │           SELF-HEALING LAYER (NEW)          │
                   │                                             │
                   │  ┌─────────────┐    ┌─────────────────────┐ │
                   │  │  Baseline   │◄───┤  Anomaly Detector   │ │
                   │  │   Store     │    │  (Compare to base)  │ │
                   │  └──────┬──────┘    └──────────┬──────────┘ │
                   │         │                      │            │
                   │         │           ┌──────────▼──────────┐ │
                   │         │           │   Self-Healer       │ │
                   │         │           │ (Try alternatives)  │ │
                   │         │           └──────────┬──────────┘ │
                   │         │                      │            │
                   │         │           ┌──────────▼──────────┐ │
                   │         └──────────►│   Learning Loop     │ │
                   │                     │ (Update configs)    │ │
                   │                     └─────────────────────┘ │
                   └─────────────────────────────────────────────┘
                                             │
                                             ▼
                                    ┌─────────────┐
                                    │   Output    │
                                    │   (Save)    │
                                    └─────────────┘
```

### Design Principles

Per `PROJECT_RULES.md` and `scraper_details.md`:

1. **Separation of Concerns**: Each new module has ONE responsibility
2. **Non-Destructive**: Changes are ADDITIVE, not destructive to existing logic
3. **File Size Limits**: No file exceeds 400 lines
4. **No Assumptions**: Never assume site-specific patterns are universal
5. **Regression Safety**: All changes must pass regression tests on 4 reference sites

---

## Phase 1: Baseline Storage

### Purpose

Store "golden baselines" from successful high-confidence extractions. These baselines capture the expected shape of data for each site/leaderboard combination.

### New File: `shared/baseline-store.js`

**Location**: `/lbscraper/shared/baseline-store.js`
**Max Lines**: ~300
**Responsibility**: Store and retrieve extraction baselines

#### Data Structure

```javascript
/**
 * Baseline structure stored per leaderboard
 * Location: data/baselines/{domain}.json
 */
{
  "blaffsen.com": {
    "leaderboards": {
      "clash": {
        // Core statistics for anomaly detection
        "statistics": {
          "entryCount": {
            "expected": 10,
            "min": 8,
            "max": 12,
            "history": [10, 10, 11, 10, 10]  // Last 5 runs
          },
          "prizeCount": {
            "expected": 10,
            "zeroRate": 0.0,  // % of entries with prize=0
            "history": [10, 10, 10, 10, 10]
          },
          "wagerMagnitude": {
            "min": 100,        // Minimum wager seen
            "max": 100000,     // Maximum wager seen
            "avgLog10": 4.2    // Average order of magnitude (log10)
          },
          "prizeMagnitude": {
            "min": 50,
            "max": 2000,
            "avgLog10": 2.5
          }
        },

        // Parsing configuration learned from success
        "parsingConfig": {
          "columnOrder": "prize_before_wager",  // or "wager_before_prize"
          "prizePattern": "icon_prefix",        // or "currency_prefix", "label_prefix", "bare"
          "wagerPattern": "label_prefix",       // "Wagered:" prefix detected
          "iconPatterns": ["gem", "coin"],      // Icons seen before prizes
          "currencySymbol": null,               // or "$", "€", etc.
          "tableHeaderDetected": true           // Table has header row
        },

        // Sample entries for structure validation
        "sampleEntries": [
          {
            "rank": 1,
            "wagerRange": [50000, 100000],  // Expected range
            "prizeRange": [1000, 2000],
            "usernamePattern": "alphanumeric"  // or "censored", "email", etc.
          },
          {
            "rank": 5,
            "wagerRange": [500, 5000],
            "prizeRange": [100, 500],
            "usernamePattern": "alphanumeric"
          }
        ],

        // Metadata
        "createdAt": "2026-01-31T19:00:00Z",
        "lastValidatedAt": "2026-01-31T20:00:00Z",
        "successStreak": 15,
        "confidence": 92
      }
    },
    "globalConfig": {
      "siteType": "affiliate",        // Site category
      "hasApi": false,                // API available?
      "primarySource": "markdown",    // Best extraction source
      "lastFullScan": "2026-01-31T00:00:00Z"
    }
  }
}
```

#### API Functions

```javascript
// ============================================================================
// BASELINE STORE API
// ============================================================================

/**
 * Get baseline for a specific leaderboard
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} domain - Domain name (e.g., "blaffsen.com")
 * @param {string} leaderboardName - Leaderboard name (e.g., "clash")
 * @returns {Object|null} - Baseline data or null if not exists
 */
function getBaseline(basePath, domain, leaderboardName) { }

/**
 * Store/update baseline from successful extraction
 * Only stores if confidence >= 80 and no anomalies detected
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @param {Object} extractionResult - Successful extraction result
 * @param {Object} parsingConfig - Detected parsing configuration
 * @returns {boolean} - Whether baseline was stored
 */
function storeBaseline(basePath, domain, leaderboardName, extractionResult, parsingConfig) { }

/**
 * Update baseline statistics with new successful extraction
 * Maintains rolling history for trend detection
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @param {Object} extractionResult - Extraction result
 */
function updateBaselineStatistics(basePath, domain, leaderboardName, extractionResult) { }

/**
 * Get parsing config for a leaderboard
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @returns {Object|null} - Parsing config or null
 */
function getParsingConfig(basePath, domain, leaderboardName) { }

/**
 * Update parsing config after successful self-healing
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @param {Object} config - New parsing config
 */
function updateParsingConfig(basePath, domain, leaderboardName, config) { }

/**
 * Check if baseline exists and is valid (not expired)
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @returns {boolean} - Whether valid baseline exists
 */
function hasValidBaseline(basePath, domain, leaderboardName) { }
```

#### Implementation Notes

1. **File Storage**: Baselines stored in `data/baselines/{domain}.json` (one file per domain)
2. **History Rolling Window**: Keep last 5 extraction statistics for trend detection
3. **Expiry**: Baselines expire after 7 days without validation
4. **Confidence Threshold**: Only store baselines from extractions with confidence >= 80
5. **Sample Entry Selection**: Store entries for ranks 1, 3, 5, 10 (representative sample)

---

## Phase 2: Anomaly Detection

### Purpose

Detect when extraction results deviate significantly from established baselines. Flag anomalies by type to guide self-healing.

### New File: `shared/anomaly-detector.js`

**Location**: `/lbscraper/shared/anomaly-detector.js`
**Max Lines**: ~350
**Responsibility**: Compare extractions to baselines and identify anomalies

#### Anomaly Types

| Anomaly Code | Description | Detection Rule | Severity |
|--------------|-------------|----------------|----------|
| `SUDDEN_ZEROS` | Many entries have $0 values | Zero rate > baseline + 30% | HIGH |
| `ENTRY_COUNT_DROP` | Fewer entries than expected | Count < baseline.min - 2 | HIGH |
| `ENTRY_COUNT_SPIKE` | Way more entries than expected | Count > baseline.max * 2 | MEDIUM |
| `WAGER_MAGNITUDE_SHIFT` | Wagers are wrong order of magnitude | avgLog10 differs by > 2 | HIGH |
| `PRIZE_MAGNITUDE_SHIFT` | Prizes are wrong order of magnitude | avgLog10 differs by > 2 | HIGH |
| `LIKELY_SWAP` | Wager/prize appear swapped | Prize > Wager for >70% entries (opposite of baseline) | HIGH |
| `DUPLICATE_WAGERS` | Multiple entries have same wager | >3 identical wager values | MEDIUM |
| `ALL_SAME_PRIZE` | All prizes are identical | All non-zero prizes equal | MEDIUM |
| `MISSING_TOP_RANKS` | Missing ranks 1-3 | Ranks 1-3 not present | HIGH |
| `PRIZE_ORDER_VIOLATION` | Higher rank has lower prize | rank N prize < rank N+1 prize (for top 5) | MEDIUM |

#### API Functions

```javascript
// ============================================================================
// ANOMALY DETECTOR API
// ============================================================================

/**
 * Detect all anomalies in extraction result
 * @param {Object} extractionResult - Current extraction result
 * @param {Object} baseline - Baseline data for this leaderboard
 * @returns {Array<Object>} - Array of detected anomalies
 *   [{ code: 'SUDDEN_ZEROS', severity: 'HIGH', details: {...}, suggestedFix: 'swap_values' }]
 */
function detectAnomalies(extractionResult, baseline) { }

/**
 * Check for sudden zero values
 * @param {Array} entries - Extraction entries
 * @param {Object} baseline - Baseline statistics
 * @returns {Object|null} - Anomaly object or null
 */
function checkSuddenZeros(entries, baseline) { }

/**
 * Check for entry count anomalies
 * @param {Array} entries - Extraction entries
 * @param {Object} baseline - Baseline statistics
 * @returns {Object|null} - Anomaly object or null
 */
function checkEntryCount(entries, baseline) { }

/**
 * Check for magnitude shifts in wager/prize values
 * @param {Array} entries - Extraction entries
 * @param {Object} baseline - Baseline statistics
 * @param {string} field - 'wager' or 'prize'
 * @returns {Object|null} - Anomaly object or null
 */
function checkMagnitudeShift(entries, baseline, field) { }

/**
 * Check if wager/prize values appear swapped
 * @param {Array} entries - Extraction entries
 * @param {Object} baseline - Baseline statistics
 * @returns {Object|null} - Anomaly object or null
 */
function checkLikelySwap(entries, baseline) { }

/**
 * Check for duplicate wager values (Frankenstein entries)
 * @param {Array} entries - Extraction entries
 * @returns {Object|null} - Anomaly object or null
 */
function checkDuplicateWagers(entries) { }

/**
 * Check for prize ordering violations
 * @param {Array} entries - Extraction entries (sorted by rank)
 * @returns {Object|null} - Anomaly object or null
 */
function checkPrizeOrderViolation(entries) { }

/**
 * Calculate anomaly severity score
 * @param {Array<Object>} anomalies - Detected anomalies
 * @returns {number} - Total severity score (0-100)
 */
function calculateSeverityScore(anomalies) { }

/**
 * Get suggested fix for anomaly
 * @param {Object} anomaly - Anomaly object
 * @param {Object} parsingConfig - Current parsing config
 * @returns {Object} - Suggested parsing config change
 */
function getSuggestedFix(anomaly, parsingConfig) { }
```

#### Detection Logic Examples

```javascript
// Example: Detect likely swap
function checkLikelySwap(entries, baseline) {
  const validEntries = entries.filter(e => e.wager > 0 || e.prize > 0);
  if (validEntries.length < 3) return null;

  // Count entries where prize > wager
  const prizeHigherCount = validEntries.filter(e => e.prize > e.wager).length;
  const prizeHigherRate = prizeHigherCount / validEntries.length;

  // Get baseline rate
  const baselinePrizeHigherRate = baseline.statistics?.prizeHigherRate || 0.1;

  // If current rate is opposite of baseline (>70% vs <30%), likely swapped
  if (prizeHigherRate > 0.7 && baselinePrizeHigherRate < 0.3) {
    return {
      code: 'LIKELY_SWAP',
      severity: 'HIGH',
      details: {
        currentPrizeHigherRate: prizeHigherRate,
        baselineRate: baselinePrizeHigherRate,
        message: `Prize > Wager for ${(prizeHigherRate * 100).toFixed(0)}% of entries (baseline: ${(baselinePrizeHigherRate * 100).toFixed(0)}%)`
      },
      suggestedFix: { swapWagerPrize: true }
    };
  }

  return null;
}

// Example: Detect sudden zeros
function checkSuddenZeros(entries, baseline) {
  const zeroWagerCount = entries.filter(e => e.wager === 0).length;
  const zeroPrizeCount = entries.filter(e => e.prize === 0).length;

  const currentZeroWagerRate = zeroWagerCount / entries.length;
  const currentZeroPrizeRate = zeroPrizeCount / entries.length;

  const baselineZeroWagerRate = baseline.statistics?.wagerZeroRate || 0;
  const baselineZeroPrizeRate = baseline.statistics?.prizeZeroRate || 0;

  // Check for sudden increase in zeros (>30% more than baseline)
  if (currentZeroWagerRate > baselineZeroWagerRate + 0.3) {
    return {
      code: 'SUDDEN_ZEROS',
      severity: 'HIGH',
      details: {
        field: 'wager',
        currentRate: currentZeroWagerRate,
        baselineRate: baselineZeroWagerRate,
        message: `${(currentZeroWagerRate * 100).toFixed(0)}% of entries have $0 wager (baseline: ${(baselineZeroWagerRate * 100).toFixed(0)}%)`
      },
      suggestedFix: { prizeBeforeWager: true }  // Try opposite column order
    };
  }

  // Similar check for prizes...
  return null;
}
```

---

## Phase 3: Self-Healing Loop

### Purpose

When anomalies are detected, automatically try alternative parsing configurations. If an alternative produces better results (fewer/no anomalies), use it and update the learned config.

### New File: `shared/self-healer.js`

**Location**: `/lbscraper/shared/self-healer.js`
**Max Lines**: ~350
**Responsibility**: Attempt automatic correction of anomalous extractions

#### Healing Strategies

| Strategy | When to Try | What It Does |
|----------|-------------|--------------|
| `SWAP_WAGER_PRIZE` | `LIKELY_SWAP`, `SUDDEN_ZEROS` | Swap wager and prize values |
| `REVERSE_COLUMN_ORDER` | `MAGNITUDE_SHIFT`, `SUDDEN_ZEROS` | Parse columns in opposite order |
| `IGNORE_ICON_DETECTION` | `MAGNITUDE_SHIFT` | Don't use icon prefix for prize detection |
| `STRICT_LABEL_MATCHING` | `DUPLICATE_WAGERS` | Only accept explicitly labeled values |
| `USE_TABLE_HEADERS` | `LIKELY_SWAP` | Force column order from table headers |
| `FALLBACK_TO_API` | Multiple failures | Use API extraction only |

#### API Functions

```javascript
// ============================================================================
// SELF-HEALER API
// ============================================================================

/**
 * Attempt to heal an anomalous extraction
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @param {Object} currentResult - Current (anomalous) extraction result
 * @param {Object} rawData - Raw scraped data (html, markdown, apiCalls, etc.)
 * @param {Array<Object>} anomalies - Detected anomalies
 * @param {Object} baseline - Baseline for comparison
 * @returns {Promise<Object>} - Healing result
 *   { healed: boolean, result: {...}, appliedStrategy: 'SWAP_WAGER_PRIZE', anomaliesRemaining: [] }
 */
async function attemptHealing(basePath, domain, leaderboardName, currentResult, rawData, anomalies, baseline) { }

/**
 * Get healing strategies to try based on anomalies
 * @param {Array<Object>} anomalies - Detected anomalies
 * @param {Object} parsingConfig - Current parsing config
 * @returns {Array<Object>} - Ordered list of strategies to try
 */
function getHealingStrategies(anomalies, parsingConfig) { }

/**
 * Apply a healing strategy to raw data and re-extract
 * @param {Object} rawData - Raw scraped data
 * @param {Object} strategy - Healing strategy to apply
 * @param {Object} currentConfig - Current parsing config
 * @returns {Promise<Object>} - Re-extraction result with modified config
 */
async function applyStrategy(rawData, strategy, currentConfig) { }

/**
 * Post-process entries with a fix (e.g., swap values)
 * Used for quick fixes that don't require re-parsing
 * @param {Array} entries - Original entries
 * @param {Object} fix - Fix to apply (e.g., { swapWagerPrize: true })
 * @returns {Array} - Fixed entries
 */
function applyPostProcessFix(entries, fix) { }

/**
 * Compare two extraction results to determine which is better
 * @param {Object} result1 - First result
 * @param {Object} result2 - Second result
 * @param {Object} baseline - Baseline for comparison
 * @returns {number} - -1 if result1 better, 1 if result2 better, 0 if equal
 */
function compareResults(result1, result2, baseline) { }

/**
 * Record successful healing for learning
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} domain - Domain name
 * @param {string} leaderboardName - Leaderboard name
 * @param {Object} strategy - Strategy that worked
 * @param {Object} anomalies - Anomalies that were fixed
 */
function recordHealingSuccess(basePath, domain, leaderboardName, strategy, anomalies) { }
```

#### Healing Flow

```javascript
async function attemptHealing(basePath, domain, leaderboardName, currentResult, rawData, anomalies, baseline) {
  const parsingConfig = getParsingConfig(basePath, domain, leaderboardName) || {};
  const strategies = getHealingStrategies(anomalies, parsingConfig);

  log('HEAL', `${domain}/${leaderboardName}: Attempting healing for ${anomalies.length} anomalies`);
  log('HEAL', `Anomalies: ${anomalies.map(a => a.code).join(', ')}`);
  log('HEAL', `Strategies to try: ${strategies.map(s => s.name).join(', ')}`);

  let bestResult = currentResult;
  let bestAnomalies = anomalies;
  let appliedStrategy = null;

  for (const strategy of strategies) {
    try {
      log('HEAL', `Trying strategy: ${strategy.name}`);

      // Some strategies are post-process fixes (don't require re-parsing)
      let healedResult;
      if (strategy.type === 'post-process') {
        healedResult = {
          ...currentResult,
          entries: applyPostProcessFix(currentResult.entries, strategy.fix)
        };
      } else {
        // Re-extract with modified config
        healedResult = await applyStrategy(rawData, strategy, parsingConfig);
      }

      if (!healedResult || !healedResult.entries || healedResult.entries.length === 0) {
        log('HEAL', `Strategy ${strategy.name}: No results`);
        continue;
      }

      // Check if this result has fewer anomalies
      const newAnomalies = detectAnomalies(healedResult, baseline);

      if (newAnomalies.length < bestAnomalies.length) {
        log('HEAL', `Strategy ${strategy.name}: Reduced anomalies from ${bestAnomalies.length} to ${newAnomalies.length}`);
        bestResult = healedResult;
        bestAnomalies = newAnomalies;
        appliedStrategy = strategy;

        // If no anomalies remain, we're done
        if (newAnomalies.length === 0) {
          log('HEAL', `Strategy ${strategy.name}: All anomalies resolved!`);
          break;
        }
      } else {
        log('HEAL', `Strategy ${strategy.name}: No improvement (${newAnomalies.length} anomalies)`);
      }
    } catch (error) {
      log('ERR', `Strategy ${strategy.name} failed: ${error.message}`);
    }
  }

  const healed = bestAnomalies.length < anomalies.length;

  if (healed && appliedStrategy) {
    // Record successful healing for learning
    recordHealingSuccess(basePath, domain, leaderboardName, appliedStrategy, anomalies);

    // Update parsing config
    if (appliedStrategy.configUpdate) {
      updateParsingConfig(basePath, domain, leaderboardName, {
        ...parsingConfig,
        ...appliedStrategy.configUpdate
      });
    }
  }

  return {
    healed,
    result: bestResult,
    appliedStrategy: appliedStrategy?.name || null,
    anomaliesRemaining: bestAnomalies,
    originalAnomalies: anomalies
  };
}
```

---

## Phase 4: Review Queue & Admin

### Purpose

Sites that cannot be auto-healed need human review. Provide admin interface to see flagged sites and apply manual corrections.

### New File: `shared/review-queue.js`

**Location**: `/lbscraper/shared/review-queue.js`
**Max Lines**: ~200
**Responsibility**: Manage queue of sites needing manual review

#### Queue Entry Structure

```javascript
{
  "id": "uuid",
  "domain": "blaffsen.com",
  "leaderboardName": "clash",
  "flaggedAt": "2026-01-31T20:00:00Z",
  "anomalies": [
    { "code": "SUDDEN_ZEROS", "severity": "HIGH", "details": {...} }
  ],
  "healingAttempted": true,
  "strategiesTried": ["SWAP_WAGER_PRIZE", "REVERSE_COLUMN_ORDER"],
  "currentResult": {
    "entries": [...],
    "confidence": 45
  },
  "baseline": {
    "statistics": {...}
  },
  "status": "pending",  // pending, reviewing, resolved, ignored
  "assignedTo": null,
  "notes": "",
  "resolvedAt": null,
  "resolution": null  // "config_updated", "site_changed", "false_positive"
}
```

#### API Functions

```javascript
// ============================================================================
// REVIEW QUEUE API
// ============================================================================

/**
 * Add site to review queue
 * @param {string} basePath - Path to lbscraper directory
 * @param {Object} queueEntry - Queue entry data
 */
function addToReviewQueue(basePath, queueEntry) { }

/**
 * Get all pending review items
 * @param {string} basePath - Path to lbscraper directory
 * @param {Object} filters - Optional filters (domain, severity, status)
 * @returns {Array<Object>} - Queue entries
 */
function getReviewQueue(basePath, filters = {}) { }

/**
 * Update review item status
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} id - Queue entry ID
 * @param {Object} update - Status update
 */
function updateReviewItem(basePath, id, update) { }

/**
 * Resolve review item
 * @param {string} basePath - Path to lbscraper directory
 * @param {string} id - Queue entry ID
 * @param {string} resolution - Resolution type
 * @param {Object} configUpdate - Optional config update to apply
 */
function resolveReviewItem(basePath, id, resolution, configUpdate = null) { }

/**
 * Get review statistics
 * @param {string} basePath - Path to lbscraper directory
 * @returns {Object} - Stats (pending count, by severity, by domain, etc.)
 */
function getReviewStats(basePath) { }
```

### Admin API Endpoints (NestJS)

Add to existing `src/modules/scraper/scraper.controller.ts`:

```typescript
// GET /admin/scraper/review-queue
// List all items needing review
@Get('review-queue')
async getReviewQueue(@Query() filters: ReviewQueueFiltersDto) {
  return this.scraperService.getReviewQueue(filters);
}

// GET /admin/scraper/review-queue/:id
// Get single review item with full details
@Get('review-queue/:id')
async getReviewItem(@Param('id') id: string) {
  return this.scraperService.getReviewItem(id);
}

// PUT /admin/scraper/review-queue/:id
// Update review item (assign, add notes, change status)
@Put('review-queue/:id')
async updateReviewItem(@Param('id') id: string, @Body() update: UpdateReviewItemDto) {
  return this.scraperService.updateReviewItem(id, update);
}

// POST /admin/scraper/review-queue/:id/resolve
// Resolve review item with optional config fix
@Post('review-queue/:id/resolve')
async resolveReviewItem(@Param('id') id: string, @Body() resolution: ResolveReviewItemDto) {
  return this.scraperService.resolveReviewItem(id, resolution);
}

// GET /admin/scraper/review-stats
// Get review queue statistics
@Get('review-stats')
async getReviewStats() {
  return this.scraperService.getReviewStats();
}

// GET /admin/scraper/healing-stats
// Get self-healing statistics
@Get('healing-stats')
async getHealingStats() {
  return this.scraperService.getHealingStats();
}
```

---

## File Structure

### New Files to Create

```
lbscraper/
├── shared/
│   ├── baseline-store.js      # NEW - Phase 1 (300 lines)
│   ├── anomaly-detector.js    # NEW - Phase 2 (350 lines)
│   ├── self-healer.js         # NEW - Phase 3 (350 lines)
│   └── review-queue.js        # NEW - Phase 4 (200 lines)
│
├── data/
│   ├── baselines/             # NEW - Baseline JSON files
│   │   ├── blaffsen.com.json
│   │   ├── paxgambles.com.json
│   │   └── ...
│   └── review-queue.json      # NEW - Review queue data
```

### Files to Modify

| File | Changes | Lines Added |
|------|---------|-------------|
| `orchestrators/scrape-orchestrator.js` | Add self-healing integration | ~50 |
| `shared/learned-patterns.js` | Import baseline functions | ~10 |
| `scraper_details.md` | Document new modules | ~100 |

### Integration in Orchestrator

```javascript
// In scrape-orchestrator.js, after extraction but before saving

const { getBaseline, storeBaseline, updateBaselineStatistics } = require('../shared/baseline-store');
const { detectAnomalies } = require('../shared/anomaly-detector');
const { attemptHealing } = require('../shared/self-healer');
const { addToReviewQueue } = require('../shared/review-queue');

// After extraction...
const extraction = await extractLeaderboardData(input);

// Get baseline for comparison
const baseline = getBaseline(basePath, domain, leaderboard.name);

if (baseline) {
  // Detect anomalies
  const anomalies = detectAnomalies(extraction, baseline);

  if (anomalies.length > 0) {
    log('ORCHESTRATE', `Anomalies detected: ${anomalies.map(a => a.code).join(', ')}`);

    // Attempt self-healing
    const healingResult = await attemptHealing(
      basePath, domain, leaderboard.name,
      extraction, rawData, anomalies, baseline
    );

    if (healingResult.healed) {
      log('ORCHESTRATE', `Self-healed using strategy: ${healingResult.appliedStrategy}`);
      extraction = healingResult.result;
    } else if (healingResult.anomaliesRemaining.length > 0) {
      // Add to review queue
      addToReviewQueue(basePath, {
        domain,
        leaderboardName: leaderboard.name,
        anomalies: healingResult.anomaliesRemaining,
        healingAttempted: true,
        strategiesTried: healingResult.strategiesTried,
        currentResult: extraction,
        baseline
      });
      log('ORCHESTRATE', `Added to review queue: ${healingResult.anomaliesRemaining.length} unresolved anomalies`);
    }
  }

  // Update baseline statistics with successful extraction
  if (extraction.confidence >= 70 && anomalies.length === 0) {
    updateBaselineStatistics(basePath, domain, leaderboard.name, extraction);
  }
} else if (extraction.confidence >= 80) {
  // No baseline exists - store this as the initial baseline
  storeBaseline(basePath, domain, leaderboard.name, extraction, detectedParsingConfig);
  log('ORCHESTRATE', `Stored initial baseline for ${domain}/${leaderboard.name}`);
}
```

---

## Data Flow Diagrams

### Normal Extraction Flow (No Anomalies)

```
┌──────────────────┐
│   Raw Data       │
│ (HTML, Markdown) │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   Extraction     │
│   (Multi-source) │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│ Anomaly Detector │────►│ Baseline Store   │
│ (Compare to base)│     │ (Get baseline)   │
└────────┬─────────┘     └──────────────────┘
         │
         │ No anomalies
         ▼
┌──────────────────┐
│ Update Baseline  │
│ Statistics       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   Save Result    │
│   (Database)     │
└──────────────────┘
```

### Self-Healing Flow (Anomalies Detected)

```
┌──────────────────┐
│   Extraction     │
│   Result         │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│ Anomaly Detector │────►│ Baseline Store   │
│                  │     │                  │
└────────┬─────────┘     └──────────────────┘
         │
         │ Anomalies found!
         ▼
┌──────────────────┐
│   Self-Healer    │
│ (Try strategies) │
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐  ┌────────────┐
│ Healed │  │ Not Healed │
└───┬────┘  └─────┬──────┘
    │             │
    ▼             ▼
┌────────────┐  ┌────────────┐
│ Update     │  │ Add to     │
│ Parsing    │  │ Review     │
│ Config     │  │ Queue      │
└─────┬──────┘  └─────┬──────┘
      │               │
      ▼               ▼
┌──────────────────────────┐
│      Save Result         │
│ (with healing metadata)  │
└──────────────────────────┘
```

### First-Time Site Flow (No Baseline)

```
┌──────────────────┐
│   Extraction     │
│   Result         │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Check Baseline   │
│ Exists?          │
└────────┬─────────┘
         │
         │ No baseline
         ▼
┌──────────────────┐
│ Confidence       │
│ >= 80%?          │
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐  ┌──────────────┐
│  Yes   │  │     No       │
└───┬────┘  └──────┬───────┘
    │              │
    ▼              ▼
┌────────────┐  ┌────────────┐
│ Store as   │  │ Save but   │
│ Initial    │  │ don't      │
│ Baseline   │  │ baseline   │
└─────┬──────┘  └─────┬──────┘
      │               │
      └───────┬───────┘
              │
              ▼
┌──────────────────────────┐
│      Save Result         │
└──────────────────────────┘
```

---

## Integration Points

### 1. Orchestrator Integration

**File**: `orchestrators/scrape-orchestrator.js`
**Location**: After `extractLeaderboardData()`, before saving

```javascript
// Add imports at top
const { getBaseline, storeBaseline, updateBaselineStatistics, getParsingConfig } = require('../shared/baseline-store');
const { detectAnomalies, calculateSeverityScore } = require('../shared/anomaly-detector');
const { attemptHealing } = require('../shared/self-healer');
const { addToReviewQueue } = require('../shared/review-queue');

// Add after extraction, in the scrapeLeaderboard() function
async function processWithSelfHealing(extraction, rawData, domain, leaderboardName, basePath) {
  const baseline = getBaseline(basePath, domain, leaderboardName);

  // Track healing metadata
  const healingMetadata = {
    baselineExists: !!baseline,
    anomaliesDetected: [],
    healingAttempted: false,
    healingSuccess: false,
    strategyUsed: null
  };

  if (baseline) {
    const anomalies = detectAnomalies(extraction, baseline);
    healingMetadata.anomaliesDetected = anomalies.map(a => a.code);

    if (anomalies.length > 0) {
      healingMetadata.healingAttempted = true;

      const healingResult = await attemptHealing(
        basePath, domain, leaderboardName,
        extraction, rawData, anomalies, baseline
      );

      if (healingResult.healed) {
        healingMetadata.healingSuccess = true;
        healingMetadata.strategyUsed = healingResult.appliedStrategy;
        extraction = healingResult.result;
        extraction._healingApplied = true;
      } else if (healingResult.anomaliesRemaining.length > 0) {
        addToReviewQueue(basePath, {
          domain,
          leaderboardName,
          anomalies: healingResult.anomaliesRemaining,
          currentResult: extraction,
          baseline
        });
      }
    } else if (extraction.confidence >= 70) {
      updateBaselineStatistics(basePath, domain, leaderboardName, extraction);
    }
  } else if (extraction.confidence >= 80) {
    const parsingConfig = getParsingConfig(basePath, domain, leaderboardName);
    storeBaseline(basePath, domain, leaderboardName, extraction, parsingConfig);
    healingMetadata.baselineCreated = true;
  }

  // Attach metadata to result
  extraction._healingMetadata = healingMetadata;

  return extraction;
}
```

### 2. Extraction Strategy Integration

**File**: `shared/extraction.js`
**Purpose**: Pass parsing config hints to extraction functions

```javascript
// Add to parseMarkdownList() and other parsers
function parseMarkdownList(markdown, parsingConfig = {}) {
  const {
    prizeBeforeWager = false,  // From baseline config
    strictLabelMatching = false,
    ignoreIconDetection = false
  } = parsingConfig;

  // Use config hints in parsing logic
  // ...
}
```

### 3. Data Fusion Integration

**File**: `core/data-fusion.js`
**Purpose**: Pass parsing config to strategies

```javascript
// In fuseExtractionResults()
const parsingConfig = options.parsingConfig || {};
input._parsingConfig = parsingConfig;

// Strategies can then access via input._parsingConfig
```

---

## Testing Strategy

### Unit Tests

**File**: `tests/self-healing.test.js`

```javascript
describe('Baseline Store', () => {
  test('stores baseline from high-confidence extraction', () => {});
  test('rejects baseline from low-confidence extraction', () => {});
  test('updates statistics with rolling window', () => {});
  test('expires old baselines', () => {});
});

describe('Anomaly Detector', () => {
  test('detects sudden zeros', () => {});
  test('detects likely swap', () => {});
  test('detects magnitude shift', () => {});
  test('detects duplicate wagers', () => {});
  test('returns empty array for normal extraction', () => {});
});

describe('Self-Healer', () => {
  test('fixes swapped values', () => {});
  test('fixes column order', () => {});
  test('records successful healing', () => {});
  test('adds to review queue when healing fails', () => {});
});
```

### Integration Tests

```javascript
describe('Self-Healing Integration', () => {
  test('full flow: extraction → detection → healing → save', () => {});
  test('preserves existing sites when self-healing enabled', () => {});
  test('does not break reference sites', () => {});
});
```

### Regression Tests

**MANDATORY before deploying any changes:**

```bash
node lbscraper/new-run-scraper.js \
  https://paxgambles.com/leaderboard \
  https://devlrewards.com/leaderboard \
  https://goatgambles.com/leaderboard \
  https://wrewards.com/leaderboards
```

All 4 reference sites MUST produce correct results.

---

## Rollout Plan

### Phase 1: Baseline Storage (Week 1)

1. Implement `baseline-store.js`
2. Add baseline creation to orchestrator (store-only, no detection)
3. Run for 1 week to build baselines for all active sites
4. Verify baselines are being stored correctly

**Success Criteria**: 90% of active sites have baselines

### Phase 2: Anomaly Detection (Week 2)

1. Implement `anomaly-detector.js`
2. Add detection to orchestrator (detect-only, no healing)
3. Log all detected anomalies for analysis
4. Tune detection thresholds based on false positive rate

**Success Criteria**: <10% false positive rate on known-good sites

### Phase 3: Self-Healing (Week 3)

1. Implement `self-healer.js`
2. Enable healing in orchestrator (with feature flag)
3. Monitor healing success rate
4. Tune strategies based on results

**Success Criteria**: >60% auto-healing success rate

### Phase 4: Review Queue (Week 4)

1. Implement `review-queue.js`
2. Add admin API endpoints
3. Build simple admin UI
4. Process initial review queue

**Success Criteria**: Review queue processing workflow functional

### Feature Flags

```javascript
// In config or environment
const SELF_HEALING_CONFIG = {
  ENABLE_BASELINE_STORAGE: true,     // Phase 1
  ENABLE_ANOMALY_DETECTION: true,    // Phase 2
  ENABLE_AUTO_HEALING: true,         // Phase 3
  ENABLE_REVIEW_QUEUE: true,         // Phase 4

  // Thresholds
  MIN_CONFIDENCE_FOR_BASELINE: 80,
  MIN_CONFIDENCE_AFTER_HEALING: 70,
  MAX_HEALING_ATTEMPTS: 3,
  BASELINE_EXPIRY_DAYS: 7
};
```

---

## Risk Assessment

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Self-healing makes things worse | Medium | High | Compare before/after, only apply if better |
| False positive anomalies | Medium | Medium | Tune thresholds, require multiple anomalies |
| Baseline drift over time | Low | Medium | Rolling window statistics, periodic re-baselining |
| Performance impact | Low | Low | Async healing, background processing |
| Breaking existing sites | High | Critical | Feature flags, regression tests, gradual rollout |

### Critical Safety Measures

1. **Never Worse**: Self-healing only applies if result has fewer anomalies
2. **Feature Flags**: Each phase can be disabled independently
3. **Logging**: All healing attempts logged with full context
4. **Review Queue**: Unhealed sites get human review
5. **Regression Tests**: Mandatory before any deployment

### Rollback Plan

If issues occur:

1. Disable feature flag for affected phase
2. Clear affected baselines (optional)
3. Revert to previous scraper version
4. Analyze logs to understand failure
5. Fix and re-enable with monitoring

---

## Success Metrics

### Key Performance Indicators

| Metric | Target | Measurement |
|--------|--------|-------------|
| Anomaly detection rate | >80% | Detected anomalies / Actual anomalies |
| Auto-healing success | >60% | Healed / Attempted |
| False positive rate | <10% | False anomalies / Total detections |
| Manual review reduction | >80% | Sites needing manual review / Total sites |
| Data accuracy | >95% | Correct extractions / Total extractions |

### Monitoring Dashboard

Track daily:
- Baselines created/updated
- Anomalies detected by type
- Healing attempts and success rate
- Review queue size
- Sites with persistent issues

---

## Estimated Effort

| Phase | Files | Lines | Time |
|-------|-------|-------|------|
| Phase 1: Baseline Storage | 1 | ~300 | 4-6 hours |
| Phase 2: Anomaly Detection | 1 | ~350 | 4-6 hours |
| Phase 3: Self-Healing | 1 | ~350 | 6-8 hours |
| Phase 4: Review Queue | 1 + API | ~300 | 4-6 hours |
| Integration & Testing | - | ~150 | 4-6 hours |
| Documentation | - | ~100 | 2-3 hours |
| **Total** | **4-5** | **~1550** | **24-35 hours** |

---

## Appendix A: Anomaly Detection Pseudocode

```javascript
function detectAnomalies(result, baseline) {
  const anomalies = [];
  const entries = result.entries;
  const stats = baseline.statistics;

  // 1. Entry count check
  if (entries.length < stats.entryCount.min - 2) {
    anomalies.push({
      code: 'ENTRY_COUNT_DROP',
      severity: 'HIGH',
      details: { current: entries.length, expected: stats.entryCount.expected }
    });
  }

  // 2. Zero rate check
  const currentZeroRate = entries.filter(e => e.wager === 0).length / entries.length;
  if (currentZeroRate > stats.wagerZeroRate + 0.3) {
    anomalies.push({
      code: 'SUDDEN_ZEROS',
      severity: 'HIGH',
      details: { field: 'wager', currentRate: currentZeroRate, baselineRate: stats.wagerZeroRate }
    });
  }

  // 3. Magnitude shift check
  const currentAvgWager = entries.reduce((s, e) => s + e.wager, 0) / entries.length;
  const currentLog = Math.log10(Math.max(currentAvgWager, 1));
  if (Math.abs(currentLog - stats.wagerMagnitude.avgLog10) > 2) {
    anomalies.push({
      code: 'WAGER_MAGNITUDE_SHIFT',
      severity: 'HIGH',
      details: { currentLog, baselineLog: stats.wagerMagnitude.avgLog10 }
    });
  }

  // 4. Likely swap check
  const prizeHigherRate = entries.filter(e => e.prize > e.wager).length / entries.length;
  if (prizeHigherRate > 0.7 && stats.prizeHigherRate < 0.3) {
    anomalies.push({
      code: 'LIKELY_SWAP',
      severity: 'HIGH',
      details: { currentRate: prizeHigherRate, baselineRate: stats.prizeHigherRate },
      suggestedFix: { swapWagerPrize: true }
    });
  }

  // 5. Duplicate wagers check
  const wagerCounts = new Map();
  entries.forEach(e => {
    const w = Math.round(e.wager);
    wagerCounts.set(w, (wagerCounts.get(w) || 0) + 1);
  });
  const duplicates = Array.from(wagerCounts.entries()).filter(([w, c]) => w > 0 && c > 1);
  if (duplicates.length > 3) {
    anomalies.push({
      code: 'DUPLICATE_WAGERS',
      severity: 'MEDIUM',
      details: { duplicateCount: duplicates.length, examples: duplicates.slice(0, 3) }
    });
  }

  return anomalies;
}
```

---

## Appendix B: Healing Strategy Definitions

```javascript
const HEALING_STRATEGIES = [
  {
    name: 'SWAP_WAGER_PRIZE',
    type: 'post-process',
    appliesTo: ['LIKELY_SWAP', 'SUDDEN_ZEROS'],
    fix: { swapWagerPrize: true },
    configUpdate: { columnOrder: 'swapped' }
  },
  {
    name: 'REVERSE_COLUMN_ORDER',
    type: 're-extract',
    appliesTo: ['MAGNITUDE_SHIFT', 'SUDDEN_ZEROS'],
    configUpdate: { prizeBeforeWager: true }
  },
  {
    name: 'IGNORE_ICON_DETECTION',
    type: 're-extract',
    appliesTo: ['MAGNITUDE_SHIFT'],
    configUpdate: { ignoreIconDetection: true }
  },
  {
    name: 'STRICT_LABEL_MATCHING',
    type: 're-extract',
    appliesTo: ['DUPLICATE_WAGERS'],
    configUpdate: { strictLabelMatching: true }
  },
  {
    name: 'USE_TABLE_HEADERS',
    type: 're-extract',
    appliesTo: ['LIKELY_SWAP'],
    configUpdate: { forceTableHeaders: true }
  }
];
```

---

*End of Plan Document*

*Last Updated: January 31, 2026*
