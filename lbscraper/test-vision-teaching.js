/**
 * Claude Vision Teaching Test
 *
 * Comprehensive test that:
 * 1. Discovers all tabs/buttons on each site
 * 2. Clicks through each leaderboard
 * 3. Handles "Show More" buttons
 * 4. Scrolls to load all content
 * 5. Analyzes structure with Claude Vision
 * 6. Validates extracted data
 * 7. Generates HTML report
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { callClaude, isLLMAvailable } = require('./shared/teacher/llm-client');
const { log } = require('./shared/utils');

// Test sites - mix of different patterns
const TEST_SITES = [
  { url: 'https://wrewards.com/leaderboards', name: 'wrewards', type: 'button-based', notes: 'Reference site, has Show More, long lists' },
  { url: 'https://devlrewards.com/leaderboard', name: 'devlrewards', type: 'button-based', notes: 'Button tabs, 50-100 entries possible' },
  { url: 'https://goatgambles.com/leaderboard', name: 'goatgambles', type: 'button-based', notes: 'Reference site, multiple LBs' },
  { url: 'https://paxgambles.com/leaderboard', name: 'paxgambles', type: 'url-based', notes: 'Reference site, simple' },
  { url: 'https://www.ilovemav.com/leaderboards', name: 'ilovemav', type: 'button-based', notes: 'Multiple tabs, was missing some' },
  { url: 'https://spencerrewards.com/leaderboard', name: 'spencerrewards', type: 'url-based', notes: 'Has Reward column (not Prize)' },
  { url: 'https://ravengambles.com/leaderboard', name: 'ravengambles', type: 'button-based', notes: 'New site test' },
  { url: 'https://www.tanskidegen.com/leaderboards', name: 'tanskidegen', type: 'button-based', notes: 'New site test' },
  { url: 'https://adukes.com/leaderboard', name: 'adukes', type: 'url-based', notes: 'URL-based navigation' },
  { url: 'https://rwrds.gg/leaderboard', name: 'rwrds', type: 'url-based', notes: 'Had popup issues before' },
];

// Prompts
const DISCOVERY_PROMPT = `You are analyzing a gambling affiliate leaderboard page.

Look at this screenshot and identify:

1. **Clickable Tabs/Buttons**: Find ALL tabs, buttons, or links that switch between different casino/gambling site leaderboards. These are usually logos or names like "Gamdom", "Stake", "Packdraw", "CSGORoll", "Clash", etc.

2. **Dropdown Menus**: Is there a dropdown that might contain more leaderboard options?

3. **"Show More" Button**: Is there a "Show More", "Load More", or similar button to reveal more entries?

4. **Currently Active Tab**: Which leaderboard is currently being displayed?

Return ONLY valid JSON (no markdown):
{
  "tabs_found": ["name1", "name2", "name3"],
  "has_dropdown": false,
  "dropdown_location": null,
  "has_show_more": false,
  "show_more_text": null,
  "current_active_tab": "name1",
  "total_tabs_visible": 3,
  "notes": "any observations"
}`;

const STRUCTURE_PROMPT = `Analyze this leaderboard screenshot and determine its exact structure.

Look carefully at:

1. **Column Order**: Look at the table/list headers or labels.
   - Is "Prize" or "Reward" shown BEFORE "Wagered" or "Wager"?
   - Or is "Wagered"/"Wager" shown BEFORE "Prize"/"Reward"?

2. **Podium Layout** (Top 3 players):
   - Is #1 in the CENTER (with #2 on left, #3 on right)? This is "center_first"
   - Or is it simply left-to-right (#1, #2, #3)? This is "left_to_right"
   - Look for visual cues: #1 usually has crown, gold, or is larger

3. **Entry Format**:
   - "table": Rows with columns
   - "cards": Individual card boxes per user
   - "list": Simple list with entries

4. **Entry Count**: How many entries are visible?

5. **Has More Below**: Is there content cut off at the bottom?

Return ONLY valid JSON (no markdown):
{
  "column_order": "prize_before_wager" or "wager_before_prize" or "wager_only" or "unknown",
  "podium_layout": "center_first" or "left_to_right" or "no_podium",
  "podium_ranks_visible": [1, 2, 3],
  "entry_format": "table" or "cards" or "list" or "mixed",
  "visible_entry_count": 10,
  "max_rank_visible": 10,
  "has_more_below": false,
  "has_pagination": false,
  "wager_label": "Wagered" or "Wager" or "Points" or null,
  "prize_label": "Prize" or "Reward" or null,
  "confidence": 95,
  "notes": "any observations about the layout"
}`;

const EXTRACTION_PROMPT = `Extract ALL leaderboard entries visible in this screenshot.

For EACH entry, extract:
- rank: Position number (1, 2, 3, etc.)
- username: Player name (may have asterisks like "Joh***")
- wager: Amount wagered (the larger number, determines ranking)
- prize: Reward amount (smaller number, $0 if not shown)

IMPORTANT:
- Look at ALL entries, including the podium (top 3) AND the list below
- The podium may show #1 in the CENTER, not on the left
- Wager is usually the larger number that determines leaderboard position
- Prize/Reward is usually the smaller number showing what they win

Return ONLY valid JSON:
{
  "entries": [
    {"rank": 1, "username": "Player1", "wager": 500000, "prize": 5000},
    {"rank": 2, "username": "Pla***", "wager": 350000, "prize": 2500}
  ],
  "total_extracted": 10,
  "confidence": 95
}`;

// Helper functions
async function dismissPopups(page) {
  const closeSelectors = [
    '[class*="close"]', '[class*="Close"]', '[aria-label="Close"]',
    'button:has-text("Close")', 'button:has-text("×")', 'button:has-text("X")',
    '[class*="modal"] button', '[class*="overlay"] button', '[class*="dismiss"]'
  ];

  for (const sel of closeSelectors) {
    try {
      const elements = await page.$$(sel);
      for (const el of elements) {
        if (await el.isVisible()) {
          await el.click().catch(() => {});
          await page.waitForTimeout(300);
        }
      }
    } catch (e) {}
  }

  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch (e) {}
}

async function clickShowMore(page) {
  const showMoreSelectors = [
    'button:has-text("Show More")', 'button:has-text("Load More")',
    'button:has-text("View More")', 'button:has-text("See More")',
    '[class*="show-more"]', '[class*="load-more"]',
    'a:has-text("Show More")', 'a:has-text("Load More")'
  ];

  let clicked = false;
  for (const sel of showMoreSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        clicked = true;
        await page.waitForTimeout(2000);
        break;
      }
    } catch (e) {}
  }
  return clicked;
}

async function scrollToBottom(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const maxScroll = 10000; // Don't scroll forever
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight || totalHeight >= maxScroll) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
  await page.waitForTimeout(1000);
}

async function captureScreenshot(page, name, debugDir) {
  const filename = `vision-teach-${name}-${Date.now()}.png`;
  const filepath = path.join(debugDir, filename);

  // Scroll back to top first
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  await page.screenshot({ path: filepath, fullPage: true, timeout: 30000 });
  return { filepath, filename };
}

async function analyzeWithVision(screenshotPath, prompt, siteName, basePath) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64Image = imageData.toString('base64');
  const fileSizeMB = imageData.length / (1024 * 1024);

  if (fileSizeMB > 20) {
    return { success: false, error: `Screenshot too large: ${fileSizeMB.toFixed(2)}MB` };
  }

  const startTime = Date.now();
  const response = await callClaude({
    systemPrompt: prompt,
    userMessage: 'Analyze this screenshot.',
    basePath,
    domain: siteName,
    imageBase64: base64Image,
    maxTokens: 4000
  });

  return {
    success: response.success,
    content: response.content,
    error: response.error,
    elapsed: Date.now() - startTime,
    cost: response.usage?.cost || 0
  };
}

function parseVisionResponse(response) {
  if (!response.success || !response.content) return null;

  try {
    let jsonStr = response.content;
    if (jsonStr.includes('```')) {
      jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    }
    return JSON.parse(jsonStr.trim());
  } catch (e) {
    return null;
  }
}

async function findAndClickTab(page, tabName) {
  // Try various selectors to find and click the tab
  const selectors = [
    `img[src*="${tabName.toLowerCase()}"]`,
    `img[alt*="${tabName}"]`,
    `[class*="${tabName.toLowerCase()}"]`,
    `button:has-text("${tabName}")`,
    `a:has-text("${tabName}")`,
    `div:has-text("${tabName}")`,
    `span:has-text("${tabName}")`
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        // Try to find clickable parent
        const clickable = await el.evaluate(node => {
          const parent = node.closest('button, a, [role="button"], [onclick]');
          if (parent) {
            parent.click();
            return true;
          }
          node.click();
          return true;
        });
        if (clickable) {
          await page.waitForTimeout(2000);
          return true;
        }
      }
    } catch (e) {}
  }
  return false;
}

async function runTeachingTest() {
  console.log('🎓 Claude Vision Teaching Test');
  console.log('═'.repeat(60));
  console.log(`Testing ${TEST_SITES.length} sites\n`);

  if (!isLLMAvailable()) {
    console.log('❌ LLM not available. Set ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  const debugDir = path.join(__dirname, 'debug', 'vision-teaching');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  const results = [];
  let totalCost = 0;

  for (const site of TEST_SITES) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🌐 ${site.name.toUpperCase()}`);
    console.log(`   URL: ${site.url}`);
    console.log(`   Type: ${site.type}`);
    console.log(`   Notes: ${site.notes}`);

    const siteResult = {
      site: site.name,
      url: site.url,
      type: site.type,
      phases: {},
      leaderboards: [],
      totalCost: 0,
      errors: []
    };

    try {
      const page = await context.newPage();

      // Navigate
      console.log(`\n   📍 Navigating...`);
      await page.goto(site.url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);
      await dismissPopups(page);

      // PHASE 1: Discovery
      console.log(`\n   🔍 PHASE 1: Discovery`);
      const discoveryScreenshot = await captureScreenshot(page, `${site.name}-discovery`, debugDir);
      console.log(`      Screenshot: ${discoveryScreenshot.filename}`);

      const discoveryResponse = await analyzeWithVision(
        discoveryScreenshot.filepath,
        DISCOVERY_PROMPT,
        site.name,
        __dirname
      );

      const discovery = parseVisionResponse(discoveryResponse);
      siteResult.phases.discovery = {
        screenshot: discoveryScreenshot.filename,
        response: discovery,
        cost: discoveryResponse.cost,
        elapsed: discoveryResponse.elapsed
      };
      totalCost += discoveryResponse.cost || 0;
      siteResult.totalCost += discoveryResponse.cost || 0;

      if (discovery) {
        console.log(`      ✅ Found ${discovery.tabs_found?.length || 0} tabs: ${discovery.tabs_found?.join(', ') || 'none'}`);
        console.log(`      📋 Active tab: ${discovery.current_active_tab || 'unknown'}`);
        console.log(`      🔘 Has Show More: ${discovery.has_show_more}`);
      } else {
        console.log(`      ⚠️ Could not parse discovery response`);
        siteResult.errors.push('Discovery parse failed');
      }

      // PHASE 2: Per-Leaderboard Analysis
      const tabsToAnalyze = discovery?.tabs_found || ['default'];
      console.log(`\n   📊 PHASE 2: Analyzing ${tabsToAnalyze.length} leaderboard(s)`);

      for (const tabName of tabsToAnalyze) {
        console.log(`\n      ── ${tabName} ──`);

        const lbResult = {
          name: tabName,
          screenshots: [],
          structure: null,
          extraction: null,
          cost: 0
        };

        // Click tab if not the active one
        if (tabName !== discovery?.current_active_tab && tabName !== 'default') {
          console.log(`      Clicking tab: ${tabName}`);
          const clicked = await findAndClickTab(page, tabName);
          if (!clicked) {
            console.log(`      ⚠️ Could not click tab`);
            lbResult.error = 'Could not click tab';
            siteResult.leaderboards.push(lbResult);
            continue;
          }
          await page.waitForTimeout(2000);
          await dismissPopups(page);
        }

        // Click "Show More" if present
        if (discovery?.has_show_more) {
          console.log(`      Clicking Show More...`);
          let clickCount = 0;
          while (await clickShowMore(page) && clickCount < 5) {
            clickCount++;
            console.log(`         Clicked ${clickCount} time(s)`);
          }
        }

        // Scroll to load all content
        console.log(`      Scrolling to load content...`);
        await scrollToBottom(page);

        // Capture screenshot
        const lbScreenshot = await captureScreenshot(page, `${site.name}-${tabName}`, debugDir);
        lbResult.screenshots.push(lbScreenshot.filename);
        console.log(`      Screenshot: ${lbScreenshot.filename}`);

        // Analyze structure
        console.log(`      Analyzing structure...`);
        const structureResponse = await analyzeWithVision(
          lbScreenshot.filepath,
          STRUCTURE_PROMPT,
          `${site.name}-${tabName}`,
          __dirname
        );

        const structure = parseVisionResponse(structureResponse);
        lbResult.structure = structure;
        lbResult.cost += structureResponse.cost || 0;
        totalCost += structureResponse.cost || 0;
        siteResult.totalCost += structureResponse.cost || 0;

        if (structure) {
          console.log(`      ✅ Column order: ${structure.column_order}`);
          console.log(`      ✅ Podium layout: ${structure.podium_layout}`);
          console.log(`      ✅ Entry format: ${structure.entry_format}`);
          console.log(`      ✅ Visible entries: ${structure.visible_entry_count}`);
        }

        // Extract data
        console.log(`      Extracting entries...`);
        const extractionResponse = await analyzeWithVision(
          lbScreenshot.filepath,
          EXTRACTION_PROMPT,
          `${site.name}-${tabName}`,
          __dirname
        );

        const extraction = parseVisionResponse(extractionResponse);
        lbResult.extraction = extraction;
        lbResult.cost += extractionResponse.cost || 0;
        totalCost += extractionResponse.cost || 0;
        siteResult.totalCost += extractionResponse.cost || 0;

        if (extraction) {
          console.log(`      ✅ Extracted ${extraction.entries?.length || 0} entries`);
          if (extraction.entries?.length > 0) {
            const e = extraction.entries[0];
            console.log(`         #1: ${e.username} - wager: $${e.wager?.toLocaleString()}, prize: $${e.prize}`);
          }
        }

        siteResult.leaderboards.push(lbResult);

        // Don't analyze more than 3 leaderboards per site for cost control
        if (siteResult.leaderboards.length >= 3) {
          console.log(`\n      ⏹️ Limiting to 3 leaderboards for cost control`);
          break;
        }
      }

      await page.close();

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      siteResult.errors.push(error.message);
    }

    results.push(siteResult);
    console.log(`\n   💰 Site cost: $${siteResult.totalCost.toFixed(4)}`);
  }

  await browser.close();

  // Generate report
  console.log('\n' + '═'.repeat(60));
  console.log('📊 GENERATING REPORT');
  console.log('═'.repeat(60));

  const reportPath = generateHTMLReport(results, debugDir, totalCost);
  const jsonPath = path.join(debugDir, 'teaching-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  console.log(`\n✅ Test complete!`);
  console.log(`📄 HTML Report: ${reportPath}`);
  console.log(`💾 JSON Results: ${jsonPath}`);
  console.log(`💰 Total Cost: $${totalCost.toFixed(4)}`);
  console.log(`\n🌐 Open the report:`);
  console.log(`   open "${reportPath}"`);

  return results;
}

function generateHTMLReport(results, debugDir, totalCost) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Claude Vision Teaching Test Results</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #0f0f1a; color: #e0e0e0; }
    h1 { color: #00d4ff; margin-bottom: 10px; }
    .summary { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border: 1px solid #00d4ff; border-radius: 12px; padding: 25px; margin-bottom: 30px; }
    .summary h2 { margin-top: 0; color: #00d4ff; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-top: 20px; }
    .summary-item { text-align: center; background: #0f0f1a; padding: 15px; border-radius: 8px; }
    .summary-value { font-size: 2.5em; font-weight: bold; color: #00ff88; }
    .summary-label { color: #888; margin-top: 5px; }

    .site { background: #16213e; border-radius: 12px; margin-bottom: 25px; overflow: hidden; }
    .site-header { background: linear-gradient(90deg, #1a1a2e 0%, #0f3460 100%); padding: 20px; border-bottom: 1px solid #333; }
    .site-name { font-size: 1.8em; color: #00d4ff; margin: 0; }
    .site-meta { color: #888; margin-top: 8px; font-size: 0.9em; }
    .site-body { padding: 20px; }

    .phase { background: #1a1a2e; border-radius: 8px; padding: 15px; margin-bottom: 15px; }
    .phase-title { color: #00d4ff; font-weight: bold; margin-bottom: 10px; }

    .leaderboard { background: #0f0f1a; border-radius: 8px; padding: 15px; margin-bottom: 15px; border-left: 3px solid #00d4ff; }
    .lb-name { font-size: 1.2em; color: #fff; margin-bottom: 10px; }
    .lb-stats { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 10px; }
    .lb-stat { background: #1a1a2e; padding: 8px 12px; border-radius: 5px; }
    .lb-stat-label { color: #888; font-size: 0.8em; }
    .lb-stat-value { color: #00ff88; font-weight: bold; }

    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #0f3460; color: #00d4ff; }
    tr:hover { background: #1f3a60; }

    .screenshot-container { margin-top: 15px; }
    .screenshot-label { color: #888; margin-bottom: 5px; }
    .screenshot { max-width: 100%; max-height: 400px; border: 1px solid #333; border-radius: 5px; cursor: pointer; }
    .screenshot:hover { border-color: #00d4ff; }

    .error { color: #ff4444; background: #441111; padding: 10px; border-radius: 5px; }
    .success { color: #00ff88; }
    .warning { color: #ffaa00; }

    .tabs-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
    .tab-badge { background: #0f3460; color: #00d4ff; padding: 5px 12px; border-radius: 15px; font-size: 0.9em; }

    /* Modal for full-size screenshots */
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 1000; }
    .modal.active { display: flex; align-items: center; justify-content: center; }
    .modal img { max-width: 95%; max-height: 95%; }
    .modal-close { position: absolute; top: 20px; right: 30px; color: #fff; font-size: 40px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>🎓 Claude Vision Teaching Test Results</h1>
  <p style="color: #888;">Generated: ${new Date().toISOString()}</p>

  <div class="summary">
    <h2>📊 Summary</h2>
    <div class="summary-grid">
      <div class="summary-item">
        <div class="summary-value">${results.length}</div>
        <div class="summary-label">Sites Tested</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${results.reduce((sum, r) => sum + r.leaderboards.length, 0)}</div>
        <div class="summary-label">Leaderboards Analyzed</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${results.reduce((sum, r) => sum + r.leaderboards.reduce((s, l) => s + (l.extraction?.entries?.length || 0), 0), 0)}</div>
        <div class="summary-label">Total Entries Extracted</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">$${totalCost.toFixed(4)}</div>
        <div class="summary-label">Total Cost</div>
      </div>
    </div>
  </div>

  ${results.map(site => `
  <div class="site">
    <div class="site-header">
      <h2 class="site-name">${site.errors.length > 0 ? '⚠️' : '✅'} ${site.site}</h2>
      <div class="site-meta">
        <strong>URL:</strong> <a href="${site.url}" style="color: #00d4ff;">${site.url}</a> |
        <strong>Type:</strong> ${site.type} |
        <strong>Cost:</strong> $${site.totalCost.toFixed(4)}
      </div>
    </div>
    <div class="site-body">
      ${site.errors.length > 0 ? `<div class="error">Errors: ${site.errors.join(', ')}</div>` : ''}

      <!-- Discovery Phase -->
      <div class="phase">
        <div class="phase-title">🔍 Phase 1: Discovery</div>
        ${site.phases.discovery ? `
          <p><strong>Tabs Found:</strong></p>
          <div class="tabs-list">
            ${(site.phases.discovery.response?.tabs_found || []).map(t => `<span class="tab-badge">${t}</span>`).join('')}
          </div>
          <p>
            <strong>Active Tab:</strong> ${site.phases.discovery.response?.current_active_tab || 'unknown'} |
            <strong>Has Show More:</strong> ${site.phases.discovery.response?.has_show_more ? 'Yes' : 'No'} |
            <strong>Has Dropdown:</strong> ${site.phases.discovery.response?.has_dropdown ? 'Yes' : 'No'}
          </p>
          ${site.phases.discovery.response?.notes ? `<p><em>Notes: ${site.phases.discovery.response.notes}</em></p>` : ''}
          <div class="screenshot-container">
            <div class="screenshot-label">Discovery Screenshot:</div>
            <img class="screenshot" src="${site.phases.discovery.screenshot}" onclick="openModal(this.src)" />
          </div>
        ` : '<p class="warning">Discovery failed</p>'}
      </div>

      <!-- Leaderboards -->
      <div class="phase">
        <div class="phase-title">📊 Phase 2: Leaderboard Analysis</div>
        ${site.leaderboards.map(lb => `
        <div class="leaderboard">
          <div class="lb-name">${lb.error ? '❌' : '✅'} ${lb.name}</div>
          ${lb.error ? `<div class="error">${lb.error}</div>` : `
          <div class="lb-stats">
            <div class="lb-stat">
              <div class="lb-stat-label">Column Order</div>
              <div class="lb-stat-value">${lb.structure?.column_order || 'unknown'}</div>
            </div>
            <div class="lb-stat">
              <div class="lb-stat-label">Podium Layout</div>
              <div class="lb-stat-value">${lb.structure?.podium_layout || 'unknown'}</div>
            </div>
            <div class="lb-stat">
              <div class="lb-stat-label">Format</div>
              <div class="lb-stat-value">${lb.structure?.entry_format || 'unknown'}</div>
            </div>
            <div class="lb-stat">
              <div class="lb-stat-label">Entries Visible</div>
              <div class="lb-stat-value">${lb.structure?.visible_entry_count || 0}</div>
            </div>
            <div class="lb-stat">
              <div class="lb-stat-label">Entries Extracted</div>
              <div class="lb-stat-value">${lb.extraction?.entries?.length || 0}</div>
            </div>
          </div>

          ${lb.structure?.notes ? `<p style="color: #888;"><em>Structure Notes: ${lb.structure.notes}</em></p>` : ''}

          ${lb.extraction?.entries?.length > 0 ? `
          <table>
            <tr><th>Rank</th><th>Username</th><th>Wager</th><th>Prize</th></tr>
            ${lb.extraction.entries.slice(0, 10).map(e => `
            <tr>
              <td>#${e.rank}</td>
              <td>${e.username}</td>
              <td>$${(e.wager || 0).toLocaleString()}</td>
              <td>$${(e.prize || 0).toLocaleString()}</td>
            </tr>
            `).join('')}
            ${lb.extraction.entries.length > 10 ? `<tr><td colspan="4" style="text-align: center; color: #888;">... and ${lb.extraction.entries.length - 10} more</td></tr>` : ''}
          </table>
          ` : ''}

          <div class="screenshot-container">
            <div class="screenshot-label">Screenshot:</div>
            ${lb.screenshots.map(s => `<img class="screenshot" src="${s}" onclick="openModal(this.src)" />`).join('')}
          </div>
          `}
        </div>
        `).join('')}
      </div>
    </div>
  </div>
  `).join('')}

  <!-- Modal -->
  <div class="modal" id="modal" onclick="closeModal()">
    <span class="modal-close">&times;</span>
    <img id="modal-img" src="" />
  </div>

  <script>
    function openModal(src) {
      document.getElementById('modal-img').src = src;
      document.getElementById('modal').classList.add('active');
    }
    function closeModal() {
      document.getElementById('modal').classList.remove('active');
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  </script>
</body>
</html>`;

  const reportPath = path.join(debugDir, 'teaching-report.html');
  fs.writeFileSync(reportPath, html);
  return reportPath;
}

// Run
runTeachingTest().catch(console.error);
