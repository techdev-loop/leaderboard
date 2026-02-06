/**
 * Claude Vision Teaching Test v2
 *
 * Uses EXISTING scraper infrastructure for:
 * - Tab discovery (site-detection.js)
 * - Tab clicking (scrape-orchestrator click logic)
 * - Scrolling and content loading
 *
 * Vision ONLY analyzes screenshots to learn:
 * - Column order (prize vs wager first)
 * - Podium layout (center vs left-to-right)
 * - Entry format
 *
 * Does NOT try to extract all entries - that's the scraper's job.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Existing scraper modules
const { findSiteSwitchers } = require('./shared/site-detection');
const { setupNetworkCapture, clearNetworkData } = require('./shared/network-capture');
const { callClaude, isLLMAvailable } = require('./shared/teacher/llm-client');
const { log } = require('./shared/utils');

// Load keywords
const keywordsPath = path.join(__dirname, 'keywords.txt');
const KEYWORDS = fs.existsSync(keywordsPath)
  ? fs.readFileSync(keywordsPath, 'utf8').split('\n').map(k => k.trim().toLowerCase()).filter(k => k && !k.startsWith('#'))
  : ['gamdom', 'stake', 'packdraw', 'clash', 'roobet', 'shuffle', 'rain', 'csgoroll'];

// Test sites
const TEST_SITES = [
  { url: 'https://devlrewards.com/leaderboard', name: 'devlrewards' },
  { url: 'https://goatgambles.com/leaderboard', name: 'goatgambles' },
  { url: 'https://paxgambles.com/leaderboard', name: 'paxgambles' },
  { url: 'https://www.ilovemav.com/leaderboards', name: 'ilovemav' },
  { url: 'https://spencerrewards.com/leaderboard', name: 'spencerrewards' },
  { url: 'https://ravengambles.com/leaderboard', name: 'ravengambles' },
  { url: 'https://www.tanskidegen.com/leaderboards', name: 'tanskidegen' },
  { url: 'https://adukes.com/leaderboard', name: 'adukes' },
  { url: 'https://rwrds.gg/leaderboard', name: 'rwrds' },
  { url: 'https://wahy.gg/leaderboard', name: 'wahy' },
];

// Vision prompt - focused on STRUCTURE, not data extraction
const STRUCTURE_PROMPT = `You are analyzing a gambling affiliate leaderboard screenshot.

Your job is to identify the STRUCTURE and LAYOUT - NOT to extract all the data.

Look at the screenshot and determine:

1. **Column Order**: Look at headers or labels.
   - Is "Prize" / "Reward" shown BEFORE "Wagered" / "Wager"? → "prize_before_wager"
   - Is "Wagered" / "Wager" shown BEFORE "Prize" / "Reward"? → "wager_before_prize"
   - Only wager shown, no prize column? → "wager_only"

2. **Podium Layout** (Top 3 section):
   - Is #1 in the CENTER (larger, with #2 left, #3 right)? → "center_first"
   - Is it left-to-right (#1, #2, #3)? → "left_to_right"
   - No special top 3 display? → "no_podium"

3. **Entry Format**:
   - Rows with columns → "table"
   - Individual boxes per user → "cards"
   - Simple vertical list → "list"

4. **Labels Used**: What exact text labels do you see?
   - Wager label: "Wagered", "Wager", "Total Wagered", etc.
   - Prize label: "Prize", "Reward", "Winnings", etc.

Return ONLY valid JSON:
{
  "column_order": "prize_before_wager" | "wager_before_prize" | "wager_only" | "unknown",
  "podium_layout": "center_first" | "left_to_right" | "no_podium",
  "entry_format": "table" | "cards" | "list" | "mixed",
  "wager_label": "Wagered" | null,
  "prize_label": "Reward" | "Prize" | null,
  "has_scrollable_container": true | false,
  "visible_entries_approx": 10,
  "confidence": 95,
  "notes": "any important observations"
}`;

async function dismissPopups(page) {
  // Press Escape
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch (e) {}

  // Click common close buttons
  const closeSelectors = ['[aria-label="Close"]', 'button:has-text("Close")', '[class*="close"]'];
  for (const sel of closeSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click();
        await page.waitForTimeout(300);
      }
    } catch (e) {}
  }
}

async function clickSwitcher(page, keyword, switcherData) {
  // Use the scraper's proven click logic
  const coords = switcherData?.coordinates;

  // Strategy 1: Try image-based click (most reliable for logo buttons)
  try {
    const clicked = await page.evaluate((kw) => {
      const selectors = [
        `img[src*="${kw}"]`,
        `img[alt*="${kw}"]`,
        `[class*="${kw}"]`,
        `[data-tab*="${kw}"]`
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          // Find clickable parent
          const clickable = el.closest('button, a, [role="button"], [onclick], .tab, .nav-item');
          if (clickable) {
            clickable.click();
            return true;
          }
          el.click();
          return true;
        }
      }
      return false;
    }, keyword.toLowerCase());

    if (clicked) {
      await page.waitForTimeout(2000);
      return true;
    }
  } catch (e) {}

  // Strategy 2: Coordinate click
  if (coords?.x && coords?.y) {
    try {
      await page.mouse.click(coords.x, coords.y);
      await page.waitForTimeout(2000);
      return true;
    } catch (e) {}
  }

  return false;
}

async function analyzeWithVision(page, siteName, leaderboardName, debugDir) {
  // Take screenshot of current viewport (not full page - we just need to see the structure)
  const filename = `teach-v2-${siteName}-${leaderboardName}-${Date.now()}.png`;
  const filepath = path.join(debugDir, filename);

  await page.screenshot({ path: filepath, fullPage: false });

  const imageData = fs.readFileSync(filepath);
  const base64Image = imageData.toString('base64');

  const response = await callClaude({
    systemPrompt: STRUCTURE_PROMPT,
    userMessage: 'Analyze this leaderboard structure.',
    basePath: __dirname,
    domain: `${siteName}-${leaderboardName}`,
    imageBase64: base64Image,
    maxTokens: 1000
  });

  let parsed = null;
  if (response.success && response.content) {
    try {
      let jsonStr = response.content;
      if (jsonStr.includes('```')) {
        jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      }
      parsed = JSON.parse(jsonStr.trim());
    } catch (e) {}
  }

  return {
    screenshot: filename,
    structure: parsed,
    cost: response.usage?.cost || 0,
    error: response.error
  };
}

async function runTest() {
  console.log('🎓 Vision Teaching Test v2 - Using Existing Scraper');
  console.log('═'.repeat(60));

  if (!isLLMAvailable()) {
    console.log('❌ ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const debugDir = path.join(__dirname, 'debug', 'vision-teaching-v2');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  const results = [];
  let totalCost = 0;

  for (const site of TEST_SITES) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🌐 ${site.name.toUpperCase()}: ${site.url}`);

    const siteResult = {
      site: site.name,
      url: site.url,
      switchersFound: [],
      leaderboards: [],
      cost: 0,
      errors: []
    };

    try {
      const page = await context.newPage();
      const networkData = setupNetworkCapture(page);

      // Navigate
      console.log('   📍 Navigating...');
      await page.goto(site.url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      await dismissPopups(page);

      // Use existing scraper to find switchers
      console.log('   🔍 Finding switchers (using scraper logic)...');
      const switchers = await findSiteSwitchers(page, KEYWORDS);

      const validSwitchers = switchers.filter(s => s.keyword && s.coordinates);
      siteResult.switchersFound = validSwitchers.map(s => s.keyword);

      console.log(`   ✅ Found ${validSwitchers.length} switchers: ${siteResult.switchersFound.join(', ') || 'none'}`);

      // If no switchers, analyze current page
      if (validSwitchers.length === 0) {
        console.log('   📸 No switchers - analyzing current view...');
        const analysis = await analyzeWithVision(page, site.name, 'default', debugDir);
        siteResult.leaderboards.push({
          name: 'default',
          ...analysis
        });
        siteResult.cost += analysis.cost;
        totalCost += analysis.cost;

        if (analysis.structure) {
          console.log(`      Column order: ${analysis.structure.column_order}`);
          console.log(`      Podium layout: ${analysis.structure.podium_layout}`);
        }
      }

      // Analyze each switcher (limit to 3 for cost)
      const switchersToAnalyze = validSwitchers.slice(0, 3);

      for (let i = 0; i < switchersToAnalyze.length; i++) {
        const switcher = switchersToAnalyze[i];
        console.log(`\n   ── ${switcher.keyword} ──`);

        // Click the switcher
        if (i > 0) { // First one is usually already active
          console.log(`   🖱️ Clicking ${switcher.keyword}...`);
          clearNetworkData(networkData);
          const clicked = await clickSwitcher(page, switcher.keyword, switcher);

          if (!clicked) {
            console.log(`   ⚠️ Could not click`);
            siteResult.leaderboards.push({
              name: switcher.keyword,
              error: 'Click failed'
            });
            continue;
          }

          await dismissPopups(page);
        }

        // Scroll down a bit to ensure content is loaded
        await page.evaluate(() => window.scrollBy(0, 300));
        await page.waitForTimeout(1000);

        // Analyze structure with Vision
        console.log(`   📸 Analyzing structure...`);
        const analysis = await analyzeWithVision(page, site.name, switcher.keyword, debugDir);

        siteResult.leaderboards.push({
          name: switcher.keyword,
          ...analysis
        });
        siteResult.cost += analysis.cost;
        totalCost += analysis.cost;

        if (analysis.structure) {
          console.log(`      ✅ Column order: ${analysis.structure.column_order}`);
          console.log(`      ✅ Podium layout: ${analysis.structure.podium_layout}`);
          console.log(`      ✅ Format: ${analysis.structure.entry_format}`);
          console.log(`      ✅ Wager label: ${analysis.structure.wager_label || 'none'}`);
          console.log(`      ✅ Prize label: ${analysis.structure.prize_label || 'none'}`);
          if (analysis.structure.has_scrollable_container) {
            console.log(`      ⚠️ Has scrollable container (needs scroll to see all)`);
          }
        } else {
          console.log(`      ❌ Analysis failed`);
        }
      }

      await page.close();

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      siteResult.errors.push(error.message);
    }

    results.push(siteResult);
    console.log(`\n   💰 Site cost: $${siteResult.cost.toFixed(4)}`);
  }

  await browser.close();

  // Generate report
  console.log('\n' + '═'.repeat(60));
  console.log('📊 GENERATING REPORT');

  const reportPath = generateReport(results, debugDir, totalCost);
  const jsonPath = path.join(debugDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  console.log(`\n✅ Complete!`);
  console.log(`📄 Report: ${reportPath}`);
  console.log(`💾 JSON: ${jsonPath}`);
  console.log(`💰 Total: $${totalCost.toFixed(4)}`);
  console.log(`\n   open "${reportPath}"`);
}

function generateReport(results, debugDir, totalCost) {
  const totalLBs = results.reduce((sum, r) => sum + r.leaderboards.length, 0);
  const successfulLBs = results.reduce((sum, r) => sum + r.leaderboards.filter(lb => lb.structure).length, 0);

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Vision Teaching v2 Results</title>
  <style>
    body { font-family: system-ui; margin: 20px; background: #0a0a15; color: #e0e0e0; }
    h1 { color: #00d4ff; }
    .summary { background: #1a1a2e; padding: 20px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #00d4ff; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-top: 15px; }
    .stat { text-align: center; background: #0a0a15; padding: 15px; border-radius: 8px; }
    .stat-value { font-size: 2em; color: #00ff88; font-weight: bold; }
    .stat-label { color: #888; }

    .site { background: #1a1a2e; margin: 15px 0; border-radius: 10px; overflow: hidden; }
    .site-header { background: #0f3460; padding: 15px; }
    .site-name { font-size: 1.3em; color: #00d4ff; margin: 0; }
    .site-meta { color: #888; font-size: 0.9em; margin-top: 5px; }
    .site-body { padding: 15px; }

    .lb { background: #0a0a15; padding: 15px; margin: 10px 0; border-radius: 8px; border-left: 3px solid #00d4ff; }
    .lb-name { color: #fff; font-weight: bold; margin-bottom: 10px; }
    .lb-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 10px 0; }
    .lb-item { background: #1a1a2e; padding: 10px; border-radius: 5px; }
    .lb-label { color: #888; font-size: 0.8em; }
    .lb-value { color: #00ff88; font-weight: bold; }

    .screenshot { max-width: 100%; max-height: 400px; border: 1px solid #333; border-radius: 5px; margin-top: 10px; cursor: pointer; }
    .error { color: #ff4444; }
    .warning { color: #ffaa00; }

    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 1000; align-items: center; justify-content: center; }
    .modal.active { display: flex; }
    .modal img { max-width: 95%; max-height: 95%; }
    .modal-close { position: absolute; top: 20px; right: 30px; color: #fff; font-size: 40px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>🎓 Vision Teaching v2 - Structure Analysis</h1>

  <div class="summary">
    <h2 style="margin-top: 0; color: #00d4ff;">Summary</h2>
    <div class="summary-grid">
      <div class="stat">
        <div class="stat-value">${results.length}</div>
        <div class="stat-label">Sites</div>
      </div>
      <div class="stat">
        <div class="stat-value">${successfulLBs}/${totalLBs}</div>
        <div class="stat-label">LBs Analyzed</div>
      </div>
      <div class="stat">
        <div class="stat-value">${results.reduce((sum, r) => sum + r.switchersFound.length, 0)}</div>
        <div class="stat-label">Switchers Found</div>
      </div>
      <div class="stat">
        <div class="stat-value">$${totalCost.toFixed(4)}</div>
        <div class="stat-label">Total Cost</div>
      </div>
    </div>
  </div>

  ${results.map(site => `
  <div class="site">
    <div class="site-header">
      <h3 class="site-name">${site.errors.length ? '⚠️' : '✅'} ${site.site}</h3>
      <div class="site-meta">
        ${site.url} | Switchers: ${site.switchersFound.join(', ') || 'none'} | Cost: $${site.cost.toFixed(4)}
      </div>
    </div>
    <div class="site-body">
      ${site.errors.length ? `<p class="error">Errors: ${site.errors.join(', ')}</p>` : ''}

      ${site.leaderboards.map(lb => `
      <div class="lb">
        <div class="lb-name">${lb.error ? '❌' : '✅'} ${lb.name}</div>
        ${lb.error ? `<p class="error">${lb.error}</p>` : lb.structure ? `
        <div class="lb-grid">
          <div class="lb-item">
            <div class="lb-label">Column Order</div>
            <div class="lb-value">${lb.structure.column_order}</div>
          </div>
          <div class="lb-item">
            <div class="lb-label">Podium Layout</div>
            <div class="lb-value">${lb.structure.podium_layout}</div>
          </div>
          <div class="lb-item">
            <div class="lb-label">Format</div>
            <div class="lb-value">${lb.structure.entry_format}</div>
          </div>
          <div class="lb-item">
            <div class="lb-label">Wager Label</div>
            <div class="lb-value">${lb.structure.wager_label || 'none'}</div>
          </div>
          <div class="lb-item">
            <div class="lb-label">Prize Label</div>
            <div class="lb-value">${lb.structure.prize_label || 'none'}</div>
          </div>
          <div class="lb-item">
            <div class="lb-label">Scrollable?</div>
            <div class="lb-value ${lb.structure.has_scrollable_container ? 'warning' : ''}">${lb.structure.has_scrollable_container ? 'Yes ⚠️' : 'No'}</div>
          </div>
        </div>
        ${lb.structure.notes ? `<p style="color: #888; font-style: italic;">Notes: ${lb.structure.notes}</p>` : ''}
        ` : '<p class="error">No structure data</p>'}
        ${lb.screenshot ? `<img class="screenshot" src="${lb.screenshot}" onclick="openModal(this.src)" />` : ''}
      </div>
      `).join('')}
    </div>
  </div>
  `).join('')}

  <div class="modal" id="modal" onclick="closeModal()">
    <span class="modal-close">&times;</span>
    <img id="modal-img" />
  </div>

  <script>
    function openModal(src) { document.getElementById('modal-img').src = src; document.getElementById('modal').classList.add('active'); }
    function closeModal() { document.getElementById('modal').classList.remove('active'); }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  </script>
</body>
</html>`;

  const reportPath = path.join(debugDir, 'report.html');
  fs.writeFileSync(reportPath, html);
  return reportPath;
}

runTest().catch(console.error);
