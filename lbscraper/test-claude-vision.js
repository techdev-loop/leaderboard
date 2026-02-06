/**
 * Claude Vision OCR Test
 *
 * Tests Claude Vision API on 10 leaderboard sites to compare
 * accuracy vs Tesseract OCR for EXTRACTING LEADERBOARD DATA.
 *
 * Uses existing teacher infrastructure (llm-client.js)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Use existing LLM client
const { callClaude, isLLMAvailable } = require('./shared/teacher/llm-client');

// Test sites - mix of different layouts
const TEST_SITES = [
  { url: 'https://spencerrewards.com/leaderboard/chips', name: 'spencerrewards-chips' },
  { url: 'https://goatgambles.com/leaderboard', name: 'goatgambles', clickTab: 'csgogem' },
  { url: 'https://paxgambles.com/leaderboard', name: 'paxgambles' },
  { url: 'https://www.tanskidegen.com/leaderboards', name: 'tanskidegen' },
  { url: 'https://ravengambles.com/leaderboard', name: 'ravengambles' },
  { url: 'https://wahy.gg/leaderboard', name: 'wahy' },
  { url: 'https://adukes.com/leaderboard', name: 'adukes' },
  { url: 'https://rwrds.gg/leaderboard', name: 'rwrds' },
  { url: 'https://www.ilovemav.com/leaderboards', name: 'ilovemav' },
  { url: 'https://augustrewards.com/leaderboard', name: 'augustrewards' },
];

// Prompt specifically for extracting leaderboard data
const EXTRACTION_PROMPT = `You are an expert at extracting leaderboard data from gambling affiliate websites.

Analyze this screenshot and extract ALL visible leaderboard entries.

For EACH entry you can see, extract:
- rank: The position number (1, 2, 3, etc.)
- username: The player's name (may be partially masked with asterisks like "Joh***")
- wager: The amount wagered/bet (look for "Wagered:", "$X,XXX", or large numbers)
- prize: The reward/prize amount (look for "Prize:", "Reward:", smaller $ amounts, or $0 if not shown)

IMPORTANT TIPS:
- The TOP 3 (podium) are often displayed differently - larger cards, different layout
- Ranks 4+ are usually in a list/table format
- Look for column headers like "Place", "User", "Wagered", "Prize", "Reward"
- If you see "Reward" before "Wagered" in headers, the first $ amount per row is prize, second is wager
- Partial usernames with asterisks are normal - extract what you can see

Return ONLY valid JSON (no markdown, no explanation):
{
  "entries": [
    {"rank": 1, "username": "PlayerName", "wager": 12345.67, "prize": 500},
    {"rank": 2, "username": "Ano***r", "wager": 9876.54, "prize": 300}
  ],
  "structure": {
    "column_order": "prize_before_wager" or "wager_before_prize" or "unknown",
    "has_podium": true/false,
    "podium_count": 3,
    "list_entries_visible": 7
  },
  "confidence": 85,
  "notes": "Any issues or observations"
}`;

async function captureScreenshot(page, siteName) {
  const debugDir = path.join(__dirname, 'debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  const screenshotPath = path.join(debugDir, `vision-test-${siteName}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  return screenshotPath;
}

async function analyzeWithClaudeVision(screenshotPath, siteName) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64Image = imageData.toString('base64');

  console.log(`\n🔍 Analyzing ${siteName} with Claude Vision...`);

  const startTime = Date.now();

  const response = await callClaude({
    systemPrompt: EXTRACTION_PROMPT,
    userMessage: 'Extract all leaderboard entries from this screenshot.',
    basePath: __dirname,
    domain: siteName,
    imageBase64: base64Image,
    maxTokens: 2000
  });

  const elapsed = Date.now() - startTime;
  console.log(`   ⏱️  Took ${elapsed}ms`);

  return {
    response: response.content,
    elapsed,
    usage: response.usage,
    success: response.success,
    error: response.error
  };
}

async function runTest() {
  console.log('🚀 Claude Vision OCR Test - Leaderboard Data Extraction');
  console.log('=' .repeat(60));

  // Check if LLM is available
  if (!isLLMAvailable()) {
    console.log('❌ LLM not available. Make sure ANTHROPIC_API_KEY is set.');
    console.log('   Run: export ANTHROPIC_API_KEY=your-key-here');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const results = [];

  for (const site of TEST_SITES) {
    console.log(`\n📸 Capturing ${site.name}...`);

    try {
      const page = await context.newPage();
      await page.goto(site.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      // If we need to click a tab
      if (site.clickTab) {
        try {
          const selectors = [
            `img[src*="${site.clickTab}"]`,
            `[class*="${site.clickTab}"]`,
            `button:has-text("${site.clickTab}")`,
            `div:has-text("${site.clickTab}")`
          ];
          for (const sel of selectors) {
            try {
              await page.click(sel, { timeout: 2000 });
              console.log(`   ✅ Clicked tab: ${site.clickTab}`);
              await page.waitForTimeout(2000);
              break;
            } catch (e) {
              continue;
            }
          }
        } catch (e) {
          console.log(`   ⚠️  Could not click tab: ${site.clickTab}`);
        }
      }

      // Scroll to see more entries
      await page.evaluate(() => window.scrollBy(0, 300));
      await page.waitForTimeout(500);

      const screenshotPath = await captureScreenshot(page, site.name);
      console.log(`   ✅ Screenshot: ${path.basename(screenshotPath)}`);

      // Analyze with Claude Vision
      const analysis = await analyzeWithClaudeVision(screenshotPath, site.name);

      if (!analysis.success) {
        console.log(`   ❌ API Error: ${analysis.error}`);
        results.push({
          site: site.name,
          url: site.url,
          success: false,
          error: analysis.error
        });
        await page.close();
        continue;
      }

      // Parse response
      let parsed = null;
      try {
        let jsonStr = analysis.response;
        if (jsonStr.includes('```')) {
          jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        }
        parsed = JSON.parse(jsonStr.trim());
      } catch (e) {
        console.log(`   ⚠️  Failed to parse JSON`);
        console.log(`   Raw: ${analysis.response?.substring(0, 300)}...`);
      }

      results.push({
        site: site.name,
        url: site.url,
        success: parsed !== null,
        entries: parsed?.entries?.length || 0,
        structure: parsed?.structure || null,
        confidence: parsed?.confidence || 0,
        elapsed: analysis.elapsed,
        cost: analysis.usage?.cost || 0,
        sampleEntries: parsed?.entries?.slice(0, 5) || [],
        notes: parsed?.notes || null
      });

      if (parsed) {
        console.log(`   📊 Extracted ${parsed.entries?.length || 0} entries`);
        console.log(`   📐 Column order: ${parsed.structure?.column_order || 'unknown'}`);
        console.log(`   💯 Confidence: ${parsed.confidence}%`);

        if (parsed.entries?.length > 0) {
          console.log(`   📝 Sample entries:`);
          parsed.entries.slice(0, 3).forEach(e => {
            console.log(`      #${e.rank}: ${e.username} - wager: $${e.wager?.toLocaleString()}, prize: $${e.prize}`);
          });
        }
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
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));

  const successful = results.filter(r => r.success);
  const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0);
  const totalTime = results.reduce((sum, r) => sum + (r.elapsed || 0), 0);
  const totalEntries = successful.reduce((sum, r) => sum + r.entries, 0);
  const avgConfidence = successful.length > 0
    ? (successful.reduce((sum, r) => sum + r.confidence, 0) / successful.length).toFixed(1)
    : 0;

  console.log(`\n✅ Successful: ${successful.length}/${results.length} sites`);
  console.log(`📝 Total entries extracted: ${totalEntries}`);
  console.log(`💯 Average confidence: ${avgConfidence}%`);
  console.log(`⏱️  Total time: ${(totalTime / 1000).toFixed(1)}s (${(totalTime / results.length / 1000).toFixed(1)}s per site)`);
  console.log(`💰 Total cost: $${totalCost.toFixed(4)}`);

  console.log('\n📋 Per-site results:');
  results.forEach(r => {
    const status = r.success ? '✅' : '❌';
    const info = r.success
      ? `${r.entries} entries, ${r.confidence}% conf, $${r.cost?.toFixed(4) || '0'}`
      : r.error?.substring(0, 50);
    console.log(`   ${status} ${r.site}: ${info}`);
  });

  // Save results
  const debugDir = path.join(__dirname, 'debug');
  const resultsPath = path.join(debugDir, 'vision-test-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Full results saved to: ${resultsPath}`);

  // Comparison with what our scraper got
  console.log('\n' + '='.repeat(60));
  console.log('🔬 COMPARISON: Claude Vision vs Current Scraper');
  console.log('='.repeat(60));

  for (const r of successful) {
    const scrapedPath = path.join(__dirname, 'results', 'current', `${r.site.split('-')[0]}.json`);
    if (fs.existsSync(scrapedPath)) {
      try {
        const scraped = JSON.parse(fs.readFileSync(scrapedPath, 'utf8'));
        const firstLb = scraped.results?.[0];
        if (firstLb) {
          console.log(`\n${r.site}:`);
          console.log(`   Vision: ${r.entries} entries, ${r.structure?.column_order || 'unknown'} column order`);
          console.log(`   Scraper: ${firstLb.entries?.length || 0} entries`);

          // Compare first 3 entries
          if (r.sampleEntries?.length > 0 && firstLb.entries?.length > 0) {
            console.log(`   Vision #1: ${r.sampleEntries[0]?.username} - wager: ${r.sampleEntries[0]?.wager}`);
            console.log(`   Scraper #1: ${firstLb.entries[0]?.username} - wager: ${firstLb.entries[0]?.wager}`);
          }
        }
      } catch (e) {
        // Ignore comparison errors
      }
    }
  }
}

runTest().catch(console.error);
