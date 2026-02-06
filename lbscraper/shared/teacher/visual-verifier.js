/**
 * Visual Verifier for LLM Teacher Mode
 * 
 * Uses screenshots + LLM to verify leaderboard count and identify
 * any switchers that DOM detection missed.
 * 
 * Now includes INTERACTIVE EXPLORATION - LLM can click on dropdowns
 * and other interactive elements to discover hidden options.
 * 
 * Runs once every 24 hours per site.
 */

const { log } = require('../utils');
const { callClaude } = require('./llm-client');
const { updateSiteProfile, getSiteProfile } = require('./site-profiles');

// ============================================================================
// CONFIGURATION
// ============================================================================

const VISUAL_VERIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

const VISUAL_VERIFICATION_PROMPT = `You are an expert at analyzing gambling affiliate website leaderboard pages.

Look at this screenshot of a leaderboard page and identify ALL visible site switchers, tabs, or buttons that switch between different casino/gambling site leaderboards.

IMPORTANT: Site switchers are typically:
- Tabs or buttons with casino names (Gamdom, Stake, Packdraw, etc.)
- Slider/carousel with casino logos
- Card-style buttons showing different sites
- Dropdown menus for site selection (LOOK FOR ARROWS OR CHEVRONS indicating a dropdown!)

Common casino/gambling site names to look for:
gamdom, packdraw, stake, shuffle, rollbit, roobet, clash, lootbox, csgoempire, csgoroll, duelbits, hypedrop, cases, clash.gg, luxdrop, csgopolygon, rainbet, bc.game, bcgame, thunderpick, chicken, csbattle, upgrader

CRITICAL: If you see a DROPDOWN (element with arrow/chevron indicating it can be clicked to reveal more options), you MUST report it so we can click it and discover what's inside.

Return your findings as JSON:
{
  "siteSwitchersFound": ["name1", "name2", ...],
  "switcherCount": <number>,
  "switcherType": "tabs" | "buttons" | "slider" | "dropdown" | "cards" | "none" | "mixed",
  "hasDropdown": true/false,
  "dropdownInfo": {
    "description": "describe the dropdown element",
    "currentValue": "what value is currently shown",
    "approximateLocation": "top-left" | "top-center" | "top-right" | "center" | etc.
  },
  "confidence": <0-100>,
  "notes": "any observations about the page layout or potential issues"
}

If you cannot identify any site switchers, return:
{
  "siteSwitchersFound": [],
  "switcherCount": 0,
  "switcherType": "none",
  "hasDropdown": false,
  "dropdownInfo": null,
  "confidence": <your confidence level>,
  "notes": "reason why no switchers were found"
}`;

const DROPDOWN_EXPLORATION_PROMPT = `You are analyzing a DROPDOWN MENU that was just opened on a gambling leaderboard website.

Look at this screenshot and identify ALL the options/items visible in the dropdown menu. These are typically:
- Casino/gambling site names (Gamdom, Stake, CSGORoll, BC.Game, etc.)
- Leaderboard categories or types

List EVERY visible option in the dropdown, even if partially visible.

Common names to look for:
gamdom, packdraw, stake, shuffle, rollbit, roobet, clash, lootbox, csgoempire, csgoroll, duelbits, hypedrop, cases, clash.gg, luxdrop, csgopolygon, rainbet, bc.game, bcgame, thunderpick, chicken, csbattle, upgrader

Return your findings as JSON:
{
  "dropdownOptions": ["option1", "option2", "option3", ...],
  "optionCount": <number>,
  "isFullyVisible": true/false,
  "needsScrolling": true/false,
  "confidence": <0-100>,
  "notes": "observations about dropdown contents"
}`;

// ============================================================================
// MAIN VERIFICATION FUNCTION
// ============================================================================

/**
 * Verify leaderboard count using screenshot + LLM
 * @param {Object} options - Verification options
 * @param {string} options.screenshotBase64 - Base64 encoded screenshot
 * @param {Array} options.detectedSwitchers - Switchers already detected by DOM
 * @param {string} options.domain - Domain being scraped
 * @param {string} options.basePath - Base path for site profiles
 * @returns {Object} - { additionalSwitchers, llmFindings, shouldUpdate }
 */
