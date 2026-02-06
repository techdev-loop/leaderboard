/**
 * Vision Teaching - 50 Sites
 *
 * Runs Vision teaching on 50 unique sites from websites.txt
 * Saves learned configs to site profiles for the normal scraper to use
 */

// Load .env from parent directory
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Existing scraper modules
const { findSiteSwitchers } = require('./shared/site-detection');
const { setupNetworkCapture, clearNetworkData } = require('./shared/network-capture');
const { scrapePageData } = require('./core/page-scraper');
const { extractLeaderboardData } = require('./core/data-extractor');
const { callClaude, isLLMAvailable } = require('./shared/teacher/llm-client');
const { saveLeaderboardConfig, getLeaderboardConfig } = require('./shared/learned-patterns');
const { log } = require('./shared/utils');

// Base path for configs
const BASE_PATH = __dirname;

// Load keywords
const keywordsPath = path.join(__dirname, 'keywords.txt');
const KEYWORDS = fs.existsSync(keywordsPath)
  ? fs.readFileSync(keywordsPath, 'utf8').split('\n').map(k => k.trim().toLowerCase()).filter(k => k && !k.startsWith('#'))
  : [];

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

/**
 * Load unique sites from websites.txt (dedupe by domain)
 */
function loadUniqueSites(limit = 50) {
  const websitesPath = path.join(__dirname, 'websites.txt');
  const lines = fs.readFileSync(websitesPath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));

  const seenDomains = new Set();
  const sites = [];

  for (const line of lines) {
    try {
      const url = line.trim();
      if (!url.includes('leaderboard')) continue;

      // Skip historical/previous URLs
      if (url.includes('/previous') || url.includes('/prev-')) continue;

      // Skip specific leaderboard URLs (prefer base /leaderboard)
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      const domain = urlObj.hostname.replace('www.', '');

      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);

      // Use the base leaderboard URL
      const baseUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname.split('/').slice(0, 3).join('/')}`;

      sites.push({
        url: baseUrl.endsWith('/leaderboard') || baseUrl.endsWith('/leaderboards')
          ? baseUrl
          : `${urlObj.protocol}//${urlObj.hostname}/leaderboard`,
        domain,
        name: domain.split('.')[0]
      });

      if (sites.length >= limit) break;
    } catch (e) {
      // Skip invalid URLs
    }
  }

  console.log(`Loaded ${sites.length} unique sites from websites.txt`);
  return sites;
}

async function dismissPopups(page) {
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await page.waitForTimeout(300);
}

async function visionAnalyze(page, siteName, lbName, debugDir) {
  const filename = `${siteName}-${lbName}-${Date.now()}.png`;
  const filepath = path.join(debugDir, filename);

  await page.screenshot({ path: filepath, fullPage: false });
  const imageBuffer = fs.readFileSync(filepath);
  const base64 = imageBuffer.toString('base64');

  // callClaude expects an options object with { systemPrompt, userMessage, basePath, imageBase64 }
  const response = await callClaude({
    systemPrompt: 'You are an expert at analyzing gambling leaderboard screenshots. Return only valid JSON.',
    userMessage: STRUCTURE_PROMPT,
    basePath: BASE_PATH,
    domain: siteName,
    imageBase64: base64
  });

  // Check if call succeeded
  if (!response.success || !response.content) {
    log('VISION', `Vision call failed: ${response.error || 'no content'}`);
    return { config: null, cost: response.usage?.cost || 0, screenshot: filename };
  }

  // Parse JSON from response content
  const jsonMatch = response.content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { config: null, cost: response.usage?.cost || 0, screenshot: filename };
  }

  try {
    const config = JSON.parse(jsonMatch[0]);
    return { config, cost: response.usage?.cost || 0, screenshot: filename };
  } catch (e) {
    return { config: null, cost: response.usage?.cost || 0, screenshot: filename };
  }
}

async function runScraperWithConfig(page, networkData, siteName, lbName, config) {
  const pageData = await scrapePageData({
    page,
    url: page.url(),
    networkData,
    config: { takeScreenshot: false, scrollPage: true, waitForContent: 2000 }
  });

  const extraction = await extractLeaderboardData({
    ...pageData,
    page,
    siteName: lbName,
    config: {
      prizeBeforeWager: config?.column_order === 'prize_before_wager',
      podiumLayout: config?.podium_layout,
      expectedRank1: config ? {
        username: config.rank1_username,
        wager: config.rank1_wager,
        prize: config.rank1_prize
      } : null
    }
  });

  return extraction;
}

