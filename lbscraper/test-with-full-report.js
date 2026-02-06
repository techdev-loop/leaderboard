/**
 * Test Learned Configs with Full Data Report
 *
 * Runs the scraper and generates a detailed HTML report showing
 * ALL entries for each leaderboard (like the admin viewer)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { findSiteSwitchers } = require('./shared/site-detection');
const { setupNetworkCapture, clearNetworkData } = require('./shared/network-capture');
const { scrapePageData } = require('./core/page-scraper');
const { extractLeaderboardData } = require('./core/data-extractor');
const { getLeaderboardConfig } = require('./shared/learned-patterns');

const BASE_PATH = __dirname;

const keywordsPath = path.join(__dirname, 'keywords.txt');
const KEYWORDS = fs.existsSync(keywordsPath)
  ? fs.readFileSync(keywordsPath, 'utf8').split('\n').map(k => k.trim().toLowerCase()).filter(k => k && !k.startsWith('#'))
  : [];

function getSitesWithLearnedConfigs(limit = 30) {
  const profilesDir = path.join(__dirname, 'data', 'site-profiles');
  const sites = [];

  if (!fs.existsSync(profilesDir)) return sites;

  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(profilesDir, file), 'utf8'));
      const leaderboards = profile.extractionConfig?.leaderboards || {};

      for (const [lbName, lbConfig] of Object.entries(leaderboards)) {
        if (lbConfig.extraction?.visionConfig) {
          sites.push({
            domain: profile.domain,
            leaderboardName: lbName,
            url: profile.navigation?.leaderboardPath || `https://${profile.domain}/leaderboard`,
            visionConfig: lbConfig.extraction.visionConfig
          });
        }
      }
    } catch (e) {}
  }

  return sites.slice(0, limit);
}

async function dismissPopups(page) {
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await page.waitForTimeout(300);
}

async function runTest() {
  console.log('🧪 Full Data Test - Learned Configs');
  console.log('====================================\n');

  const sites = getSitesWithLearnedConfigs(30);
  console.log(`Testing ${sites.length} leaderboards with Vision configs...\n`);

  const debugDir = path.join(__dirname, 'debug', 'full-data-test');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    console.log(`\n[${i + 1}/${sites.length}] ${site.domain}/${site.leaderboardName}`);

    const result = {
      domain: site.domain,
      leaderboard: site.leaderboardName,
      url: site.url,
      visionConfig: site.visionConfig,
      entries: [],
      entryCount: 0,
      method: null,
      confidence: 0,
      error: null,
      screenshot: null
    };

    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await context.newPage();
      const networkData = await setupNetworkCapture(page);

      await page.goto(site.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      await dismissPopups(page);

      // Find and click switcher
      const switchers = await findSiteSwitchers(page, KEYWORDS);
      const targetSwitcher = switchers.find(s => s.keyword === site.leaderboardName);

      if (targetSwitcher?.coordinates) {
        clearNetworkData(networkData);
        await page.mouse.click(targetSwitcher.coordinates.x, targetSwitcher.coordinates.y);
        await page.waitForTimeout(2000);
        await dismissPopups(page);
      }

      // Take screenshot
      const screenshotName = `${site.domain}-${site.leaderboardName}.png`;
      await page.screenshot({ path: path.join(debugDir, screenshotName), fullPage: false });
      result.screenshot = screenshotName;

      // Extract data
      const pageData = await scrapePageData({
        page,
        url: page.url(),
        networkData,
        config: { takeScreenshot: false, scrollPage: true, waitForContent: 2000 }
      });

      const extraction = await extractLeaderboardData({
        ...pageData,
        page,
        siteName: site.leaderboardName,
        config: {
          prizeBeforeWager: site.visionConfig?.column_order === 'prize_before_wager',
          podiumLayout: site.visionConfig?.podium_layout,
          expectedRank1: site.visionConfig ? {
            username: site.visionConfig.rank1_username,
            wager: site.visionConfig.rank1_wager,
            prize: site.visionConfig.rank1_prize
          } : null
        }
      });

      if (extraction?.entries?.length > 0) {
        result.entries = extraction.entries.map(e => ({
          rank: e.rank,
          username: e.username,
          wager: e.wager,
          prize: e.prize
        }));
        result.entryCount = extraction.entries.length;
        result.method = extraction.extractionMethod;
        result.confidence = extraction.confidence;
        console.log(`   ✅ Got ${result.entryCount} entries via ${result.method}`);
      } else {
        console.log('   ❌ No entries');
      }

      await context.close();
    } catch (e) {
      result.error = e.message;
      console.log(`   ❌ Error: ${e.message}`);
    }

    results.push(result);
  }

  await browser.close();

  // Generate full report
  const html = generateFullReport(results);
  const htmlPath = path.join(debugDir, 'full-report.html');
  fs.writeFileSync(htmlPath, html);

  // Also save JSON
  fs.writeFileSync(path.join(debugDir, 'results.json'), JSON.stringify(results, null, 2));

  console.log('\n================================');
  console.log('📊 COMPLETE');
  console.log(`📄 Full Report: ${htmlPath}`);
  console.log(`   open "${htmlPath}"`);
}

function generateFullReport(results) {
  const siteCards = results.map(r => {
    const entriesRows = r.entries.map((e, idx) => `
      <tr class="${idx < 3 ? 'top3' : ''}">
        <td class="rank">${e.rank || idx + 1}</td>
        <td class="username">${e.username || 'N/A'}</td>
        <td class="wager">$${(e.wager || 0).toLocaleString()}</td>
        <td class="prize">$${(e.prize || 0).toLocaleString()}</td>
      </tr>
    `).join('');

    const statusClass = r.entryCount > 0 ? 'success' : 'failed';
    const statusText = r.entryCount > 0 ? `✅ ${r.entryCount} entries` : '❌ No data';

    return `
    <div class="site-card ${statusClass}">
      <div class="site-header">
        <div class="site-info">
          <h3>${r.domain}</h3>
          <span class="leaderboard-name">${r.leaderboard}</span>
        </div>
        <div class="site-meta">
          <span class="status ${statusClass}">${statusText}</span>
          <span class="method">${r.method || 'none'}</span>
          <span class="confidence">${r.confidence}%</span>
        </div>
      </div>

      ${r.screenshot ? `<img class="screenshot" src="${r.screenshot}" />` : ''}

      ${r.visionConfig ? `
      <div class="vision-info">
        <strong>Vision Config:</strong>
        Column: ${r.visionConfig.column_order || 'unknown'} |
        Podium: ${r.visionConfig.podium_layout || 'unknown'} |
        Expected #1: ${r.visionConfig.rank1_username || 'N/A'} ($${(r.visionConfig.rank1_wager || 0).toLocaleString()})
      </div>
      ` : ''}

      ${r.entries.length > 0 ? `
      <table class="entries-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Username</th>
            <th>Wager</th>
            <th>Prize</th>
          </tr>
        </thead>
        <tbody>
          ${entriesRows}
        </tbody>
      </table>
      ` : `<div class="no-data">${r.error || 'No entries extracted'}</div>`}
    </div>
    `;
  }).join('');

  const successCount = results.filter(r => r.entryCount > 0).length;
  const totalEntries = results.reduce((sum, r) => sum + r.entryCount, 0);

  return `<!DOCTYPE html>
<html>
<head>
  <title>Full Leaderboard Data Report</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0; padding: 20px;
      background: #0d1117; color: #c9d1d9;
    }
    h1 { color: #58a6ff; margin-bottom: 5px; }
    .subtitle { color: #8b949e; margin-bottom: 20px; }

    .summary {
      display: flex; gap: 20px; margin-bottom: 30px; flex-wrap: wrap;
    }
    .summary-card {
      background: #161b22; padding: 20px 30px;
      border-radius: 10px; border: 1px solid #30363d;
      text-align: center;
    }
    .summary-card .value { font-size: 2.5em; font-weight: bold; color: #58a6ff; }
    .summary-card .label { color: #8b949e; margin-top: 5px; }

    .site-card {
      background: #161b22; border-radius: 10px;
      border: 1px solid #30363d; margin-bottom: 20px;
      overflow: hidden;
    }
    .site-card.success { border-left: 4px solid #3fb950; }
    .site-card.failed { border-left: 4px solid #f85149; }

    .site-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 15px 20px; background: #21262d;
      border-bottom: 1px solid #30363d;
    }
    .site-info h3 { margin: 0; color: #58a6ff; }
    .site-info .leaderboard-name {
      color: #8b949e; font-size: 0.9em;
      background: #30363d; padding: 2px 8px; border-radius: 12px;
      margin-left: 10px;
    }
    .site-meta { display: flex; gap: 15px; align-items: center; }
    .site-meta span {
      padding: 4px 12px; border-radius: 15px;
      font-size: 0.85em;
    }
    .status.success { background: #238636; color: #fff; }
    .status.failed { background: #da3633; color: #fff; }
    .method { background: #1f6feb; color: #fff; }
    .confidence { background: #30363d; color: #c9d1d9; }

    .screenshot {
      width: 100%; max-height: 200px;
      object-fit: cover; object-position: top;
      border-bottom: 1px solid #30363d;
    }

    .vision-info {
      padding: 10px 20px; background: #1c2128;
      font-size: 0.85em; color: #8b949e;
      border-bottom: 1px solid #30363d;
    }

    .entries-table {
      width: 100%; border-collapse: collapse;
    }
    .entries-table th {
      background: #21262d; padding: 10px 15px;
      text-align: left; font-weight: 600;
      color: #8b949e; font-size: 0.85em;
      text-transform: uppercase;
    }
    .entries-table td {
      padding: 10px 15px; border-top: 1px solid #21262d;
    }
    .entries-table tr:hover { background: #1c2128; }
    .entries-table tr.top3 { background: rgba(56, 139, 253, 0.1); }
    .entries-table tr.top3:first-child { background: rgba(255, 215, 0, 0.1); }

    .rank { width: 60px; font-weight: bold; color: #8b949e; }
    .username { color: #c9d1d9; }
    .wager { color: #3fb950; font-family: monospace; }
    .prize { color: #f0883e; font-family: monospace; }

    .no-data {
      padding: 30px; text-align: center;
      color: #8b949e; font-style: italic;
    }
  </style>
</head>
<body>
  <h1>📊 Full Leaderboard Data Report</h1>
  <p class="subtitle">All entries extracted from ${results.length} leaderboards</p>

  <div class="summary">
    <div class="summary-card">
      <div class="value">${successCount}</div>
      <div class="label">Successful Extractions</div>
    </div>
    <div class="summary-card">
      <div class="value">${results.length - successCount}</div>
      <div class="label">Failed</div>
    </div>
    <div class="summary-card">
      <div class="value">${totalEntries}</div>
      <div class="label">Total Entries</div>
    </div>
  </div>

  ${siteCards}
</body>
</html>`;
}

runTest().catch(console.error);
