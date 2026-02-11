/**
 * XPath Extraction Strategy (Scalable Scraper Architecture)
 *
 * Uses per-site XPath config from site-xpaths.json for accurate extraction.
 * Runs before other strategies when config exists. Priority 0.5.
 */

const { log, parseNum } = require('../shared/utils');
const { getXPathConfig } = require('../shared/site-xpaths');
const path = require('path');

const strategy = {
  name: 'xpath',
  priority: 0.5,

  canExtract(input) {
    if (!input.page) return false;
    const domain = input._domain || (input.page && input.page.url && new URL(input.page.url()).hostname);
    const basePath = input._basePath || path.join(__dirname, '..');
    return getXPathConfig(basePath, domain, input.siteName) != null;
  },

  async extract(input) {
    const { page, siteName } = input;
    const domain = input._domain || (page && page.url ? new URL(page.url()).hostname : '');
    const basePath = input._basePath || path.join(__dirname, '..');

    const config = getXPathConfig(basePath, domain, siteName);
    if (!config) return null;

    log('XPATH-EXTRACT', `Using XPath config for ${domain}/${siteName || 'default'}`);

    try {
      const entries = await page.evaluate((cfg) => {
        const xpath = (expr, context = document) => {
          const r = document.evaluate(expr, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const nodes = [];
          for (let i = 0; i < r.snapshotLength; i++) nodes.push(r.snapshotItem(i));
          return nodes;
        };

        const parseNumInBrowser = (str) => {
          if (!str || typeof str === 'number') return typeof str === 'number' ? str : 0;
          let s = String(str).trim().replace(/[$€£¥₹฿₿◆♦\s]/g, '');
          let mult = 1;
          if (/m$/i.test(s)) { mult = 1000000; s = s.replace(/m$/i, ''); }
          else if (/k$/i.test(s)) { mult = 1000; s = s.replace(/k$/i, ''); }
          s = s.replace(/,/g, '');
          const num = parseFloat(s);
          return isNaN(num) ? 0 : num * mult;
        };

        const rankCol = cfg.rankCol ?? 0;
        const usernameCol = cfg.usernameCol ?? 1;
        const wagerCol = cfg.wagerCol ?? 2;
        const prizeCol = cfg.prizeCol ?? 3;

        const tables = xpath(cfg.table || '//table');
        const results = [];

        for (const table of tables) {
          const rows = xpath(cfg.rows || './/tbody/tr | .//tr[td]', table);
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;

            const getCell = (col) => {
              const c = cells[col];
              return c ? (c.innerText || '').trim() : '';
            };

            const rankStr = getCell(rankCol);
            const username = getCell(usernameCol);
            const wagerStr = getCell(wagerCol);
            const prizeStr = getCell(prizeCol);

            let rank = 0;
            const rankMatch = rankStr.match(/^#?(\d+)/);
            if (rankMatch) rank = parseInt(rankMatch[1], 10);
            else if (/^\d+$/.test(rankStr)) rank = parseInt(rankStr, 10);

            if (!username || username.length < 2 || /^(rank|place|#|user|wager|prize|reward)$/i.test(username)) continue;
            if (/^[\d,.$€£\s]+$/.test(username)) continue;

            const wager = parseNumInBrowser(wagerStr);
            const prize = parseNumInBrowser(prizeStr);

            if (wager === 0 && prize === 0 && !rank) continue;

            results.push({ rank: rank || results.length + 1, username, wager, prize });
          }
        }

        return results;
      }, config);

      if (entries && entries.length >= 2) {
        const sorted = [...entries].sort((a, b) => a.rank - b.rank);
        const confidence = Math.min(95, 70 + sorted.length * 2);
        log('XPATH-EXTRACT', `Extracted ${sorted.length} entries via XPath (${confidence}% confidence)`);
        return {
          entries: sorted,
          prizes: [],
          confidence,
          metadata: { method: 'xpath', domain, siteName }
        };
      }

      log('XPATH-EXTRACT', `XPath returned ${entries?.length || 0} entries, not enough`);
      return null;
    } catch (e) {
      log('XPATH-EXTRACT', `XPath extraction error: ${e.message}`);
      return null;
    }
  }
};

module.exports = { strategy };