async function verifyLeaderboardsWithScreenshot(options) {
  const { screenshotBase64, detectedSwitchers = [], domain, basePath } = options;
  
  if (!screenshotBase64) {
    log('TEACHER', 'No screenshot provided for visual verification');
    return { additionalSwitchers: [], llmFindings: null, shouldUpdate: false };
  }
  
  log('TEACHER', `Visual verification for ${domain}...`);
  
  try {
    // Call LLM with screenshot
    const response = await callClaude({
      systemPrompt: VISUAL_VERIFICATION_PROMPT,
      userMessage: 'Analyze this leaderboard page screenshot and identify all site switchers.',
      basePath,
      domain,
      imageBase64: screenshotBase64,
      maxTokens: 1000
    });
    
    if (!response.success) {
      log('TEACHER', `Visual verification LLM call failed: ${response.error}`);
      return { additionalSwitchers: [], llmFindings: null, shouldUpdate: false };
    }
    
    // Parse LLM response
    let llmFindings;
    try {
      // Try to extract JSON from response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        llmFindings = JSON.parse(jsonMatch[0]);
      } else {
        log('TEACHER', 'Could not parse JSON from LLM response');
        return { additionalSwitchers: [], llmFindings: null, shouldUpdate: false };
      }
    } catch (parseErr) {
      log('TEACHER', `Failed to parse LLM response: ${parseErr.message}`);
      return { additionalSwitchers: [], llmFindings: null, shouldUpdate: false };
    }
    
    log('TEACHER', `LLM found ${llmFindings.switcherCount} switchers: ${llmFindings.siteSwitchersFound.join(', ') || 'none'}`);
    
    // Compare with detected switchers
    const detectedNames = new Set(detectedSwitchers.map(s => s.keyword.toLowerCase()));
    const additionalSwitchers = [];
    
    for (const llmSwitcher of llmFindings.siteSwitchersFound || []) {
      const normalized = llmSwitcher.toLowerCase().trim();
      if (!detectedNames.has(normalized)) {
        additionalSwitchers.push({
          keyword: llmSwitcher,
          type: 'llm-visual',
          priority: 70, // Higher priority since LLM visually confirmed
          coordinates: null, // Will need re-detection
          source: 'visual-verification',
          requiresCoordinateDetection: true
        });
        log('TEACHER', `LLM found additional switcher: ${llmSwitcher}`);
      }
    }
    
    // Check if LLM found fewer (might mean some detected ones don't exist)
    const missingFromLlm = [];
    for (const detected of detectedSwitchers) {
      const detectedLower = detected.keyword.toLowerCase();
      const inLlmFindings = (llmFindings.siteSwitchersFound || [])
        .some(s => s.toLowerCase() === detectedLower);
      
      if (!inLlmFindings && llmFindings.confidence >= 70) {
        missingFromLlm.push(detected.keyword);
        log('TEACHER', `DOM detected "${detected.keyword}" but LLM didn't see it (may be hidden/inactive)`);
      }
    }
    
    // Update site profile with verification timestamp
    if (basePath && domain) {
      try {
        await updateSiteProfile(basePath, domain, {
          lastScreenshotVerifyAt: new Date().toISOString(),
          lastVisualVerification: {
            llmSwitcherCount: llmFindings.switcherCount,
            llmSwitchers: llmFindings.siteSwitchersFound,
            domSwitcherCount: detectedSwitchers.length,
            additionalFound: additionalSwitchers.length,
            missingFromLlm: missingFromLlm,
            confidence: llmFindings.confidence,
            notes: llmFindings.notes
          }
        });
      } catch (e) {
        log('TEACHER', `Failed to update profile: ${e.message}`);
      }
    }
    
    return {
      additionalSwitchers,
      llmFindings,
      missingFromLlm,
      shouldUpdate: additionalSwitchers.length > 0
    };
    
  } catch (err) {
    log('ERR', `Visual verification error: ${err.message}`);
    return { additionalSwitchers: [], llmFindings: null, shouldUpdate: false };
  }
}

/**
 * Check if visual verification is needed (>24h since last check)
 * @param {string} basePath - Base path for site profiles
 * @param {string} domain - Domain to check
 * @returns {boolean} - Whether verification is needed
 */
