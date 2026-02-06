/**
 * LLM Context Builder for Teacher Mode
 * 
 * Builds context packages for LLM calls.
 * Includes training context and scraper findings.
 * Keywords are loaded dynamically from keywords.txt.
 */

const { loadKeywords } = require('../utils');

// ============================================================================
// TRAINING CONTEXT
// ============================================================================

/**
 * Build training context with dynamically loaded keywords
 * @param {string} keywordsPath - Path to keywords.txt
 * @returns {Object} - Training context for LLM
 */
function buildTrainingContext(keywordsPath) {
  const keywords = loadKeywords(keywordsPath);
  
  return {
    whatIsLeaderboard: `A leaderboard displays rankings of gambling users by wager amount.
Each entry typically contains:
- RANK: Position (1, 2, 3 or #1, #2, #3 or 1st, 2nd, 3rd)
- USERNAME: Player name (often censored like J***n or T***K*****)
- WAGER: Amount wagered in USD (LARGER number, typically $10,000-$10,000,000)
- PRIZE: Reward amount (SMALLER than wager, e.g., $100-$50,000)
Usually shows top 10 entries. Top 3 often in "podium" style cards, ranks 4-10 in a table.`,

    whatAreSiteSwitchers: `Buttons/tabs to switch between different casino leaderboards.
Look for: tabs with casino names, sliders with logos, dropdown menus, card buttons.
Current known casino sites: ${keywords.join(', ')}.
Keywords may appear in: button text, image alt text, SVG elements, class names, data attributes.`,

    whatScraperDoes: `The scraper attempts:
1. Finding the leaderboard page (usually /leaderboards or /lb)
2. Detecting site switcher buttons by looking for casino keywords
3. Clicking each switcher and waiting for content to change
4. Intercepting API responses for leaderboard data
5. Extracting from DOM if API interception fails
6. Calculating confidence scores based on data quality`,

    scraperLimitations: `Known issues to look for:
- Keywords hidden in SVG elements (not in searchable text)
- Multiple elements with same keyword (wrong one gets clicked)
- Content doesn't actually change after click (stale DOM)
- Wager and prize columns swapped
- Missing leaderboards not detected
- Top 3 podium cards vs table rows use different extraction logic`,

    successCriteria: `A successful extraction has:
- All leaderboards on the site identified and scraped
- 5-10 entries per leaderboard with valid data
- All fields populated: rank, username, wager, prize
- Wager values are large (typically $10,000-$10,000,000)
- Prize values make sense (top prizes larger than lower ranks)
- No duplicate entries across different leaderboards
- No UI text accidentally captured as usernames
- Confidence score of 80 or higher`,

    keywords: keywords
  };
}

// ============================================================================
// SYSTEM PROMPTS
// ============================================================================

const QUICK_ANALYSIS_PROMPT = `You are an expert web scraper assistant analyzing leaderboard data from gambling affiliate websites.

## YOUR TASK
Review the extraction results and the screenshot. Determine if the scraper got it right. Provide rules for future scraping.

## WHAT YOU SEE
- A screenshot of the current page state
- The scraper's extraction results (what it found)
- Site information (domain, status, attempt number)

## WHAT TO CHECK
1. Are the extracted leaderboards correct?
2. Are there any leaderboards the scraper missed?
3. Are the site switcher buttons correctly identified?
4. Is the data (usernames, wagers, prizes) accurate?
5. Are there any obvious errors?

## RESPOND WITH JSON ONLY
{
  "dataVerification": {
    "isCorrect": true/false,
    "issues": [{"leaderboard": "name", "problem": "description", "correctedData": [...]}]
  },
  "missedLeaderboards": [{"name": "...", "whyMissed": "...", "location": {"selector": "...", "coordinates": {"x": N, "y": N}}}],
  "switchers": [{"name": "casino_name", "selector": ".selector", "coordinates": {"x": N, "y": N}, "clickStrategy": "coordinate|selector", "keywords": ["..."]}],
  "extraction": {"containerSelector": "...", "entrySelector": "...", "fields": {"rank": "...", "username": "...", "wager": "...", "prize": "..."}},
  "apiPatterns": {"entriesEndpoint": "url pattern or null", "prizesEndpoint": "url pattern or null"},
  "layoutFingerprint": {"switcherCount": N, "switcherNames": [...], "layoutType": "podium-table|table-only|list"},
  "llmNotes": {"confidence": 0-100, "observations": ["..."], "warnings": ["..."]}
}

Be specific with selectors. If a selector might be ambiguous, provide coordinates as backup.`;

