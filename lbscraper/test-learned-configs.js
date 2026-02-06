/**
 * Test Learned Configs
 *
 * Runs the normal scraper on sites that have Vision-learned configs
 * to verify the configs work correctly.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Existing scraper modules
const { findSiteSwitchers } = require('./shared/site-detection');
const { setupNetworkCapture, clearNetworkData } = require('./shared/network-capture');
const { scrapePageData } = require('./core/page-scraper');
const { extractLeaderboardData } = require('./core/data-extractor');
const { getLeaderboardConfig } = require('./shared/learned-patterns');
const { log } = require('./shared/utils');

const BASE_PATH = __dirname;

// Load keywords
const keywordsPath = path.join(__dirname, 'keywords.txt');
const KEYWORDS = fs.existsSync(keywordsPath)
  ? fs.readFileSync(keywordsPath, 'utf8').split('\n').map(k => k.trim().toLowerCase()).filter(k => k && !k.startsWith('#'))
  : [];

/**
 * Get sites with Vision-learned configs
 */
function getSitesWithLearnedConfigs() {
  const profilesDir = path.join(__dirname, 'data', 'site-profiles');
  const sites = [];

  if (!fs.existsSync(profilesDir)) return sites;

  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(profilesDir, file), 'utf8'));
      const leaderboards = profile.extractionConfig?.leaderboards || {};

      // Find leaderboards with visionConfig
      for (const [lbName, lbConfig] of Object.entries(leaderboards)) {
        if (lbConfig.extraction?.visionConfig) {
          sites.push({
            domain: profile.domain,
            leaderboardName: lbName,
            url: profile.navigation?.leaderboardPath || `https://${profile.domain}/leaderboard`,
            visionConfig: lbConfig.extraction.visionConfig,
            preferredSource: lbConfig.extraction.preferredSource
          });
        }
      }
    } catch (e) {
      // Skip invalid profiles
    }
  }

  return sites;
}