/**
 * Save Vision config to site profile
 */
function saveVisionConfig(domain, leaderboardName, visionConfig, extractionResult) {
  const config = {
    navigation: {
      url: null,
      method: 'vision-learned'
    },
    extraction: {
      method: extractionResult?.extractionMethod || 'unknown',
      layoutType: visionConfig.podium_layout === 'no_podium' ? 'table-only' : 'podium-plus-table',
      visionConfig: {
        column_order: visionConfig.column_order,
        podium_layout: visionConfig.podium_layout,
        wager_label: visionConfig.wager_label,
        prize_label: visionConfig.prize_label,
        rank1_username: visionConfig.rank1_username,
        rank1_wager: visionConfig.rank1_wager,
        rank1_prize: visionConfig.rank1_prize,
        confidence: visionConfig.confidence,
        learnedAt: new Date().toISOString()
      },
      preferredSource: extractionResult?.extractionMethod || null
    },
    validation: {
      expectedEntries: extractionResult?.entries?.length || 0,
      hasPrizes: (visionConfig.rank1_prize || 0) > 0,
      visionValidated: true
    }
  };

  saveLeaderboardConfig(BASE_PATH, domain, leaderboardName, config);
  console.log(`   💾 Saved config for ${domain}/${leaderboardName}`);
}