function needsVisualVerification(basePath, domain) {
  try {
    const profile = getSiteProfile(basePath, domain);
    const lastVerify = profile.lastScreenshotVerifyAt;
    
    if (!lastVerify) {
      return true; // Never verified
    }
    
    const lastVerifyTime = new Date(lastVerify).getTime();
    const now = Date.now();
    
    return (now - lastVerifyTime) > VISUAL_VERIFY_COOLDOWN_MS;
  } catch (e) {
    return true; // Default to needing verification
  }
}

// ============================================================================
// INTERACTIVE DROPDOWN EXPLORATION
// ============================================================================

/**
 * Explore a dropdown by clicking on it and analyzing the contents
 * @param {Object} options - Exploration options
 * @param {Page} options.page - Playwright page instance
 * @param {Object} options.dropdownInfo - Info about the dropdown from initial analysis
 * @param {string} options.domain - Domain being scraped
 * @param {string} options.basePath - Base path for site profiles
 * @returns {Object} - { dropdownOptions, success }
 */
async function exploreDropdown(options) {
  const { page, dropdownInfo, domain, basePath } = options;
  
  if (!page || !dropdownInfo) {
    log('TEACHER', 'Cannot explore dropdown: missing page or dropdownInfo');
    return { dropdownOptions: [], success: false };
  }
  
  log('TEACHER', `Exploring dropdown: ${dropdownInfo.description || 'unknown'}`);
  
  try {
    // Find and click the dropdown element
    // Try multiple selectors based on common dropdown patterns
    const dropdownSelectors = [
      // Select elements
      'select',
      // Common dropdown class patterns
      '[class*="dropdown"]',
      '[class*="select"]',
      '[class*="Dropdown"]',
      '[class*="Select"]',
      // Elements with dropdown indicators
      '[aria-haspopup="listbox"]',
      '[aria-haspopup="menu"]',
      '[role="combobox"]',
      '[role="listbox"]',
      // Clickable elements with arrows
      'button:has(svg[class*="arrow"])',
      'button:has(svg[class*="chevron"])',
      'div[class*="dropdown"] button',
      'div[class*="select"] button',
      // BC.Game specific (from the screenshot)
      '[class*="game"] button',
      '[class*="Game"] button'
    ];
    
    let clicked = false;
    let clickedSelector = null;
    
    for (const selector of dropdownSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          // Check if this element is visible and contains the current value
          const isVisible = await element.isVisible();
          if (isVisible) {
            const text = await element.textContent();
            if (dropdownInfo.currentValue && 
                text && 
                text.toLowerCase().includes(dropdownInfo.currentValue.toLowerCase())) {
              log('TEACHER', `Found dropdown element matching "${dropdownInfo.currentValue}": ${selector}`);
              await element.click();
              clicked = true;
              clickedSelector = selector;
              break;
            }
          }
        }
      } catch (e) {
        // Continue to next selector
      }
    }
    
    // If no matching element found, try to click at approximate location
    if (!clicked && dropdownInfo.approximateLocation) {
      log('TEACHER', `Trying to click dropdown by approximate location: ${dropdownInfo.approximateLocation}`);
      
      const viewport = await page.viewportSize();
      let clickX = viewport.width / 2;
      let clickY = 100; // Default to near top
      
      const location = dropdownInfo.approximateLocation.toLowerCase();
      if (location.includes('left')) clickX = viewport.width * 0.25;
      if (location.includes('right')) clickX = viewport.width * 0.75;
      if (location.includes('center') && !location.includes('top')) clickY = viewport.height / 2;
      if (location.includes('top')) clickY = 150;
      
      try {
        await page.mouse.click(clickX, clickY);
        clicked = true;
        log('TEACHER', `Clicked at coordinates (${clickX}, ${clickY})`);
      } catch (e) {
        log('TEACHER', `Click at location failed: ${e.message}`);
      }
    }
    
    if (!clicked) {
      log('TEACHER', 'Could not find or click dropdown element');
      return { dropdownOptions: [], success: false };
    }
    
    // Wait for dropdown to open
    await page.waitForTimeout(1000);
    
    // Take screenshot of opened dropdown
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const screenshotBase64 = screenshot.toString('base64');
    
    // Send to LLM for analysis
    const response = await callClaude({
      systemPrompt: DROPDOWN_EXPLORATION_PROMPT,
      userMessage: 'Analyze this opened dropdown menu and list ALL visible options.',
      basePath,
      domain,
      imageBase64: screenshotBase64,
      maxTokens: 1000
    });
    
    if (!response.success) {
      log('TEACHER', `Dropdown analysis LLM call failed: ${response.error}`);
      // Close dropdown by clicking elsewhere
      await page.mouse.click(10, 10);
      return { dropdownOptions: [], success: false };
    }
    
    // Parse response
    let dropdownFindings;
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        dropdownFindings = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      log('TEACHER', `Failed to parse dropdown analysis: ${e.message}`);
    }
    
    // Close dropdown by pressing Escape or clicking elsewhere
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } catch (e) {
      await page.mouse.click(10, 10);
    }
    
    if (dropdownFindings && dropdownFindings.dropdownOptions) {
      log('TEACHER', `Dropdown exploration found ${dropdownFindings.dropdownOptions.length} options: ${dropdownFindings.dropdownOptions.join(', ')}`);
      return {
        dropdownOptions: dropdownFindings.dropdownOptions,
        optionCount: dropdownFindings.optionCount,
        needsScrolling: dropdownFindings.needsScrolling,
        success: true
      };
    }
    
    return { dropdownOptions: [], success: false };
    
  } catch (err) {
    log('ERR', `Dropdown exploration error: ${err.message}`);
    // Try to close any open dropdown
    try {
      await page.keyboard.press('Escape');
    } catch (e) {
      // Ignore
    }
    return { dropdownOptions: [], success: false };
  }
}

