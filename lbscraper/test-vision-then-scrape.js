/**
 * Vision Teaching → Scraper Validation Test
 *
 * 1. Vision analyzes 10 NEW sites and learns config
 * 2. Normal scraper runs on same sites
 * 3. Compare: Did scraper apply the learned config correctly?
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Existing scraper modules
const { findSiteSwitchers } = require('./shared/site-detection');
const { setupNetworkCapture, clearNetworkData } = require('./shared/network-capture');
const { scrapePageData } = require('./core/page-scraper');
const { extractLeaderboardData } = require('./core/data-extractor');
const { callClaude, isLLMAvailable } = require('./shared/teacher/llm-client');
const { log } = require('./shared/utils');

// Load keywords
const keywordsPath = path.join(__dirname, 'keywords.txt');
const KEYWORDS = fs.existsSync(keywordsPath)
  ? fs.readFileSync(keywordsPath, 'utf8').split('\n').map(k => k.trim().toLowerCase()).filter(k => k && !k.startsWith('#'))
  : [];

// 4 REFERENCE sites for regression testing
const TEST_SITES = [
  { url: 'https://paxgambles.com/leaderboard', name: 'paxgambles' },
  { url: 'https://devlrewards.com/leaderboard', name: 'devlrewards' },
  { url: 'https://goatgambles.com/leaderboard', name: 'goatgambles' },
  { url: 'https://wrewards.com/leaderboards', name: 'wrewards' },
];

// Vision prompt for structure analysis
const STRUCTURE_PROMPT = `Analyze this gambling leaderboard screenshot.

Determine the STRUCTURE (not extract all data):

1. **Column Order**:
   - "prize_before_wager" = Prize/Reward column shown BEFORE Wagered/Wager
   - "wager_before_prize" = Wagered/Wager column shown BEFORE Prize/Reward
   - "wager_only" = Only wager shown, no prize column

2. **Podium Layout** (Top 3):
   - "center_first" = #1 in CENTER (larger), #2 left, #3 right
   - "left_to_right" = #1, #2, #3 from left to right
   - "no_podium" = No special top 3 display

3. **Sample Entry**: Extract rank #1's data as validation

Return ONLY JSON:
{
  "column_order": "prize_before_wager" | "wager_before_prize" | "wager_only",
  "podium_layout": "center_first" | "left_to_right" | "no_podium",
  "wager_label": "Wagered",
  "prize_label": "Prize",
  "rank1_username": "PlayerName",
  "rank1_wager": 50000,
  "rank1_prize": 5000,
  "confidence": 95
}`;

// Store learned configs
const learnedConfigs = {};

async function dismissPopups(page) {
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await page.waitForTimeout(300);
}

async function visionAnalyze(page, siteName, lbName, debugDir) {
  const filename = `${siteName}-${lbName}-${Date.now()}.png`;
  const filepath = path.join(debugDir, filename);

  await page.screenshot({ path: filepath, fullPage: false });

  const imageData = fs.readFileSync(filepath);
  const base64 = imageData.toString('base64');

  const response = await callClaude({
    systemPrompt: STRUCTURE_PROMPT,
    userMessage: 'Analyze this leaderboard.',
    basePath: __dirname,
    domain: `${siteName}-${lbName}`,
    imageBase64: base64,
    maxTokens: 500
  });

  let parsed = null;
  if (response.success && response.content) {
    try {
      let json = response.content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      parsed = JSON.parse(json.trim());
    } catch (e) {}
  }

  return { screenshot: filename, config: parsed, cost: response.usage?.cost || 0 };
}

async function runScraperWithConfig(page, networkData, siteName, lbName, config) {
  // Scrape the page
  const pageData = await scrapePageData({
    page,
    url: page.url(),
    networkData,
    config: { takeScreenshot: false, scrollPage: true, waitForContent: 2000 }
  });

  // Extract with the learned config hint
  const extraction = await extractLeaderboardData({
    ...pageData,
    page,
    siteName: lbName,
    config: {
      // Pass learned config as hints
      prizeBeforeWager: config?.column_order === 'prize_before_wager',
      podiumLayout: config?.podium_layout,
      // Pass Vision's expected rank #1 for validation
      // The fusion layer can use this to validate which strategy is correct
      expectedRank1: config ? {
        username: config.rank1_username,
        wager: config.rank1_wager,
        prize: config.rank1_prize
      } : null
    }
  });

  return extraction;
}

async function runTest() {
  console.log('🧪 Vision Teaching → Scraper Validation Test');
  console.log('═'.repeat(70));

  if (!isLLMAvailable()) {
    console.log('❌ ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const debugDir = path.join(__dirname, 'debug', 'vision-scrape-test');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  const results = [];
  let totalCost = 0;

  for (const site of TEST_SITES) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`🌐 ${site.name.toUpperCase()}: ${site.url}`);

    const siteResult = {
      site: site.name,
      url: site.url,
      leaderboards: [],
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

      // Find switchers
      console.log('   🔍 Finding leaderboards...');
      const switchers = await findSiteSwitchers(page, KEYWORDS);
      const validSwitchers = switchers.filter(s => s.keyword && s.coordinates);

      // If no switchers, use default - analyze ALL leaderboards
      const toAnalyze = validSwitchers.length > 0
        ? validSwitchers.map(s => s.keyword)
        : ['default'];

      console.log(`   📋 Analyzing: ${toAnalyze.join(', ')}`);

      for (let i = 0; i < toAnalyze.length; i++) {
        const lbName = toAnalyze[i];
        console.log(`\n   ── ${lbName} ──`);

        // Click switcher if needed
        if (i > 0 || (lbName !== 'default' && validSwitchers.length > 0)) {
          const switcher = validSwitchers.find(s => s.keyword === lbName);
          if (switcher?.coordinates) {
            clearNetworkData(networkData);
            await page.mouse.click(switcher.coordinates.x, switcher.coordinates.y);
            await page.waitForTimeout(2000);
            await dismissPopups(page);
          }
        }

        // PHASE 1: BEFORE VISION - Scraper extracts WITHOUT config
        console.log('   🔧 BEFORE VISION: Extracting without config...');
        const beforeExtraction = await runScraperWithConfig(page, networkData, site.name, lbName, null);

        let beforeRank1 = null;
        if (beforeExtraction?.entries?.length) {
          beforeRank1 = beforeExtraction.entries.find(e => e.rank === 1) || beforeExtraction.entries[0];
          console.log(`      Before #1: ${beforeRank1.username} - wager: $${beforeRank1.wager?.toLocaleString()}, prize: $${beforeRank1.prize}`);
        } else {
          console.log('      Before: 0 entries');
        }

        // PHASE 2: Vision learns structure
        console.log('   👁️  VISION: Learning structure...');
        const vision = await visionAnalyze(page, site.name, lbName, debugDir);
        totalCost += vision.cost;

        if (!vision.config) {
          console.log('      ❌ Vision failed to analyze');
          siteResult.leaderboards.push({ name: lbName, error: 'Vision failed' });
          continue;
        }

        console.log(`      Column order: ${vision.config.column_order}`);
        console.log(`      Podium: ${vision.config.podium_layout}`);
        console.log(`      Vision #1: ${vision.config.rank1_username} - wager: $${vision.config.rank1_wager?.toLocaleString()}, prize: $${vision.config.rank1_prize}`);

        // Store learned config
        learnedConfigs[`${site.name}-${lbName}`] = vision.config;

        // PHASE 3: AFTER VISION - Scraper extracts WITH learned config
        console.log('   🔧 AFTER VISION: Extracting with learned config...');
        const afterExtraction = await runScraperWithConfig(page, networkData, site.name, lbName, vision.config);

        let afterRank1 = null;
        if (afterExtraction?.entries?.length) {
          afterRank1 = afterExtraction.entries.find(e => e.rank === 1) || afterExtraction.entries[0];
          console.log(`      After #1: ${afterRank1.username} - wager: $${afterRank1.wager?.toLocaleString()}, prize: $${afterRank1.prize}`);
        } else {
          console.log('      After: 0 entries');
        }

        // PHASE 4: Compare BEFORE vs AFTER vs VISION
        console.log('   📊 COMPARING...');

        const visionWager = vision.config.rank1_wager || 0;
        const visionPrize = vision.config.rank1_prize || 0;
        const beforeWager = beforeRank1?.wager || 0;
        const beforePrize = beforeRank1?.prize || 0;
        const afterWager = afterRank1?.wager || 0;
        const afterPrize = afterRank1?.prize || 0;

        // Check if AFTER matches Vision (within 5% tolerance)
        const afterWagerMatch = Math.abs(visionWager - afterWager) / Math.max(visionWager, 1) < 0.05;
        const afterPrizeMatch = Math.abs(visionPrize - afterPrize) / Math.max(visionPrize, 1) < 0.05;

        // Check if BEFORE matched Vision
        const beforeWagerMatch = Math.abs(visionWager - beforeWager) / Math.max(visionWager, 1) < 0.05;
        const beforePrizeMatch = Math.abs(visionPrize - beforePrize) / Math.max(visionPrize, 1) < 0.05;

        // Check if swapped
        const isSwapped = !afterWagerMatch && !afterPrizeMatch &&
          Math.abs(visionWager - afterPrize) / Math.max(visionWager, 1) < 0.05 &&
          Math.abs(visionPrize - afterWager) / Math.max(visionPrize, 1) < 0.05;

        let status;
        let improved = false;

        if (afterWagerMatch && afterPrizeMatch) {
          status = '✅ MATCH';
          // Check if this is an improvement from before
          if (!beforeWagerMatch || !beforePrizeMatch) {
            improved = true;
            console.log(`      ${status} - Vision FIXED the extraction!`);
          } else {
            console.log(`      ${status} - Correct (was already correct before Vision)`);
          }
        } else if (isSwapped) {
          status = '❌ SWAPPED';
          console.log(`      ${status} - Wager/Prize are SWAPPED`);
        } else {
          status = '⚠️ MISMATCH';
          console.log(`      ${status} - Still not matching Vision`);
          console.log(`         Vision:  wager=$${visionWager}, prize=$${visionPrize}`);
          console.log(`         After:   wager=$${afterWager}, prize=$${afterPrize}`);
        }

        siteResult.leaderboards.push({
          name: lbName,
          screenshot: vision.screenshot,
          vision: {
            column_order: vision.config.column_order,
            podium_layout: vision.config.podium_layout,
            rank1: {
              username: vision.config.rank1_username,
              wager: visionWager,
              prize: visionPrize
            }
          },
          before: {
            entries: beforeExtraction?.entries?.length || 0,
            method: beforeExtraction?.extractionMethod || 'none',
            rank1: beforeRank1 ? {
              username: beforeRank1.username,
              wager: beforeWager,
              prize: beforePrize
            } : null,
            matchesVision: beforeWagerMatch && beforePrizeMatch
          },
          after: {
            entries: afterExtraction?.entries?.length || 0,
            method: afterExtraction?.extractionMethod || 'none',
            confidence: afterExtraction?.confidence || 0,
            rank1: afterRank1 ? {
              username: afterRank1.username,
              wager: afterWager,
              prize: afterPrize
            } : null,
            matchesVision: afterWagerMatch && afterPrizeMatch
          },
          comparison: {
            status,
            improved,
            isSwapped
          }
        });
      }

      await page.close();

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      siteResult.errors.push(error.message);
    }

    results.push(siteResult);
  }

  await browser.close();

  // Generate report
  console.log('\n' + '═'.repeat(70));
  console.log('📊 RESULTS SUMMARY');
  console.log('═'.repeat(70));

  let matches = 0, swapped = 0, mismatches = 0, failures = 0;

  for (const site of results) {
    for (const lb of site.leaderboards) {
      if (lb.error) failures++;
      else if (lb.comparison?.status === '✅ MATCH') matches++;
      else if (lb.comparison?.status === '❌ SWAPPED') swapped++;
      else mismatches++;
    }
  }

  const total = matches + swapped + mismatches + failures;
  console.log(`\n✅ MATCH (correct): ${matches}/${total}`);
  console.log(`❌ SWAPPED (wager/prize reversed): ${swapped}/${total}`);
  console.log(`⚠️ MISMATCH (values differ): ${mismatches}/${total}`);
  console.log(`💀 FAILED (no data): ${failures}/${total}`);
  console.log(`💰 Total cost: $${totalCost.toFixed(4)}`);

  // Generate HTML report
  const reportPath = generateReport(results, debugDir, totalCost, { matches, swapped, mismatches, failures });
  const jsonPath = path.join(debugDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  console.log(`\n📄 Report: ${reportPath}`);
  console.log(`   open "${reportPath}"`);
}

function generateReport(results, debugDir, totalCost, stats) {
  // Count improvements
  let improved = 0;
  for (const site of results) {
    for (const lb of site.leaderboards) {
      if (lb.comparison?.improved) improved++;
    }
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Vision Teaching: Before vs After</title>
  <style>
    body { font-family: system-ui; margin: 20px; background: #0a0a15; color: #e0e0e0; }
    h1 { color: #00d4ff; }
    .summary { background: #1a1a2e; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
    .stats { display: flex; gap: 20px; margin-top: 15px; flex-wrap: wrap; }
    .stat { flex: 1; min-width: 100px; text-align: center; padding: 15px; border-radius: 8px; }
    .stat.match { background: #0a3a0a; border: 1px solid #00ff88; }
    .stat.improved { background: #0a2a3a; border: 1px solid #00aaff; }
    .stat.swap { background: #3a0a0a; border: 1px solid #ff4444; }
    .stat.mismatch { background: #3a3a0a; border: 1px solid #ffaa00; }
    .stat.fail { background: #1a1a1a; border: 1px solid #666; }
    .stat-value { font-size: 2em; font-weight: bold; }
    .stat-label { color: #888; margin-top: 5px; }

    .site { background: #1a1a2e; margin: 15px 0; border-radius: 10px; overflow: hidden; }
    .site-header { background: #0f3460; padding: 15px; }
    .site-name { font-size: 1.3em; color: #00d4ff; }
    .site-body { padding: 15px; }

    .lb { background: #0a0a15; padding: 15px; margin: 10px 0; border-radius: 8px; }
    .lb.match { border-left: 4px solid #00ff88; }
    .lb.improved { border-left: 4px solid #00aaff; }
    .lb.swap { border-left: 4px solid #ff4444; }
    .lb.mismatch { border-left: 4px solid #ffaa00; }
    .lb.fail { border-left: 4px solid #666; }

    .lb-header { display: flex; justify-content: space-between; margin-bottom: 15px; align-items: center; }
    .lb-name { font-size: 1.1em; color: #fff; }
    .lb-badges { display: flex; gap: 8px; }
    .lb-status { padding: 5px 12px; border-radius: 15px; font-size: 0.9em; }
    .lb-status.match { background: #0a3a0a; color: #00ff88; }
    .lb-status.improved { background: #0a2a3a; color: #00aaff; }
    .lb-status.swap { background: #3a0a0a; color: #ff4444; }
    .lb-status.mismatch { background: #3a3a0a; color: #ffaa00; }

    .comparison { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; }
    .source { background: #1a1a2e; padding: 15px; border-radius: 8px; }
    .source.vision { border: 2px solid #00d4ff; }
    .source.before { border: 2px solid #666; }
    .source.after { border: 2px solid #00ff88; }
    .source.after.wrong { border: 2px solid #ffaa00; }
    .source-title { margin-bottom: 10px; font-weight: bold; font-size: 0.95em; }
    .source-title.vision { color: #00d4ff; }
    .source-title.before { color: #888; }
    .source-title.after { color: #00ff88; }
    .source-title.after.wrong { color: #ffaa00; }
    .data-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #333; font-size: 0.9em; }
    .data-label { color: #888; }
    .data-value { color: #fff; }
    .data-value.match { color: #00ff88; }
    .data-value.mismatch { color: #ff4444; }

    .screenshot { max-width: 100%; max-height: 250px; border: 1px solid #333; border-radius: 5px; margin-top: 15px; }

    .improvement-banner { margin-top: 15px; padding: 12px; border-radius: 5px; font-weight: bold; }
    .improvement-banner.fixed { background: #0a2a3a; color: #00aaff; }
    .improvement-banner.already-correct { background: #0a3a0a; color: #00ff88; }
    .improvement-banner.still-wrong { background: #3a3a0a; color: #ffaa00; }
  </style>
</head>
<body>
  <h1>🧪 Vision Teaching: Before vs After Comparison</h1>

  <div class="summary">
    <h2 style="margin: 0; color: #00d4ff;">Did Vision teaching help the scraper?</h2>
    <div class="stats">
      <div class="stat match">
        <div class="stat-value">${stats.matches}</div>
        <div class="stat-label">✅ Correct</div>
      </div>
      <div class="stat improved">
        <div class="stat-value">${improved}</div>
        <div class="stat-label">🔧 Fixed by Vision</div>
      </div>
      <div class="stat mismatch">
        <div class="stat-value">${stats.mismatches}</div>
        <div class="stat-label">⚠️ Still Wrong</div>
      </div>
      <div class="stat fail">
        <div class="stat-value">${stats.failures}</div>
        <div class="stat-label">💀 Failed</div>
      </div>
    </div>
    <p style="margin-top: 15px; color: #888;">Total cost: \$${totalCost.toFixed(4)}</p>
  </div>

  ${results.map(site => `
  <div class="site">
    <div class="site-header">
      <div class="site-name">${site.site}</div>
      <div style="color: #888; font-size: 0.9em;">${site.url}</div>
    </div>
    <div class="site-body">
      ${site.errors.length ? `<p style="color: #ff4444;">Error: ${site.errors.join(', ')}</p>` : ''}

      ${site.leaderboards.map(lb => {
        const statusClass = lb.error ? 'fail' : lb.comparison?.improved ? 'improved' : lb.after?.matchesVision ? 'match' : 'mismatch';
        return `
      <div class="lb ${statusClass}">
        <div class="lb-header">
          <div class="lb-name">${lb.name}</div>
          <div class="lb-badges">
            ${lb.comparison?.improved ? '<span class="lb-status improved">🔧 FIXED</span>' : ''}
            <span class="lb-status ${statusClass}">
              ${lb.error ? '💀 Failed' : lb.comparison?.status || '?'}
            </span>
          </div>
        </div>

        ${lb.error ? `<p style="color: #888;">${lb.error}</p>` : `
        <div class="comparison">
          <!-- Vision (Ground Truth) -->
          <div class="source vision">
            <div class="source-title vision">👁️ Vision (Ground Truth)</div>
            <div class="data-row">
              <span class="data-label">Podium</span>
              <span class="data-value">${lb.vision?.podium_layout || '?'}</span>
            </div>
            <div class="data-row">
              <span class="data-label">Columns</span>
              <span class="data-value">${lb.vision?.column_order || '?'}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 User</span>
              <span class="data-value">${lb.vision?.rank1?.username || '?'}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 Wager</span>
              <span class="data-value">\$${(lb.vision?.rank1?.wager || 0).toLocaleString()}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 Prize</span>
              <span class="data-value">\$${(lb.vision?.rank1?.prize || 0).toLocaleString()}</span>
            </div>
          </div>

          <!-- BEFORE Vision -->
          <div class="source before">
            <div class="source-title before">⬅️ BEFORE Vision</div>
            <div class="data-row">
              <span class="data-label">Entries</span>
              <span class="data-value">${lb.before?.entries || 0}</span>
            </div>
            <div class="data-row">
              <span class="data-label">Method</span>
              <span class="data-value">${lb.before?.method || 'none'}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 User</span>
              <span class="data-value">${lb.before?.rank1?.username || '?'}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 Wager</span>
              <span class="data-value ${lb.before?.matchesVision ? 'match' : 'mismatch'}">\$${(lb.before?.rank1?.wager || 0).toLocaleString()}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 Prize</span>
              <span class="data-value ${lb.before?.matchesVision ? 'match' : 'mismatch'}">\$${(lb.before?.rank1?.prize || 0).toLocaleString()}</span>
            </div>
          </div>

          <!-- AFTER Vision -->
          <div class="source after ${lb.after?.matchesVision ? '' : 'wrong'}">
            <div class="source-title after ${lb.after?.matchesVision ? '' : 'wrong'}">➡️ AFTER Vision</div>
            <div class="data-row">
              <span class="data-label">Entries</span>
              <span class="data-value">${lb.after?.entries || 0}</span>
            </div>
            <div class="data-row">
              <span class="data-label">Method</span>
              <span class="data-value">${lb.after?.method || 'none'}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 User</span>
              <span class="data-value">${lb.after?.rank1?.username || '?'}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 Wager</span>
              <span class="data-value ${lb.after?.matchesVision ? 'match' : 'mismatch'}">\$${(lb.after?.rank1?.wager || 0).toLocaleString()}</span>
            </div>
            <div class="data-row">
              <span class="data-label">#1 Prize</span>
              <span class="data-value ${lb.after?.matchesVision ? 'match' : 'mismatch'}">\$${(lb.after?.rank1?.prize || 0).toLocaleString()}</span>
            </div>
          </div>
        </div>

        ${lb.comparison?.improved ? `
        <div class="improvement-banner fixed">
          🔧 Vision FIXED this! Before: wrong rank #1. After: correct rank #1.
        </div>
        ` : lb.after?.matchesVision && lb.before?.matchesVision ? `
        <div class="improvement-banner already-correct">
          ✅ Already correct before Vision (no change needed)
        </div>
        ` : lb.after?.matchesVision ? `
        <div class="improvement-banner already-correct">
          ✅ Correct after Vision
        </div>
        ` : `
        <div class="improvement-banner still-wrong">
          ⚠️ Still not matching Vision - may need further investigation
        </div>
        `}
        `}

        ${lb.screenshot ? `<img class="screenshot" src="${lb.screenshot}" />` : ''}
      </div>
      `;}).join('')}
    </div>
  </div>
  `).join('')}
</body>
</html>`;

  const reportPath = path.join(debugDir, 'report.html');
  fs.writeFileSync(reportPath, html);
  return reportPath;
}

runTest().catch(console.error);
