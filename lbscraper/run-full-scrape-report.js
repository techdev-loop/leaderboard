#!/usr/bin/env node
/**
 * Full Scrape with Report Generation
 *
 * Uses the REAL scraper (orchestrateScrape) to scrape ALL leaderboards
 * on each site, then generates an HTML report showing all data.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

chromium.use(stealth());

const { orchestrateScrape } = require('./orchestrators/scrape-orchestrator');
const { setupNetworkCapture } = require('./shared/network-capture');
const { loadKeywords } = require('./shared/utils');
const { buildLegacyConfig } = require('./shared/config');
const { initChallengeBypass, navigateWithBypass } = require('./shared/page-navigation');

const BASE_PATH = __dirname;

/**
 * Load unique sites from websites.txt
 */
function loadUniqueSites(limit = 30) {
  const websitesPath = path.join(__dirname, 'websites.txt');
  const lines = fs.readFileSync(websitesPath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));

  const seen = new Set();
  const sites = [];

  for (const line of lines) {
    try {
      const url = new URL(line.trim());
      const domain = url.hostname.replace(/^www\./, '');

      if (!seen.has(domain)) {
        seen.add(domain);
        sites.push({
          domain,
          url: line.trim()
        });
      }
    } catch (e) {}
  }

  return sites.slice(0, limit);
}