const INTERACTIVE_PROMPT = `You are investigating a leaderboard page that needs more exploration.

## YOUR CAPABILITIES
You can control the browser. Include commands in your response to interact with the page.

## AVAILABLE COMMANDS (include in browserCommands array)
- { "action": "click", "selector": ".css-selector" }
- { "action": "click", "coordinates": {"x": 100, "y": 200} }
- { "action": "scroll", "direction": "down", "amount": 300 }
- { "action": "wait", "ms": 2000 }
- { "action": "waitForSelector", "selector": ".element", "timeout": 5000 }
- { "action": "hover", "selector": ".element" }

## CURRENT STATE
You'll receive:
- A screenshot of the current page
- A simplified DOM structure
- Recent API responses
- Previous context

## RESPOND WITH JSON
Include your analysis AND any browser commands needed:
{
  "browserCommands": [...],  // Empty if no actions needed
  "finished": false,         // Set true when done investigating
  "dataVerification": {...},
  "switchers": [...],
  "extraction": {...},
  "llmNotes": {"confidence": 0-100, "observations": [...], "warnings": [...]}
}

Set "finished": true when you've gathered enough information to provide confident rules.`;

const SWITCHER_DISCOVERY_PROMPT = `You are analyzing a gambling affiliate leaderboard page to find all available leaderboard switchers.

## YOUR TASK
Find all clickable elements that switch between different casino/site leaderboards on this page.

## CONTEXT
This page may have MULTIPLE leaderboards for different casinos (e.g., Clash.gg, Rain.gg, Shuffle, CSGOBig).
Switchers can be:
- Horizontal tab bars at the top of the leaderboard section
- Dropdown menus with "Leaderboards" label
- Grid of casino logos that are clickable
- Buttons with casino names or logos inside images
- Relative navigation links (href="/clash", href="rain")
- Data attributes like data-site, data-load-mode, data-provider

## WHAT TO LOOK FOR
1. Tab-like elements with casino names (CLASH, RAIN, SHUFFLE, CSGOBIG, etc.)
2. Dropdown menus that might contain leaderboard options - if hidden, identify the trigger button
3. Images of casino logos inside clickable containers
4. Data attributes containing casino keywords
5. Relative links like href="/clash" or href="rain" (NOT external links like https://clash.gg)

## IMPORTANT DISTINCTIONS
- INTERNAL switchers: Click to change leaderboard content on same page (we want these)
- EXTERNAL links: Navigate to casino site (we DON'T want these - skip http:// and https:// links)
- AFFILIATE links: Go to casino with ref code (skip these too)

## RESPOND WITH JSON ONLY
{
  "switchersFound": [
    {
      "keyword": "clash",
      "type": "tab|button|dropdown-item|image-button|href-relative",
      "selector": "CSS selector if determinable",
      "coordinates": {"x": N, "y": N} (approximate center of element),
      "description": "Brief description of the element",
      "confidence": 0-100,
      "isDropdownItem": false,
      "dropdownTriggerSelector": null
    }
  ],
  "needsDropdownExploration": true/false,
  "dropdownSelector": "selector of dropdown trigger to click",
  "currentlyActiveLeaderboard": "keyword of currently displayed leaderboard or null",
  "urlPattern": "/leaderboard/{keyword} or null if not URL-based",
  "additionalNotes": "Any observations about the page structure"
}

Be specific with coordinates. If an element is inside a dropdown that's not visible, set needsDropdownExploration: true and provide dropdownSelector.`;

// ============================================================================
// CONTEXT BUILDERS
// ============================================================================

/**
 * Build context for Phase 1 (Quick Analysis)
 * @param {Page} page - Playwright page
 * @param {Object} networkData - Network capture data
 * @param {Object} extractionResult - Scraper's extraction result
 * @param {Object} profile - Site profile
 * @param {Object} config - Config with paths
 * @returns {Object} - Context for LLM
 */
