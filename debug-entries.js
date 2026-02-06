const fs = require('fs');

const data = JSON.parse(fs.readFileSync('lbscraper/results/current/wrewards.com.json'));

console.log('Checking all entries for problematic characters...\n');

data.results.forEach((lb, i) => {
  console.log(`Leaderboard: ${lb.name} - ${lb.entries?.length} entries`);

  lb.entries?.forEach((e, j) => {
    const username = e.username || '';

    // Check for backslash-x patterns
    if (username.includes('\\x') || username.includes('\\X')) {
      console.log(`  FOUND backslash-x at entry ${j}: "${username}"`);
    }

    // Check for actual control characters (bytes 0-31)
    for (let k = 0; k < username.length; k++) {
      const code = username.charCodeAt(k);
      if (code < 32 || code === 127) {
        console.log(`  FOUND control char at entry ${j}, pos ${k}: code=${code}, username="${username}"`);
        break;
      }
    }

    // Check if the stringified version contains \x
    const stringified = JSON.stringify(e);
    if (stringified.match(/\\x[0-9a-fA-F]/i)) {
      console.log(`  FOUND in JSON at entry ${j}: username="${username}"`);
      console.log(`    Raw JSON around pos 970-1000: ${stringified.substring(970, 1010)}`);
    }
  });
});

console.log('\nDone.');
