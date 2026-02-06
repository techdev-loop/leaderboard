/**
 * OCR Extraction Strategy
 *
 * RESPONSIBILITY: Extract entries using Tesseract OCR on screenshots
 * - Take full-page screenshot
 * - Run OCR text recognition
 * - Parse recognized text for entries
 * - Last resort when other methods fail
 *
 * Priority: 4 (lowest - expensive and least reliable)
 */

const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const { log, parseNum, validateUsername } = require('../shared/utils');

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

const strategy = {
  name: 'ocr',
  priority: 4,

  /**
   * Check if this strategy can extract from the given input
   * @param {Object} input - Extraction input
   * @returns {boolean}
   */
  canExtract(input) {
    // Need either a page (to take screenshot) or existing screenshot
    return input.page != null || input.screenshot != null;
  },

  /**
   * Extract leaderboard entries using OCR
   * @param {Object} input - Extraction input
   * @returns {Promise<Object|null>} - Extraction result or null
   */
  async extract(input) {
    const { page, screenshot, config = {} } = input;
    const { tempDir = path.join(__dirname, '..', 'data') } = config;

    log('OCR-EXTRACT', 'Trying OCR extraction strategy (fallback)...');

    try {
      let screenshotPath = null;
      let shouldCleanup = false;

      // Get screenshot
      if (screenshot) {
        // Use provided screenshot buffer
        screenshotPath = path.join(tempDir, `temp-ocr-${Date.now()}.png`);
        fs.writeFileSync(screenshotPath, screenshot);
        shouldCleanup = true;
      } else if (page) {
        // Take new screenshot
        screenshotPath = path.join(tempDir, `temp-ocr-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        shouldCleanup = true;
      } else {
        log('OCR-EXTRACT', 'No screenshot or page available');
        return null;
      }

      // Run OCR
      const entries = await runOCR(screenshotPath);

      // Cleanup
      if (shouldCleanup && fs.existsSync(screenshotPath)) {
        fs.unlinkSync(screenshotPath);
      }

      if (entries.length >= 3) {
        // OCR gets lower confidence by default
        const confidence = Math.min(60, 30 + entries.length * 3);
        log('OCR-EXTRACT', `Found ${entries.length} entries (confidence: ${confidence})`);

        return {
          entries,
          prizes: [],
          confidence,
          metadata: {
            method: 'ocr'
          }
        };
      }

      log('OCR-EXTRACT', `Only found ${entries.length} entries, not enough`);
      return null;

    } catch (e) {
      log('OCR-EXTRACT', `OCR extraction error: ${e.message}`);
      return null;
    }
  }
};

// ============================================================================
// OCR PROCESSING
// ============================================================================

/**
 * Run OCR on a screenshot
 * @param {string} screenshotPath - Path to screenshot file
 * @returns {Promise<Array>} - Array of entry objects
 */
async function runOCR(screenshotPath) {
  log('OCR-EXTRACT', `Running Tesseract OCR on ${path.basename(screenshotPath)}...`);

  const result = await Tesseract.recognize(screenshotPath, 'eng', {
    logger: m => {
      if (m.status === 'recognizing text') {
        process.stdout.write(`\r    OCR: ${Math.round(m.progress * 100)}%`);
      }
    }
  });

  console.log(''); // New line after progress

  const text = result.data.text;
  return parseOCRText(text);
}

/**
 * Parse OCR text into leaderboard entries
 * @param {string} text - OCR recognized text
 * @returns {Array} - Array of entry objects
 */
function parseOCRText(text) {
  const entries = [];
  const seenUsers = new Set();
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  // First pass: find potential usernames and their associated numbers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip short lines or pure numbers
    if (line.length < 3) continue;
    if (/^[\d,.$€£]+$/.test(line)) continue;

    // Check if this looks like a username
    const validation = validateUsername(line);
    if (!validation.valid) continue;

    // Skip garbage words
    if (isGarbageText(line)) continue;

    // Look for numbers in nearby lines
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const nextLine = lines[j].trim();
      const numMatch = nextLine.match(/^[$◆♦€£]?\s*([\d,]+\.?\d*)$/);

      if (numMatch) {
        const wager = parseNum(numMatch[1]);

        if (wager > 10 && !seenUsers.has(line.toLowerCase())) {
          seenUsers.add(line.toLowerCase());
          entries.push({
            rank: entries.length + 1,
            username: cleanOCRUsername(line),
            wager,
            prize: 0,
            source: 'ocr'
          });
          break;
        }
      }
    }
  }

  // If first pass didn't work well, try pattern-based extraction
  if (entries.length < 3) {
    const patternEntries = extractByPattern(lines, seenUsers);
    entries.push(...patternEntries);
  }

  log('OCR-EXTRACT', `Parsed ${entries.length} entries from OCR text`);
  return entries;
}

/**
 * Extract entries using common patterns
 * @param {string[]} lines - OCR lines
 * @param {Set} seenUsers - Already seen usernames
 * @returns {Array} - Additional entries
 */
function extractByPattern(lines, seenUsers) {
  const entries = [];

  // Pattern: "1. username $1,234" or "#1 username 1234"
  const linePattern = /^(?:#?(\d+)[.)\s]+)?([a-zA-Z][a-zA-Z0-9_*.-]{2,20})\s+[$◆♦€£]?([\d,]+)/;

  for (const line of lines) {
    const match = line.match(linePattern);
    if (match) {
      const rank = match[1] ? parseInt(match[1]) : entries.length + 1;
      const username = match[2];
      const wager = parseNum(match[3]);

      if (wager > 10 && !seenUsers.has(username.toLowerCase()) && !isGarbageText(username)) {
        seenUsers.add(username.toLowerCase());
        entries.push({
          rank,
          username: cleanOCRUsername(username),
          wager,
          prize: 0,
          source: 'ocr-pattern'
        });
      }
    }
  }

  return entries;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if text is garbage/UI text
 * @param {string} text - Text to check
 * @returns {boolean}
 */
function isGarbageText(text) {
  if (!text || text.length < 2) return true;

  const lower = text.toLowerCase().trim();
  const garbageWords = [
    'leaderboard', 'leaderboards', 'ranking', 'rankings',
    'prize', 'prize pool', 'total', 'reward', 'rewards',
    'wagered', 'wager', 'bonus', 'bonuses',
    'view', 'more', 'show', 'hide', 'login', 'register',
    'active', 'inactive', 'status', 'rank', 'position',
    'other', 'leaders', 'players', 'users', 'winners'
  ];

  return garbageWords.includes(lower);
}

/**
 * Clean up OCR-recognized username
 * @param {string} username - Raw OCR username
 * @returns {string} - Cleaned username
 */
function cleanOCRUsername(username) {
  if (!username) return '';

  let cleaned = username.trim();

  // Remove leading rank numbers
  cleaned = cleaned.replace(/^#?\d+[.)\s]+/, '');

  // Remove trailing numbers that look like wagers
  cleaned = cleaned.replace(/\s+[\d,]+$/, '');

  // Fix common OCR mistakes
  cleaned = cleaned
    .replace(/0/g, 'O') // Only in certain contexts
    .replace(/1/g, 'l') // Only in certain contexts
    .trim();

  // If the "fix" made it worse, keep original
  if (cleaned.length < 2 || /^\d+$/.test(cleaned)) {
    cleaned = username.trim().replace(/^#?\d+[.)\s]+/, '');
  }

  return cleaned;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  strategy,

  // Helper functions (for testing/reuse)
  runOCR,
  parseOCRText,
  isGarbageText,
  cleanOCRUsername
};