async function buildQuickContext(page, networkData, extractionResult, profile, config) {
  const training = buildTrainingContext(config.paths.keywords);
  
  return {
    training: {
      whatIsLeaderboard: training.whatIsLeaderboard,
      whatAreSiteSwitchers: training.whatAreSiteSwitchers,
      successCriteria: training.successCriteria,
      knownSites: training.keywords
    },
    
    site: {
      domain: profile.domain,
      url: page.url(),
      status: profile.status,
      attempt: profile.attempts + 1,
      maxAttempts: profile.maxAttempts
    },
    
    scraperFindings: {
      leaderboards: extractionResult.results?.map(r => ({
        name: r.name,
        type: r.type,
        entryCount: r.entries?.length || 0,
        confidence: r.confidence,
        topEntries: r.entries?.slice(0, 3).map(e => ({
          rank: e.rank,
          username: e.username,
          wager: e.wager,
          prize: e.prize
        })) || [],
        extractionMethod: r.extractionMethod,
        apiValidated: r.apiSiteValidated
      })) || [],
      
      detectedSwitchers: extractionResult.detectedSwitchers?.map(s => ({
        keyword: s.keyword,
        type: s.type,
        coordinates: s.coordinates
      })) || [],
      
      errors: extractionResult.errors?.slice(0, 5) || []
    },
    
    apiSummary: (networkData.rawJsonResponses || []).slice(-5).map(r => ({
      url: r.url.substring(0, 100),
      hasLeaderboardData: !!(r.data?.entries || r.data?.leaders || r.data?.leaderboard)
    })),
    
    previousRules: profile.status !== 'new' ? {
      switcherCount: profile.switchers?.length || 0,
      extractionSelector: profile.extraction?.containerSelector,
      lastConfidence: profile.verification?.llmConfidence
    } : null
  };
}

/**
 * Build context for Phase 2 (Interactive)
 * @param {Object} baseContext - Context from Phase 1
 * @param {Object} browserState - Current browser state
 * @param {number} iteration - Current iteration number
 * @returns {Object} - Extended context for interactive mode
 */
function buildInteractiveContext(baseContext, browserState, iteration) {
  return {
    ...baseContext,
    
    browserState: {
      currentUrl: browserState.url,
      domSummary: browserState.domSummary,
      recentApiResponses: browserState.apiResponses?.slice(-3).map(r => ({
        url: r.url?.substring(0, 80),
        dataPreview: JSON.stringify(r.data).substring(0, 200)
      })) || []
    },
    
    session: {
      iteration,
      maxIterations: 5,
      note: 'Set finished: true when you have enough information'
    }
  };
}

/**
 * Build context for Switcher Discovery (Last resort AI detection)
 * @param {string} currentUrl - Current page URL
 * @param {Array} keywords - Known casino keywords
 * @param {Array} existingSwitchers - Already detected switchers (programmatically)
 * @returns {Object} - Context for LLM switcher discovery
 */
function buildSwitcherDiscoveryContext(currentUrl, keywords, existingSwitchers = []) {
  return {
    task: 'SWITCHER_DISCOVERY',
    
    currentUrl: currentUrl,
    
    knownKeywords: keywords.slice(0, 50), // Limit to prevent token overflow
    
    alreadyDetected: existingSwitchers.map(s => ({
      keyword: s.keyword,
      type: s.type,
      source: s.source
    })),
    
    instructions: [
      'Look for ALL casino/site switcher buttons on the page',
      'Identify tabs, buttons, dropdowns, or image-based switchers',
      'Ignore external links (https://) - we only want internal switchers',
      'Note if any switchers are hidden inside dropdowns',
      'Provide coordinates for elements that need clicking'
    ]
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Context builders
  buildQuickContext,
  buildInteractiveContext,
  buildTrainingContext,
  buildSwitcherDiscoveryContext,
  
  // Prompts
  QUICK_ANALYSIS_PROMPT,
  INTERACTIVE_PROMPT,
  SWITCHER_DISCOVERY_PROMPT
};