async function runFullScrape() {
  const args = process.argv.slice(2);
  const siteLimit = parseInt(args.find(a => /^\d+$/.test(a)) || '30');

  console.log('🚀 Full Scrape with Report Generation');
  console.log('=====================================');
  console.log(`   Sites to scrape: ${siteLimit}`);
  console.log('');

  const sites = loadUniqueSites(siteLimit);
  console.log(`Loaded ${sites.length} unique sites\n`);

  const debugDir = path.join(__dirname, 'debug', 'full-scrape-report');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  const config = buildLegacyConfig(__dirname);
  const keywords = loadKeywords(config.paths.keywords);

  // Initialize challenge bypass
  try {
    const challengeBypass = require('./challenge-bypass');
    initChallengeBypass(challengeBypass);
  } catch (e) {}

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const allResults = [];
  const stats = {
    sitesProcessed: 0,
    sitesSuccessful: 0,
    sitesFailed: 0,
    totalLeaderboards: 0,
    totalEntries: 0
  };

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    console.log(`\n[${i + 1}/${sites.length}] ${site.domain}`);
    console.log(`   URL: ${site.url}`);

    const siteResult = {
      domain: site.domain,
      url: site.url,
      leaderboards: [],
      error: null,
      screenshot: null
    };

    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US'
      });

      const page = await context.newPage();
      const networkData = await setupNetworkCapture(page);

      // Navigate
      const navResult = await navigateWithBypass(page, site.url, { maxRetries: 2, waitAfterLoad: 5000 });
      if (!navResult.success) {
        throw new Error(`Navigation failed: ${navResult.error}`);
      }

      // Take screenshot
      const screenshotName = `${site.domain}.png`;
      await page.screenshot({ path: path.join(debugDir, screenshotName), fullPage: false });
      siteResult.screenshot = screenshotName;

      // Run the REAL orchestrator - this scrapes ALL leaderboards
      const result = await orchestrateScrape({
        page,
        baseUrl: site.url,
        networkData,
        config,
        keywords
      });

      // Process results
      if (result.results && result.results.length > 0) {
        for (const lb of result.results) {
          siteResult.leaderboards.push({
            name: lb.name,
            entryCount: lb.entryCount,
            source: lb.source,
            confidence: lb.confidence,
            entries: lb.entries || [],
            totalWagered: lb.totalWagered || 0,
            totalPrizePool: lb.totalPrizePool || 0
          });
          stats.totalLeaderboards++;
          stats.totalEntries += lb.entryCount || 0;
        }
        stats.sitesSuccessful++;
        console.log(`   ✅ ${result.results.length} leaderboards, ${result.results.reduce((s, r) => s + (r.entryCount || 0), 0)} total entries`);
      } else {
        siteResult.error = result.errors?.join('; ') || 'No leaderboards found';
        stats.sitesFailed++;
        console.log(`   ❌ ${siteResult.error}`);
      }

      await context.close();

    } catch (e) {
      siteResult.error = e.message;
      stats.sitesFailed++;
      console.log(`   ❌ Error: ${e.message}`);
    }

    allResults.push(siteResult);
    stats.sitesProcessed++;

    // Progress
    if ((i + 1) % 5 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${sites.length} | Success: ${stats.sitesSuccessful} | Failed: ${stats.sitesFailed} | LBs: ${stats.totalLeaderboards} | Entries: ${stats.totalEntries} ---`);
    }
  }

  await browser.close();

  // Generate report
  const html = generateFullReport(allResults, stats);
  const htmlPath = path.join(debugDir, 'full-report.html');
  fs.writeFileSync(htmlPath, html);

  // Save JSON
  fs.writeFileSync(path.join(debugDir, 'results.json'), JSON.stringify(allResults, null, 2));

  console.log('\n\n=====================================');
  console.log('📊 COMPLETE');
  console.log('=====================================');
  console.log(`Sites: ${stats.sitesSuccessful}/${stats.sitesProcessed} successful`);
  console.log(`Leaderboards: ${stats.totalLeaderboards}`);
  console.log(`Entries: ${stats.totalEntries}`);
  console.log(`\n📄 Report: ${htmlPath}`);
  console.log(`   open "${htmlPath}"`);
}

function generateFullReport(results, stats) {
  const siteCards = results.map(site => {
    const lbSections = site.leaderboards.map(lb => {
      const entriesRows = (lb.entries || []).slice(0, 100).map((e, idx) => `
        <tr class="${idx < 3 ? 'top3' : ''}">
          <td class="rank">${e.rank || idx + 1}</td>
          <td class="username">${escapeHtml(e.username || 'N/A')}</td>
          <td class="wager">$${(e.wager || 0).toLocaleString()}</td>
          <td class="prize">$${(e.prize || 0).toLocaleString()}</td>
        </tr>
      `).join('');

      return `
        <div class="leaderboard">
          <div class="lb-header">
            <span class="lb-name">${escapeHtml(lb.name)}</span>
            <span class="lb-stats">${lb.entryCount} entries | ${lb.source} | ${lb.confidence}%</span>
          </div>
          <div class="lb-summary">
            Total Wagered: $${(lb.totalWagered || 0).toLocaleString()} | Prize Pool: $${(lb.totalPrizePool || 0).toLocaleString()}
          </div>
          <table class="entries-table">
            <thead><tr><th>Rank</th><th>Username</th><th>Wager</th><th>Prize</th></tr></thead>
            <tbody>${entriesRows}</tbody>
          </table>
          ${lb.entries.length > 100 ? `<div class="truncated">Showing 100 of ${lb.entries.length} entries</div>` : ''}
        </div>
      `;
    }).join('');

    const statusClass = site.leaderboards.length > 0 ? 'success' : 'failed';
    const statusText = site.leaderboards.length > 0
      ? `✅ ${site.leaderboards.length} leaderboards`
      : `❌ ${site.error || 'Failed'}`;

    return `
      <div class="site-card ${statusClass}">
        <div class="site-header">
          <div class="site-info">
            <h2>${escapeHtml(site.domain)}</h2>
            <a href="${escapeHtml(site.url)}" target="_blank" class="site-url">${escapeHtml(site.url)}</a>
          </div>
          <span class="status">${statusText}</span>
        </div>
        ${site.screenshot ? `<img class="screenshot" src="${site.screenshot}" />` : ''}
        ${site.error ? `<div class="error">${escapeHtml(site.error)}</div>` : ''}
        <div class="leaderboards">${lbSections}</div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Full Scrape Report - ${stats.sitesProcessed} Sites</title>
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
      text-align: center; min-width: 150px;
    }
    .summary-card .value { font-size: 2.2em; font-weight: bold; color: #58a6ff; }
    .summary-card .label { color: #8b949e; margin-top: 5px; }

    .site-card {
      background: #161b22; border-radius: 10px;
      border: 1px solid #30363d; margin-bottom: 30px;
      overflow: hidden;
    }
    .site-card.success { border-left: 4px solid #3fb950; }
    .site-card.failed { border-left: 4px solid #f85149; }

    .site-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 15px 20px; background: #21262d;
      border-bottom: 1px solid #30363d;
    }
    .site-info h2 { margin: 0; color: #58a6ff; font-size: 1.3em; }
    .site-url { color: #8b949e; font-size: 0.85em; text-decoration: none; }
    .site-url:hover { text-decoration: underline; }
    .status { padding: 6px 14px; border-radius: 20px; font-size: 0.9em; background: #21262d; }

    .screenshot {
      width: 100%; max-height: 250px;
      object-fit: cover; object-position: top;
      border-bottom: 1px solid #30363d;
    }

    .error { padding: 15px 20px; background: rgba(248, 81, 73, 0.1); color: #f85149; }

    .leaderboards { padding: 15px 20px; }

    .leaderboard {
      background: #0d1117; border-radius: 8px;
      margin-bottom: 15px; overflow: hidden;
      border: 1px solid #21262d;
    }
    .lb-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 15px; background: #161b22;
      border-bottom: 1px solid #21262d;
    }
    .lb-name { color: #58a6ff; font-weight: 600; font-size: 1.1em; }
    .lb-stats { color: #8b949e; font-size: 0.85em; }
    .lb-summary { padding: 8px 15px; background: #1c2128; color: #8b949e; font-size: 0.85em; }

    .entries-table {
      width: 100%; border-collapse: collapse;
    }
    .entries-table th {
      background: #161b22; padding: 8px 12px;
      text-align: left; font-weight: 600;
      color: #8b949e; font-size: 0.8em;
      text-transform: uppercase;
    }
    .entries-table td {
      padding: 8px 12px; border-top: 1px solid #21262d;
      font-size: 0.9em;
    }
    .entries-table tr:hover { background: #1c2128; }
    .entries-table tr.top3 { background: rgba(56, 139, 253, 0.1); }
    .entries-table tr.top3:first-child { background: rgba(255, 215, 0, 0.15); }

    .rank { width: 50px; font-weight: bold; color: #8b949e; }
    .username { color: #c9d1d9; }
    .wager { color: #3fb950; font-family: monospace; }
    .prize { color: #f0883e; font-family: monospace; }

    .truncated { padding: 10px 15px; color: #8b949e; font-style: italic; text-align: center; }
  </style>
</head>
<body>
  <h1>📊 Full Scrape Report</h1>
  <p class="subtitle">All leaderboards and entries from ${stats.sitesProcessed} sites</p>

  <div class="summary">
    <div class="summary-card">
      <div class="value">${stats.sitesSuccessful}</div>
      <div class="label">Sites Successful</div>
    </div>
    <div class="summary-card">
      <div class="value">${stats.sitesFailed}</div>
      <div class="label">Sites Failed</div>
    </div>
    <div class="summary-card">
      <div class="value">${stats.totalLeaderboards}</div>
      <div class="label">Leaderboards</div>
    </div>
    <div class="summary-card">
      <div class="value">${stats.totalEntries.toLocaleString()}</div>
      <div class="label">Total Entries</div>
    </div>
  </div>

  ${siteCards}
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

runFullScrape().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