/**
 * Enhanced visual verification with interactive exploration
 * @param {Object} options - Verification options
 * @param {Page} options.page - Playwright page instance (required for interactive mode)
 * @param {string} options.screenshotBase64 - Base64 encoded screenshot
 * @param {Array} options.detectedSwitchers - Switchers already detected by DOM
 * @param {string} options.domain - Domain being scraped
 * @param {string} options.basePath - Base path for site profiles
 * @param {boolean} options.enableInteraction - Whether to allow clicking (default: true)
 * @returns {Object} - { additionalSwitchers, llmFindings, shouldUpdate, exploredDropdown }
 */
async function verifyWithInteraction(options) {
  const { 
    page, 
    screenshotBase64, 
    detectedSwitchers = [], 
    domain, 
    basePath,
    enableInteraction = true 
  } = options;
  
  // First, do the standard visual verification
  const verificationResult = await verifyLeaderboardsWithScreenshot({
    screenshotBase64,
    detectedSwitchers,
    domain,
    basePath
  });
  
  // Check if LLM found a dropdown that needs exploration
  if (enableInteraction && 
      page && 
      verificationResult.llmFindings && 
      verificationResult.llmFindings.hasDropdown &&
      verificationResult.llmFindings.dropdownInfo) {
    
    log('TEACHER', 'Dropdown detected! Starting interactive exploration...');
    
    const dropdownResult = await exploreDropdown({
      page,
      dropdownInfo: verificationResult.llmFindings.dropdownInfo,
      domain,
      basePath
    });
    
    if (dropdownResult.success && dropdownResult.dropdownOptions.length > 0) {
      // Add dropdown options as additional switchers
      const detectedNames = new Set([
        ...detectedSwitchers.map(s => s.keyword.toLowerCase()),
        ...verificationResult.additionalSwitchers.map(s => s.keyword.toLowerCase())
      ]);
      
      for (const option of dropdownResult.dropdownOptions) {
        const normalized = option.toLowerCase().trim();
        if (!detectedNames.has(normalized)) {
          verificationResult.additionalSwitchers.push({
            keyword: option,
            type: 'llm-dropdown-explore',
            priority: 75, // Higher priority - discovered through interaction
            coordinates: null,
            source: 'dropdown-exploration',
            requiresCoordinateDetection: true
          });
          detectedNames.add(normalized);
          log('TEACHER', `Dropdown exploration found: ${option}`);
        }
      }
      
      verificationResult.exploredDropdown = true;
      verificationResult.dropdownOptions = dropdownResult.dropdownOptions;
    }
  }
  
  return verificationResult;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  verifyLeaderboardsWithScreenshot,
  needsVisualVerification,
  exploreDropdown,
  verifyWithInteraction,
  VISUAL_VERIFY_COOLDOWN_MS,
  VISUAL_VERIFICATION_PROMPT,
  DROPDOWN_EXPLORATION_PROMPT
};
