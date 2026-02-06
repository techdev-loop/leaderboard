#!/usr/bin/env node
/**
 * Test a single site
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

async function testSite(url) {
  console.log(`\n🔍 Testing: ${url}\n`);
  
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

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();
  const networkData = await setupNetworkCapture(page);

  try {
    await navigateWithBypass(page, url, { maxRetries: 2, waitAfterLoad: 5000 });

    const result = await orchestrateScrape({
      page,
      baseUrl: url,
      networkData,
      config,
      keywords
    });

    console.log('\n\n=== RESULTS ===');
    console.log('Leaderboards found:', result.results?.length || 0);
    console.log('');

    for (const lb of (result.results || [])) {
      console.log(`📊 ${lb.name}: ${lb.entryCount || lb.entries?.length || 0} entries (${lb.source}, ${lb.confidence}% conf)`);
      if (lb.entries) {
        for (const e of lb.entries.slice(0, 15)) {
          console.log(`  #${e.rank} ${e.username} | wager: ${e.wager} | prize: ${e.prize}`);
        }
        if (lb.entries.length > 15) {
          console.log(`  ... and ${lb.entries.length - 15} more`);
        }
      }
      console.log('');
    }

  } finally {
    await browser.close();
  }
}

const url = process.argv[2] || 'https://birb.bet/leaderboards';
testSite(url).catch(e => {
  console.error('Error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
