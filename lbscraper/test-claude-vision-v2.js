/**
 * Claude Vision OCR Test v2
 *
 * Improved test with:
 * - Full page screenshots
 * - Popup/modal dismissal
 * - Direct URL navigation
 * - Detailed HTML report for review
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { callClaude, isLLMAvailable } = require('./shared/teacher/llm-client');

// Test sites with direct leaderboard URLs
const TEST_SITES = [
  { url: 'https://spencerrewards.com/leaderboard/chips', name: 'spencerrewards-chips' },
  { url: 'https://spencerrewards.com/leaderboard/packdraw', name: 'spencerrewards-packdraw' },
  { url: 'https://goatgambles.com/leaderboard/csgogem', name: 'goatgambles-csgogem' },
  { url: 'https://paxgambles.com/leaderboard', name: 'paxgambles' },
  { url: 'https://www.tanskidegen.com/leaderboards', name: 'tanskidegen' },
  { url: 'https://ravengambles.com/leaderboard', name: 'ravengambles' },
  { url: 'https://wahy.gg/leaderboard/csgogem', name: 'wahy-csgogem' },
  { url: 'https://adukes.com/leaderboard/chips', name: 'adukes-chips' },
  { url: 'https://rwrds.gg/leaderboard/upgrader', name: 'rwrds-upgrader' },
  { url: 'https://www.ilovemav.com/leaderboards', name: 'ilovemav' },
];

const EXTRACTION_PROMPT = `You are an expert at extracting leaderboard data from gambling affiliate websites.

Analyze this FULL PAGE screenshot and extract ALL visible leaderboard entries.

For EACH entry you can see, extract:
- rank: The position number (1, 2, 3, etc.)
- username: The player's name (may be partially masked with asterisks like "Joh***")
- wager: The amount wagered/bet (look for "Wagered:", "$X,XXX", or large numbers)
- prize: The reward/prize amount (look for "Prize:", "Reward:", smaller $ amounts, or 0 if not shown)

IMPORTANT:
- Extract ALL entries visible on the page, not just the top few
- The TOP 3 (podium) are often displayed differently - larger cards, different layout
- Ranks 4+ are usually in a list/table format below
- Look for column headers like "Place", "User", "Wagered", "Prize", "Reward" to understand column order
- If "Reward" or "Prize" column comes BEFORE "Wagered" column, note this as "prize_before_wager"
- Scroll down mentally - there may be entries at the bottom of the screenshot

Return ONLY valid JSON (no markdown, no explanation):
{
  "entries": [
    {"rank": 1, "username": "PlayerName", "wager": 12345.67, "prize": 500},
    {"rank": 2, "username": "Ano***r", "wager": 9876.54, "prize": 300}
  ],
  "structure": {
    "column_order": "prize_before_wager" or "wager_before_prize" or "unknown",
    "has_podium": true,
    "podium_count": 3,
    "list_entries_visible": 7,
    "total_entries_found": 10
  },
  "confidence": 85,
  "notes": "Any issues or observations"
}`;

async function dismissPopups(page) {
  // Try to close common popups/modals
  const closeSelectors = [
    '[class*="close"]',
    '[class*="Close"]',
    '[aria-label="Close"]',
    'button:has-text("Close")',
    'button:has-text("×")',
    '[class*="modal"] button',
    '[class*="overlay"] button',
  ];

  for (const sel of closeSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click();
        await page.waitForTimeout(500);
      }
    } catch (e) {
      // Ignore
    }
  }

  // Press Escape to close any modal
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch (e) {}
}

async function captureFullPage(page, siteName, debugDir) {
  const screenshotPath = path.join(debugDir, `vision-v2-${siteName}.png`);

  // Scroll to load all content
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0); // Scroll back to top
          resolve();
        }
      }, 100);
    });
  });

  await page.waitForTimeout(500);

  // Take full page screenshot
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    timeout: 30000
  });

  return screenshotPath;
}

async function analyzeWithVision(screenshotPath, siteName, basePath) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64Image = imageData.toString('base64');

  // Check file size - Claude has limits
  const fileSizeMB = imageData.length / (1024 * 1024);
  console.log(`   📁 Screenshot size: ${fileSizeMB.toFixed(2)}MB`);

  if (fileSizeMB > 20) {
    return { success: false, error: 'Screenshot too large (>20MB)' };
  }

  const startTime = Date.now();

  const response = await callClaude({
    systemPrompt: EXTRACTION_PROMPT,
    userMessage: 'Extract ALL leaderboard entries from this full page screenshot. Look carefully at the entire image.',
    basePath,
    domain: siteName,
    imageBase64: base64Image,
    maxTokens: 4000
  });

  const elapsed = Date.now() - startTime;

  return {
    response: response.content,
    elapsed,
    usage: response.usage,
    success: response.success,
    error: response.error
  };
}

function generateHTMLReport(results, debugDir) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Claude Vision OCR Test Results</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4ff; }
    .site { background: #16213e; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .site-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
    .site-name { font-size: 1.5em; color: #00d4ff; }
    .stats { display: flex; gap: 20px; }
    .stat { background: #0f3460; padding: 8px 15px; border-radius: 5px; }
    .stat-label { color: #888; font-size: 0.8em; }
    .stat-value { font-size: 1.2em; font-weight: bold; }
    .success { color: #00ff88; }
    .error { color: #ff4444; }
    .screenshot { max-width: 100%; border: 1px solid #333; border-radius: 5px; margin: 10px 0; }
    .screenshot-container { max-height: 600px; overflow-y: auto; border: 1px solid #333; border-radius: 5px; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #0f3460; }
    tr:hover { background: #1f3a60; }
    .notes { background: #0f3460; padding: 10px; border-radius: 5px; font-style: italic; color: #aaa; }
    .summary { background: #00d4ff22; border: 1px solid #00d4ff; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
    .summary h2 { margin-top: 0; color: #00d4ff; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
    .summary-item { text-align: center; }
    .summary-value { font-size: 2em; font-weight: bold; }
    .summary-label { color: #888; }
  </style>
</head>
<body>
  <h1>🔍 Claude Vision OCR Test Results</h1>
  <p>Generated: ${new Date().toISOString()}</p>

  <div class="summary">
    <h2>📊 Summary</h2>
    <div class="summary-grid">
      <div class="summary-item">
        <div class="summary-value">${results.filter(r => r.success).length}/${results.length}</div>
        <div class="summary-label">Sites Successful</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${results.reduce((sum, r) => sum + (r.entries || 0), 0)}</div>
        <div class="summary-label">Total Entries</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${(results.reduce((sum, r) => sum + (r.elapsed || 0), 0) / 1000).toFixed(1)}s</div>
        <div class="summary-label">Total Time</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">$${results.reduce((sum, r) => sum + (r.cost || 0), 0).toFixed(4)}</div>
        <div class="summary-label">Total Cost</div>
      </div>
    </div>
  </div>

  ${results.map(r => `
  <div class="site">
    <div class="site-header">
      <div class="site-name">${r.success ? '✅' : '❌'} ${r.site}</div>
      <div class="stats">
        <div class="stat">
          <div class="stat-label">Entries</div>
          <div class="stat-value">${r.entries || 0}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Confidence</div>
          <div class="stat-value">${r.confidence || 0}%</div>
        </div>
        <div class="stat">
          <div class="stat-label">Time</div>
          <div class="stat-value">${((r.elapsed || 0) / 1000).toFixed(1)}s</div>
        </div>
        <div class="stat">
          <div class="stat-label">Cost</div>
          <div class="stat-value">$${(r.cost || 0).toFixed(4)}</div>
        </div>
      </div>
    </div>

    <p><strong>URL:</strong> <a href="${r.url}" style="color: #00d4ff;">${r.url}</a></p>

    ${r.structure ? `
    <p><strong>Structure:</strong> Column order: ${r.structure.column_order || 'unknown'},
       Podium: ${r.structure.has_podium ? 'Yes' : 'No'} (${r.structure.podium_count || 0}),
       List entries: ${r.structure.list_entries_visible || 0}</p>
    ` : ''}

    ${r.error ? `<p class="error"><strong>Error:</strong> ${r.error}</p>` : ''}

    ${r.notes ? `<div class="notes"><strong>Notes:</strong> ${r.notes}</div>` : ''}

    ${r.sampleEntries && r.sampleEntries.length > 0 ? `
    <h4>Extracted Entries (${r.entries} total)</h4>
    <table>
      <tr><th>Rank</th><th>Username</th><th>Wager</th><th>Prize</th></tr>
      ${r.sampleEntries.map(e => `
      <tr>
        <td>#${e.rank}</td>
        <td>${e.username}</td>
        <td>$${(e.wager || 0).toLocaleString()}</td>
        <td>$${(e.prize || 0).toLocaleString()}</td>
      </tr>
      `).join('')}
    </table>
    ` : ''}

    <h4>Screenshot</h4>
    <div class="screenshot-container">
      <img class="screenshot" src="vision-v2-${r.site}.png" alt="${r.site} screenshot" />
    </div>
  </div>
  `).join('')}

</body>
</html>`;

  const reportPath = path.join(debugDir, 'vision-test-report.html');
  fs.writeFileSync(reportPath, html);
  return reportPath;
}

async function runTest() {
  console.log('🚀 Claude Vision OCR Test v2 - Full Page Analysis');
  console.log('=' .repeat(60));

  if (!isLLMAvailable()) {
    console.log('❌ LLM not available. Set ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  const debugDir = path.join(__dirname, 'debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const results = [];

  for (const site of TEST_SITES) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📸 ${site.name}`);
    console.log(`   URL: ${site.url}`);

    try {
      const page = await context.newPage();

      // Navigate
      await page.goto(site.url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);

      // Dismiss any popups
      await dismissPopups(page);
      await page.waitForTimeout(1000);

      // Capture full page
      const screenshotPath = await captureFullPage(page, site.name, debugDir);
      console.log(`   ✅ Screenshot saved`);

      // Analyze
      console.log(`   🔍 Analyzing with Claude Vision...`);
      const analysis = await analyzeWithVision(screenshotPath, site.name, __dirname);

      if (!analysis.success) {
        console.log(`   ❌ Error: ${analysis.error}`);
        results.push({
          site: site.name,
          url: site.url,
          success: false,
          error: analysis.error
        });
        await page.close();
        continue;
      }

      console.log(`   ⏱️  ${(analysis.elapsed / 1000).toFixed(1)}s`);

      // Parse
      let parsed = null;
      try {
        let jsonStr = analysis.response || '';
        if (jsonStr.includes('```')) {
          jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        }
        parsed = JSON.parse(jsonStr.trim());
      } catch (e) {
        console.log(`   ⚠️  JSON parse error`);
      }

      const result = {
        site: site.name,
        url: site.url,
        success: parsed !== null,
        entries: parsed?.entries?.length || 0,
        structure: parsed?.structure || null,
        confidence: parsed?.confidence || 0,
        elapsed: analysis.elapsed,
        cost: analysis.usage?.cost || 0,
        sampleEntries: parsed?.entries || [],
        notes: parsed?.notes || null
      };

      results.push(result);

      console.log(`   📊 ${result.entries} entries extracted`);
      console.log(`   💯 ${result.confidence}% confidence`);
      console.log(`   💰 $${result.cost?.toFixed(4) || '0'}`);

      if (parsed?.structure) {
        console.log(`   📐 Column order: ${parsed.structure.column_order}`);
      }

      await page.close();

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      results.push({
        site: site.name,
        url: site.url,
        success: false,
        error: error.message
      });
    }
  }

  await browser.close();

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 FINAL SUMMARY');
  console.log('═'.repeat(60));

  const successful = results.filter(r => r.success);
  console.log(`\n✅ Successful: ${successful.length}/${results.length}`);
  console.log(`📝 Total entries: ${results.reduce((sum, r) => sum + (r.entries || 0), 0)}`);
  console.log(`⏱️  Total time: ${(results.reduce((sum, r) => sum + (r.elapsed || 0), 0) / 1000).toFixed(1)}s`);
  console.log(`💰 Total cost: $${results.reduce((sum, r) => sum + (r.cost || 0), 0).toFixed(4)}`);

  // Generate HTML report
  const reportPath = generateHTMLReport(results, debugDir);
  console.log(`\n📄 HTML Report: ${reportPath}`);

  // Save JSON
  const jsonPath = path.join(debugDir, 'vision-test-results-v2.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`💾 JSON Results: ${jsonPath}`);

  console.log(`\n🌐 Open the HTML report to view screenshots and results:`);
  console.log(`   open "${reportPath}"`);
}

runTest().catch(console.error);
