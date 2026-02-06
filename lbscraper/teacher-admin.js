#!/usr/bin/env node
/**
 * Teacher Mode Admin CLI
 * 
 * Utility for managing LLM Teacher Mode settings, profiles, and costs.
 * 
 * Usage:
 *   node teacher-admin.js status              # Show overall status
 *   node teacher-admin.js usage               # Show LLM usage/costs
 *   node teacher-admin.js flagged             # List flagged sites
 *   node teacher-admin.js profiles            # List all profiles
 *   node teacher-admin.js profile <domain>    # Show specific profile
 *   node teacher-admin.js reset <domain>      # Reset site for re-verification
 *   node teacher-admin.js reset-usage         # Reset usage data (careful!)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  getAllProfiles,
  getProfilesByStatus,
  getFlaggedSites,
  getSiteProfile,
  resetSiteForLLM,
  getUsageSummary,
  resetUsageData,
  getLimits,
  isLLMAvailable,
  isTeacherModeEnabled,
  PROFILE_STATUSES
} = require('./shared/teacher');

const BASE_PATH = __dirname;

// ============================================================================
// COMMANDS
// ============================================================================

async function showStatus() {
  console.log('\n📊 TEACHER MODE STATUS\n');
  console.log('='.repeat(50));
  
  // Check configuration
  console.log('\n⚙️  Configuration:');
  console.log(`   Enabled: ${isTeacherModeEnabled() ? '✅ Yes' : '❌ No'}`);
  console.log(`   LLM Available: ${isLLMAvailable() ? '✅ Yes' : '❌ No (SDK or API key missing)'}`);
  
  const limits = getLimits();
  console.log(`   Max Attempts: ${limits.maxAttempts || 3}`);
  console.log(`   Min Confidence: ${limits.minConfidence || 80}%`);
  console.log(`   Monthly Budget: $${limits.monthlyBudgetUsd.toFixed(2)}`);
  
  // Profile summary
  const profiles = getAllProfiles(BASE_PATH);
  console.log(`\n📋 Profiles: ${profiles.length} total`);
  
  const byStatus = {};
  for (const p of profiles) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  }
  
  for (const [status, count] of Object.entries(byStatus)) {
    const icon = status === 'verified' ? '✅' : status === 'flagged_for_review' ? '🚩' : '📝';
    console.log(`   ${icon} ${status}: ${count}`);
  }
  
  // Usage summary
  const usage = getUsageSummary(BASE_PATH);
  console.log(`\n💰 This Month's Usage:`);
  console.log(`   Cost: ${usage.totalCost} / ${usage.budget} (${usage.budgetUsedPercent})`);
  console.log(`   API Calls: ${usage.totalCalls} (${usage.todayCalls} today)`);
  console.log(`   Tokens: ${usage.tokensInput.toLocaleString()} input, ${usage.tokensOutput.toLocaleString()} output`);
  
  console.log('\n');
}

async function showUsage() {
  console.log('\n💰 LLM USAGE DETAILS\n');
  console.log('='.repeat(50));
  
  const usage = getUsageSummary(BASE_PATH);
  
  console.log(`\n📅 Month: ${usage.month}`);
  console.log(`   Total Cost: ${usage.totalCost}`);
  console.log(`   Budget: ${usage.budget}`);
  console.log(`   Remaining: ${usage.budgetRemaining}`);
  console.log(`   Used: ${usage.budgetUsedPercent}`);
  
  console.log(`\n📊 API Calls:`);
  console.log(`   Total: ${usage.totalCalls}`);
  console.log(`   Today: ${usage.todayCalls} / ${usage.dailyLimit} limit`);
  
  console.log(`\n🔤 Tokens:`);
  console.log(`   Input: ${usage.tokensInput.toLocaleString()}`);
  console.log(`   Output: ${usage.tokensOutput.toLocaleString()}`);
  
  if (usage.topSites && usage.topSites.length > 0) {
    console.log(`\n🌐 Top Sites by Usage:`);
    for (const site of usage.topSites) {
      console.log(`   ${site.site}: ${site.calls} calls`);
    }
  }
  
  console.log('\n');
}

async function listFlagged() {
  console.log('\n🚩 FLAGGED SITES\n');
  console.log('='.repeat(50));
  
  const flagged = getFlaggedSites(BASE_PATH);
  
  if (flagged.length === 0) {
    console.log('\n✅ No flagged sites!\n');
    return;
  }
  
  console.log(`\n${flagged.length} site(s) flagged for manual review:\n`);
  
  for (const site of flagged) {
    console.log(`🔴 ${site.domain}`);
    console.log(`   Reason: ${site.reason}`);
    console.log(`   Flagged: ${site.flaggedAt}`);
    console.log('');
  }
  
  console.log('To reset a site: node teacher-admin.js reset <domain>\n');
}

async function listProfiles() {
  console.log('\n📋 ALL SITE PROFILES\n');
  console.log('='.repeat(50));
  
  const profiles = getAllProfiles(BASE_PATH);
  
  if (profiles.length === 0) {
    console.log('\n⚪ No profiles yet.\n');
    return;
  }
  
  // Group by status
  const grouped = {};
  for (const p of profiles) {
    if (!grouped[p.status]) grouped[p.status] = [];
    grouped[p.status].push(p);
  }
  
  for (const status of Object.values(PROFILE_STATUSES)) {
    const sites = grouped[status] || [];
    if (sites.length === 0) continue;
    
    const icon = status === 'verified' ? '✅' : 
                 status === 'flagged_for_review' ? '🚩' :
                 status === 'learning' ? '📚' : '⚪';
    
    console.log(`\n${icon} ${status.toUpperCase()} (${sites.length}):`);
    
    for (const site of sites) {
      const conf = site.verification?.llmConfidence || 0;
      const attempts = site.attempts || 0;
      console.log(`   • ${site.domain} (attempts: ${attempts}, conf: ${conf}%)`);
    }
  }
  
  console.log('\n');
}

async function showProfile(domain) {
  console.log(`\n📋 PROFILE: ${domain}\n`);
  console.log('='.repeat(50));
  
  const profile = getSiteProfile(BASE_PATH, domain);
  
  console.log(`\nStatus: ${profile.status}`);
  console.log(`Attempts: ${profile.attempts} / ${profile.maxAttempts}`);
  console.log(`LLM Disabled: ${profile.llmDisabled ? 'Yes' : 'No'}`);
  console.log(`LLM Cost Total: $${(profile.llmCostTotal || 0).toFixed(4)}`);
  
  if (profile.verification.verifiedByLlm) {
    console.log(`\nVerification:`);
    console.log(`   Confidence: ${profile.verification.llmConfidence}%`);
    console.log(`   First Verified: ${profile.verification.firstVerifiedAt}`);
    console.log(`   Last Verified: ${profile.verification.lastVerifiedAt}`);
  }
  
  if (profile.switchers && profile.switchers.length > 0) {
    console.log(`\nSwitchers (${profile.switchers.length}):`);
    for (const sw of profile.switchers) {
      console.log(`   • ${sw.name} (${sw.clickStrategy || 'auto'})`);
    }
  }
  
  if (profile.llmObservations && profile.llmObservations.length > 0) {
    console.log(`\nLLM Observations:`);
    for (const obs of profile.llmObservations.slice(-5)) {
      console.log(`   • ${obs.text || obs}`);
    }
  }
  
  console.log(`\nCreated: ${profile.createdAt}`);
  console.log(`Updated: ${profile.updatedAt}`);
  console.log('\n');
}

async function resetSite(domain) {
  console.log(`\n🔄 Resetting ${domain} for LLM re-verification...\n`);
  
  resetSiteForLLM(BASE_PATH, domain);
  
  console.log('✅ Site reset successfully!');
  console.log('   - Status set to "learning"');
  console.log('   - Attempts reset to 0');
  console.log('   - LLM re-enabled');
  console.log('   - Removed from flagged list (if present)');
  console.log('\n');
}

async function resetUsage() {
  console.log('\n⚠️  WARNING: This will reset all usage data for the current month!\n');
  
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question('Type "CONFIRM" to proceed: ', (answer) => {
    if (answer === 'CONFIRM') {
      resetUsageData(BASE_PATH);
      console.log('\n✅ Usage data reset!\n');
    } else {
      console.log('\n❌ Cancelled.\n');
    }
    rl.close();
  });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'status':
      await showStatus();
      break;
      
    case 'usage':
      await showUsage();
      break;
      
    case 'flagged':
      await listFlagged();
      break;
      
    case 'profiles':
      await listProfiles();
      break;
      
    case 'profile':
      if (!args[1]) {
        console.log('Usage: node teacher-admin.js profile <domain>');
        process.exit(1);
      }
      await showProfile(args[1]);
      break;
      
    case 'reset':
      if (!args[1]) {
        console.log('Usage: node teacher-admin.js reset <domain>');
        process.exit(1);
      }
      await resetSite(args[1]);
      break;
      
    case 'reset-usage':
      await resetUsage();
      break;
      
    default:
      console.log(`
Teacher Mode Admin CLI

Commands:
  status              Show overall Teacher Mode status
  usage               Show LLM usage and costs
  flagged             List sites flagged for manual review
  profiles            List all site profiles
  profile <domain>    Show details for specific domain
  reset <domain>      Reset site for LLM re-verification
  reset-usage         Reset usage data (use with caution)

Example:
  node teacher-admin.js status
  node teacher-admin.js reset example.com
      `);
  }
}

main().catch(console.error);