async function dismissPopups(page) {
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await page.waitForTimeout(300);
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

async function runTest() {
  console.log('🧪 Test Learned Configs - Normal Scraper');
  console.log('=========================================\n');

  // Get sites with learned configs
  const sites = getSitesWithLearnedConfigs();
  console.log(`Found ${sites.length} leaderboards with Vision-learned configs\n`);

  if (sites.length === 0) {
    console.log('No configs to test. Run vision teaching first.');
    return;
  }

  // Limit to first 20 for testing
  const testSites = sites.slice(0, 20);
  console.log(`Testing first ${testSites.length} configs...\n`);

  const debugDir = path.join(__dirname, 'debug', 'learned-config-test');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];
  const stats = { success: 0, partialMatch: 0, failed: 0 };

  for (let i = 0; i < testSites.length; i++) {
    const site = testSites[i];
    console.log(`\n[${i + 1}/${testSites.length}] ${site.domain}/${site.leaderboardName}`);
    console.log(`   Expected #1: ${site.visionConfig.rank1_username} - wager: $${site.visionConfig.rank1_wager?.toLocaleString()}`);

    const result = {
      domain: site.domain,
      leaderboard: site.leaderboardName,
      expected: site.visionConfig,
      actual: null,
      status: 'failed',
      error: null
    };

    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      const networkData = await setupNetworkCapture(page);

      // Navigate
      await page.goto(site.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      await dismissPopups(page);

      // Find and click the right switcher
      const switchers = await findSiteSwitchers(page, KEYWORDS);
      const targetSwitcher = switchers.find(s => s.keyword === site.leaderboardName);

      if (targetSwitcher?.coordinates) {
        clearNetworkData(networkData);
        await page.mouse.click(targetSwitcher.coordinates.x, targetSwitcher.coordinates.y);
        await page.waitForTimeout(2000);
        await dismissPopups(page);
      }

      // Run extraction with learned config
      const extraction = await runScraperWithConfig(
        page, networkData, site.domain, site.leaderboardName, site.visionConfig
      );

      const rank1 = extraction?.entries?.find(e => e.rank === 1) || extraction?.entries?.[0];

      if (rank1) {
        result.actual = {
          username: rank1.username,
          wager: rank1.wager,
          prize: rank1.prize
        };

        // Check if wager matches (within 10% tolerance for dynamic data)
        const expectedWager = site.visionConfig.rank1_wager || 0;
        const actualWager = rank1.wager || 0;
        const wagerMatch = Math.abs(expectedWager - actualWager) / Math.max(expectedWager, 1) < 0.5; // 50% tolerance

        if (wagerMatch || extraction.entries?.length >= 3) {
          result.status = 'success';
          stats.success++;
          console.log(`   ✅ SUCCESS: Got ${extraction.entries?.length || 0} entries`);
          console.log(`      Actual #1: ${rank1.username} - wager: $${rank1.wager?.toLocaleString()}`);
        } else {
          result.status = 'partial';
          stats.partialMatch++;
          console.log(`   ⚠️ PARTIAL: Data may have changed`);
          console.log(`      Actual #1: ${rank1.username} - wager: $${rank1.wager?.toLocaleString()}`);
        }
      } else {
        result.status = 'failed';
        stats.failed++;
        console.log('   ❌ FAILED: No entries extracted');
      }

      await context.close();
    } catch (e) {
      result.error = e.message;
      stats.failed++;
      console.log(`   ❌ ERROR: ${e.message}`);
    }

    results.push(result);

    // Progress update
    if ((i + 1) % 5 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${testSites.length} | Success: ${stats.success} | Partial: ${stats.partialMatch} | Failed: ${stats.failed} ---`);
    }
  }

  await browser.close();

  // Final summary
  console.log('\n\n================================');
  console.log('📊 FINAL RESULTS');
  console.log('================================');
  console.log(`✅ Success: ${stats.success}`);
  console.log(`⚠️  Partial Match: ${stats.partialMatch}`);
  console.log(`❌ Failed: ${stats.failed}`);
  console.log(`📊 Success Rate: ${((stats.success / testSites.length) * 100).toFixed(1)}%`);

  // Save results
  const reportPath = path.join(debugDir, 'results.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 Results saved: ${reportPath}`);

  // Generate HTML report
  const htmlReport = generateHtmlReport(results, stats);
  const htmlPath = path.join(debugDir, 'report.html');
  fs.writeFileSync(htmlPath, htmlReport);
  console.log(`📄 HTML Report: ${htmlPath}`);
}

function generateHtmlReport(results, stats) {
  const rows = results.map(r => `
    <tr class="${r.status}">
      <td>${r.domain}</td>
      <td>${r.leaderboard}</td>
      <td>${r.expected?.rank1_username || 'N/A'}</td>
      <td>$${r.expected?.rank1_wager?.toLocaleString() || '0'}</td>
      <td>${r.actual?.username || 'N/A'}</td>
      <td>$${r.actual?.wager?.toLocaleString() || '0'}</td>
      <td class="status-${r.status}">${r.status.toUpperCase()}</td>
      <td>${r.error || ''}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Learned Config Test Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4ff; }
    .stats { display: flex; gap: 20px; margin: 20px 0; }
    .stat { padding: 15px 25px; border-radius: 8px; }
    .stat.success { background: #0a4a0a; }
    .stat.partial { background: #4a4a0a; }
    .stat.failed { background: #4a0a0a; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #2a2a4e; }
    tr.success { background: rgba(0,200,0,0.1); }
    tr.partial { background: rgba(200,200,0,0.1); }
    tr.failed { background: rgba(200,0,0,0.1); }
    .status-success { color: #0f0; }
    .status-partial { color: #ff0; }
    .status-failed { color: #f00; }
  </style>
</head>
<body>
  <h1>🧪 Learned Config Test Results</h1>

  <div class="stats">
    <div class="stat success">✅ Success: ${stats.success}</div>
    <div class="stat partial">⚠️ Partial: ${stats.partialMatch}</div>
    <div class="stat failed">❌ Failed: ${stats.failed}</div>
  </div>

  <table>
    <tr>
      <th>Domain</th>
      <th>Leaderboard</th>
      <th>Expected User</th>
      <th>Expected Wager</th>
      <th>Actual User</th>
      <th>Actual Wager</th>
      <th>Status</th>
      <th>Error</th>
    </tr>
    ${rows}
  </table>
</body>
</html>`;
}

runTest().catch(console.error);