async function runTest() {
  console.log('🧪 Vision Teaching - 50 Sites');
  console.log('================================\n');

  // Check LLM availability
  if (!isLLMAvailable()) {
    console.error('❌ LLM not available. Set ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  // Load sites
  const sites = loadUniqueSites(50);
  console.log(`\nWill process ${sites.length} sites\n`);

  // Setup
  const debugDir = path.join(__dirname, 'debug', 'vision-teaching-50');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];
  let totalCost = 0;
  const stats = { matches: 0, mismatches: 0, failures: 0, saved: 0 };

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    console.log(`\n[${i + 1}/${sites.length}] ${site.domain}`);
    console.log(`   URL: ${site.url}`);

    const siteResult = {
      site: site.domain,
      url: site.url,
      leaderboards: [],
      errors: []
    };

    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      const networkData = await setupNetworkCapture(page);

      // Navigate
      try {
        await page.goto(site.url, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (e) {
        // Try alternate URL
        const altUrl = site.url.replace('/leaderboard', '/leaderboards');
        try {
          await page.goto(altUrl, { waitUntil: 'networkidle', timeout: 30000 });
        } catch (e2) {
          throw new Error(`Navigation failed: ${e.message}`);
        }
      }

      await page.waitForTimeout(3000);
      await dismissPopups(page);

      // Find leaderboards on page
      const switchers = await findSiteSwitchers(page, KEYWORDS);
      const lbNames = switchers.length > 0
        ? switchers.map(s => s.keyword)
        : ['default'];

      console.log(`   Found ${lbNames.length} leaderboard(s): ${lbNames.join(', ')}`);

      // Process first leaderboard only (to save API costs)
      const lbName = lbNames[0];

      // Click switcher if needed
      if (switchers.length > 0 && lbName !== 'default') {
        const switcher = switchers.find(s => s.keyword === lbName);
        if (switcher?.coordinates) {
          clearNetworkData(networkData);
          await page.mouse.click(switcher.coordinates.x, switcher.coordinates.y);
          await page.waitForTimeout(2000);
          await dismissPopups(page);
        }
      }

      // PHASE 1: BEFORE VISION
      console.log('   📊 BEFORE: Extracting without Vision...');
      const beforeExtraction = await runScraperWithConfig(page, networkData, site.name, lbName, null);
      const beforeRank1 = beforeExtraction?.entries?.find(e => e.rank === 1) || beforeExtraction?.entries?.[0];

      if (beforeRank1) {
        console.log(`      #1: ${beforeRank1.username} - wager: $${beforeRank1.wager?.toLocaleString()}`);
      } else {
        console.log('      No entries extracted');
      }

      // PHASE 2: Vision learns
      console.log('   👁️  VISION: Learning structure...');
      const vision = await visionAnalyze(page, site.name, lbName, debugDir);
      totalCost += vision.cost;

      if (!vision.config) {
        console.log('      ❌ Vision failed');
        siteResult.leaderboards.push({ name: lbName, error: 'Vision failed' });
        stats.failures++;
        await page.close();
        await context.close();
        results.push(siteResult);
        continue;
      }

      console.log(`      Column: ${vision.config.column_order}, Podium: ${vision.config.podium_layout}`);
      console.log(`      Vision #1: ${vision.config.rank1_username} - wager: $${vision.config.rank1_wager?.toLocaleString()}`);

      // PHASE 3: AFTER VISION
      console.log('   📊 AFTER: Extracting with Vision config...');
      const afterExtraction = await runScraperWithConfig(page, networkData, site.name, lbName, vision.config);
      const afterRank1 = afterExtraction?.entries?.find(e => e.rank === 1) || afterExtraction?.entries?.[0];

      if (afterRank1) {
        console.log(`      #1: ${afterRank1.username} - wager: $${afterRank1.wager?.toLocaleString()}`);
      }

      // PHASE 4: Compare
      const visionWager = vision.config.rank1_wager || 0;
      const afterWager = afterRank1?.wager || 0;
      const wagerMatch = visionWager > 0 && Math.abs(visionWager - afterWager) / Math.max(visionWager, 1) < 0.05;

      let status;
      if (wagerMatch) {
        status = '✅ MATCH';
        stats.matches++;

        // Save config to site profile
        saveVisionConfig(site.domain, lbName, vision.config, afterExtraction);
        stats.saved++;
      } else if (!afterRank1) {
        status = '💀 NO DATA';
        stats.failures++;
      } else {
        status = '⚠️ MISMATCH';
        stats.mismatches++;
        console.log(`      Vision: $${visionWager}, Scraper: $${afterWager}`);

        // Still save config - Vision is ground truth
        saveVisionConfig(site.domain, lbName, vision.config, afterExtraction);
        stats.saved++;
      }

      console.log(`   ${status}`);

      siteResult.leaderboards.push({
        name: lbName,
        screenshot: vision.screenshot,
        vision: vision.config,
        before: {
          entries: beforeExtraction?.entries?.length || 0,
          method: beforeExtraction?.extractionMethod || 'none',
          rank1: beforeRank1
        },
        after: {
          entries: afterExtraction?.entries?.length || 0,
          method: afterExtraction?.extractionMethod || 'none',
          rank1: afterRank1,
          matchesVision: wagerMatch
        },
        status
      });

      await page.close();
      await context.close();

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      siteResult.errors.push(error.message);
      stats.failures++;
    }

    results.push(siteResult);

    // Progress update
    if ((i + 1) % 10 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${sites.length} | Cost: $${totalCost.toFixed(4)} ---\n`);
    }
  }

  await browser.close();

  // Generate report
  console.log('\n================================');
  console.log('📊 FINAL RESULTS');
  console.log('================================');
  console.log(`✅ Matches: ${stats.matches}`);
  console.log(`⚠️  Mismatches: ${stats.mismatches}`);
  console.log(`💀 Failures: ${stats.failures}`);
  console.log(`💾 Configs saved: ${stats.saved}`);
  console.log(`💰 Total cost: $${totalCost.toFixed(4)}`);

  // Save results
  const reportPath = generateReport(results, debugDir, totalCost, stats);
  const jsonPath = path.join(debugDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  console.log(`\n📄 Report: ${reportPath}`);
  console.log(`   open "${reportPath}"`);
}

function generateReport(results, debugDir, totalCost, stats) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Vision Teaching: 50 Sites</title>
  <style>
    body { font-family: system-ui; margin: 20px; background: #0a0a15; color: #e0e0e0; }
    h1 { color: #00d4ff; }
    .summary { background: #1a1a2e; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
    .stats { display: flex; gap: 20px; margin-top: 15px; flex-wrap: wrap; }
    .stat { flex: 1; min-width: 100px; text-align: center; padding: 15px; border-radius: 8px; }
    .stat.match { background: #0a3a0a; border: 1px solid #00ff88; }
    .stat.mismatch { background: #3a3a0a; border: 1px solid #ffaa00; }
    .stat.fail { background: #3a0a0a; border: 1px solid #ff4444; }
    .stat.saved { background: #0a2a3a; border: 1px solid #00aaff; }
    .stat-value { font-size: 2em; font-weight: bold; }
    .stat-label { color: #888; margin-top: 5px; }

    .site { background: #1a1a2e; margin: 10px 0; padding: 15px; border-radius: 8px; }
    .site.match { border-left: 4px solid #00ff88; }
    .site.mismatch { border-left: 4px solid #ffaa00; }
    .site.fail { border-left: 4px solid #ff4444; }
    .site-header { display: flex; justify-content: space-between; align-items: center; }
    .site-name { font-size: 1.1em; color: #00d4ff; }
    .site-status { padding: 5px 12px; border-radius: 15px; font-size: 0.9em; }
    .site-status.match { background: #0a3a0a; color: #00ff88; }
    .site-status.mismatch { background: #3a3a0a; color: #ffaa00; }
    .site-status.fail { background: #3a0a0a; color: #ff4444; }

    .data { margin-top: 10px; font-size: 0.9em; color: #888; }
    .data span { margin-right: 20px; }
    .data .value { color: #fff; }

    .screenshot { max-width: 300px; max-height: 150px; border: 1px solid #333; border-radius: 5px; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>🧪 Vision Teaching: 50 Sites</h1>

  <div class="summary">
    <h2 style="margin: 0; color: #00d4ff;">Results Summary</h2>
    <div class="stats">
      <div class="stat match">
        <div class="stat-value">${stats.matches}</div>
        <div class="stat-label">✅ Matches</div>
      </div>
      <div class="stat mismatch">
        <div class="stat-value">${stats.mismatches}</div>
        <div class="stat-label">⚠️ Mismatches</div>
      </div>
      <div class="stat fail">
        <div class="stat-value">${stats.failures}</div>
        <div class="stat-label">💀 Failed</div>
      </div>
      <div class="stat saved">
        <div class="stat-value">${stats.saved}</div>
        <div class="stat-label">💾 Configs Saved</div>
      </div>
    </div>
    <p style="margin-top: 15px; color: #888;">Total cost: \$${totalCost.toFixed(4)}</p>
  </div>

  <h2>Sites</h2>
  ${results.map(site => {
    const lb = site.leaderboards[0];
    const statusClass = lb?.status?.includes('MATCH') ? 'match' : lb?.status?.includes('MISMATCH') ? 'mismatch' : 'fail';
    return `
    <div class="site ${statusClass}">
      <div class="site-header">
        <div class="site-name">${site.site}</div>
        <span class="site-status ${statusClass}">${lb?.status || '💀 Failed'}</span>
      </div>
      <div class="data">
        <span>URL: <span class="value">${site.url}</span></span>
        ${lb ? `
        <span>Method: <span class="value">${lb.after?.method || 'none'}</span></span>
        <span>Entries: <span class="value">${lb.after?.entries || 0}</span></span>
        ` : ''}
      </div>
      ${lb?.vision ? `
      <div class="data">
        <span>Vision #1: <span class="value">${lb.vision.rank1_username}</span></span>
        <span>Wager: <span class="value">\$${(lb.vision.rank1_wager || 0).toLocaleString()}</span></span>
        <span>Prize: <span class="value">\$${(lb.vision.rank1_prize || 0).toLocaleString()}</span></span>
      </div>
      ` : ''}
      ${lb?.after?.rank1 ? `
      <div class="data">
        <span>Scraper #1: <span class="value">${lb.after.rank1.username}</span></span>
        <span>Wager: <span class="value">\$${(lb.after.rank1.wager || 0).toLocaleString()}</span></span>
      </div>
      ` : ''}
      ${site.errors.length ? `<div class="data" style="color: #ff4444;">Error: ${site.errors[0]}</div>` : ''}
      ${lb?.screenshot ? `<img class="screenshot" src="${lb.screenshot}" />` : ''}
    </div>
    `;
  }).join('')}
</body>
</html>`;

  const reportPath = path.join(debugDir, 'report.html');
  fs.writeFileSync(reportPath, html);
  return reportPath;
}

runTest().catch(console.error);
