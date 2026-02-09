#!/usr/bin/env node
/**
 * Print the latest batch report to the terminal.
 * Run after: node new-run-scraper.js --batch --limit 50
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  console.log('No data directory yet. Run a batch first: node new-run-scraper.js --batch --limit 50');
  process.exit(1);
}

const files = fs.readdirSync(dataDir).filter(f => f.startsWith('batch-report-') && f.endsWith('.txt'));
if (files.length === 0) {
  const summaryPath = path.join(dataDir, 'batch-summary.json');
  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    console.log('\n' + '═'.repeat(60));
    console.log('BATCH SUMMARY (batch-report-*.txt not found; showing summary only)');
    console.log('═'.repeat(60));
    console.log(`Total: ${summary.totalUrls} | Success: ${summary.successful} | Failed: ${summary.failed} | Timed Out: ${summary.timedOut}`);
    console.log(`Leaderboards: ${summary.totalLeaderboards} | Time: ${summary.elapsedFormatted}`);
    console.log('═'.repeat(60) + '\n');
  } else {
    console.log('No batch report or summary found. Run: node new-run-scraper.js --batch --limit 50');
  }
  process.exit(0);
}

const latest = files.sort().reverse()[0];
const reportPath = path.join(dataDir, latest);
console.log(fs.readFileSync(reportPath, 'utf8'));
