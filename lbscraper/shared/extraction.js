/**
 * Extraction Module for Leaderboard Scraper
 * 
 * Handles DOM extraction, geometric detection, and OCR fallback
 */

const Tesseract = require('tesseract.js');
const TurndownService = require('turndown');
const fs = require('fs');
const path = require('path');
const { log, parseNum, validateUsername, cleanUsername, isUIText } = require('./utils');

// ============================================================================
// DOM EXTRACTION
// ============================================================================

/**
 * Scrape leaderboard data from DOM containers
 * @param {Page} page - Playwright page instance
 * @returns {Array} - Array of entry objects
 */
async function scrapeDOMLeaderboard(page) {
  log('DOM', 'Starting DOM extraction...');
  
  const data = await page.evaluate(() => {
    function isGarbageEntry(str) {
      if (!str || str.length < 2 || str.length > 30) return true;
      
      const lower = str.toLowerCase().trim();
      const garbageWords = [
        'other', 'leaders', 'total', 'prize', 'pool', 'bonus', 'bonuses',
        'all', 'view', 'more', 'remaining', 'wagered', 'reward', 'rewards',
        'leaderboard', 'leaderboards', 'rank', 'status', 'active', 'inactive',
        'tournament', 'tournaments', 'free', 'login', 'register', 'browse',
        'join', 'enter', 'vip', 'premium', 'loading', 'home', 'menu',
        'history', 'past', 'results', 'competition', 'race', 'challenge',
        'gamdom', 'packdraw', 'shuffle', 'stake', 'roobet', 'rollbit',
        'csgoroll', 'clash', 'hypedrop', 'csgopolygon',
        'raffles', 'raffle', 'shop', 'store', 'points', 'games', 'game',
        'slots', 'slot', 'casino', 'sports', 'news', 'blog', 'faq',
        'support', 'contact', 'help', 'chat', 'discord', 'twitter',
        'telegram', 'facebook', 'instagram', 'youtube', 'twitch'
      ];
      
      if (garbageWords.includes(lower)) return true;
      if (/^other\s+(leaders?|players?)/i.test(str)) return true;
      if (/^total\s+(prize|pool|wager)/i.test(str)) return true;
      if (/^all\s+(bonus|rewards?)/i.test(str)) return true;
      if (/^prize\s*pool$/i.test(str)) return true;
      if (/^on\s+[a-z]+\.?$/i.test(str)) return true;
      if (/^view\s+history$/i.test(str)) return true;
      if (/^show\s+more$/i.test(str)) return true;
      if (/bonuses?$/i.test(str)) return true;
      if (/^points\s+shop$/i.test(str)) return true;
      if (/^[$€£]?\s*[\d,]+\.?\d*$/.test(str)) return true;
      
      return false;
    }
    
    function parseNumInBrowser(str) {
      if (!str) return 0;
      if (typeof str === 'number') return str;
      let s = str.toString().trim();
      s = s.replace(/[$€£¥₹฿₿◆♦\s]/g, '');
      let mult = 1;
      if (/m$/i.test(s)) { mult = 1000000; s = s.replace(/m$/i, ''); }
      else if (/k$/i.test(s)) { mult = 1000; s = s.replace(/k$/i, ''); }
      if (s.includes(',') && s.includes('.')) {
        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        if (lastDot > lastComma) s = s.replace(/,/g, '');
        else s = s.replace(/\./g, '').replace(',', '.');
      } else if (s.includes(',')) {
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length <= 2) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
      }
      const num = parseFloat(s);
      return isNaN(num) ? 0 : num * mult;
    }
    
    function extractFromContainer(container) {
      const text = container.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      
      let username = null;
      let wager = 0;
      let prize = 0;
      let rank = 0;
      const moneyAmounts = [];  // Fallback for unlabeled numbers
      let lastLabel = null;     // Track: 'wager' | 'prize' | null
      let lastUnlabeledAmount = null;  // Track the last unlabeled amount for backward label assignment
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const upperLine = line.toUpperCase();
        
        // Track wager labels - the NEXT number after this is the wager value
        if (['WAGERED', 'WAGER'].includes(upperLine)) {
          lastLabel = 'wager';
          continue;
        }
        
        // Track prize labels - can come AFTER the value on sites like qeeetzr.com
        // Check if there's a pending unlabeled amount that should be assigned as prize
        if (['PRIZE', 'REWARD', 'BONUS'].includes(upperLine)) {
          if (prize === 0 && lastUnlabeledAmount !== null) {
            // Label came AFTER the value - assign the previous unlabeled amount
            prize = lastUnlabeledAmount;
            // Remove it from moneyAmounts if it was added there
            const idx = moneyAmounts.indexOf(lastUnlabeledAmount);
            if (idx > -1) moneyAmounts.splice(idx, 1);
            lastUnlabeledAmount = null;
          } else {
            lastLabel = 'prize';
          }
          continue;
        }
        
        // Skip other UI labels that aren't useful
        if (['ACTIVE', 'STATUS', 'USER', 'RANK', 'POSITION'].includes(upperLine)) {
          continue;
        }
        
        // Handle Roman numerals for rank
        if (/^[IVX]+$/.test(line)) {
          const romanMap = {'I':1, 'II':2, 'III':3, 'IV':4, 'V':5, 'VI':6, 'VII':7, 'VIII':8, 'IX':9, 'X':10};
          if (romanMap[line]) rank = romanMap[line];
          continue;
        }
        
        // Handle numeric rank (e.g., "#1", "1st", "2nd")
        const rankMatch = line.match(/^#?(\d+)(?:st|nd|rd|th)?$/i);
        if (rankMatch && parseInt(rankMatch[1]) <= 20) {
          rank = parseInt(rankMatch[1]);
          continue;
        }
        
        // Handle currency symbol alone ($ on its own line) - look ahead for number
        if (/^[$€£◆♦]$/.test(line)) {
          // Next line should be the number
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            // Handle space-separated numbers like "11 781" or "17 474"
            const cleanedNumber = nextLine.replace(/\s/g, '').replace(/,/g, '');
            const amount = parseNumInBrowser(cleanedNumber);
            if (amount > 0) {
              if (lastLabel === 'wager') {
                wager = amount;
                lastLabel = null;
                lastUnlabeledAmount = null;
              } else if (lastLabel === 'prize') {
                prize = amount;
                lastLabel = null;
                lastUnlabeledAmount = null;
              } else {
                moneyAmounts.push(amount);
                lastUnlabeledAmount = amount;
              }
              i++; // Skip the number line since we processed it
            }
          }
          continue;
        }
        
        // Handle money amounts - assign based on which label preceded this number
        // Also handle space-separated numbers like "11 781"
        const cleanedLine = line.replace(/\s(?=\d)/g, ''); // Remove spaces before digits
        if (/^[$◆♦€£]?\s*[\d,.]+/.test(cleanedLine) || /^[\d,]+\.?\d*$/.test(cleanedLine)) {
          const amount = parseNumInBrowser(cleanedLine);
          if (amount > 0) {
            if (lastLabel === 'wager') {
              wager = amount;
              lastLabel = null;  // Reset after assignment
              lastUnlabeledAmount = null;
            } else if (lastLabel === 'prize') {
              prize = amount;
              lastLabel = null;  // Reset after assignment
              lastUnlabeledAmount = null;
            } else {
              // No label preceded this number - add to fallback bucket
              // Also track as last unlabeled for backward label assignment
              moneyAmounts.push(amount);
              lastUnlabeledAmount = amount;
            }
          }
          continue;
        }
        
        // Handle username extraction
        if (!username && !isGarbageEntry(line)) {
          const hasLetterOrAsterisk = /[a-zA-Z*]/.test(line);
          if (hasLetterOrAsterisk) {
            let cleaned = line.replace(/^RANK[_\s]*\d+\s*/i, '');
            cleaned = cleaned.replace(/^\d+[.)\s]+/, '').trim();
            
            if (cleaned.length >= 2 && cleaned.length <= 30 && !isGarbageEntry(cleaned)) {
              username = cleaned;
            }
          }
        }
      }
      
      // Fallback: If labels didn't provide values, use size-based assignment
      // (Largest number = wager, second largest = prize)
      // Only sort if we need to use the fallback
      if ((wager === 0 || prize === 0) && moneyAmounts.length >= 1) {
        moneyAmounts.sort((a, b) => b - a);
        
        if (wager === 0 && moneyAmounts.length >= 1) {
          wager = moneyAmounts[0];
        }
        if (prize === 0 && moneyAmounts.length >= 2) {
          prize = moneyAmounts[1];
        }
        // Special case: wager already set (via label) but prize is 0 with 1 unlabeled amount
        // This unlabeled amount is likely the prize
        if (wager > 0 && prize === 0 && moneyAmounts.length === 1) {
          // Only assign if the amount is smaller than wager (prizes are typically smaller)
          if (moneyAmounts[0] < wager) {
            prize = moneyAmounts[0];
          }
        }
      }
      
      return { username, wager, prize, rank };
    }
    
    function extractPodiumCards() {
      const podiumEntries = [];
      
      // Method 1: Try class-based selectors first
      const winnerCardSelectors = [
        '[class*="WinnerCard"]',
        '[class*="winner-card"]',
        '[class*="winnercard"]',
        '[class*="Winner"][class*="Card"]',
        '[class*="place-1"], [class*="place-2"], [class*="place-3"]',
        '[class*="podium"]',
        '[class*="top-3"]',
        '[class*="top3"]'
      ];
      
      for (const selector of winnerCardSelectors) {
        try {
          const cards = document.querySelectorAll(selector);
          if (cards.length >= 3) {
            const extracted = [];
            for (const card of cards) {
              const result = extractFromContainer(card);
              if (result.username && result.wager > 0) {
                extracted.push(result);
              }
            }
            if (extracted.length >= 3) {
              extracted.sort((a, b) => b.wager - a.wager);
              for (let i = 0; i < Math.min(extracted.length, 3); i++) {
                extracted[i].rank = i + 1;
                extracted[i].source = 'dom-podium';
                podiumEntries.push(extracted[i]);
              }
              if (podiumEntries.length >= 3) return podiumEntries;
            }
          }
        } catch (e) {}
      }
      
      // Method 2: Find containers by content pattern (WAGERED + REWARD)
      // This handles React/Tailwind sites like qeeetzr.com
      if (podiumEntries.length < 3) {
        try {
          // Find all elements containing "WAGERED" text
          const allElements = document.querySelectorAll('div, section, article');
          const podiumCandidates = [];
          
          for (const el of allElements) {
            const text = el.innerText || '';
            const hasWageredLabel = /\bWAGERED\b/i.test(text);
            const hasRewardLabel = /\bREWARD\b/i.test(text);
            // Count dollar signs and numbers separately (they may be on different lines)
            const dollarCount = (text.match(/\$/g) || []).length;
            // Count numbers that look like amounts (3+ digits, may have spaces/commas but NOT newlines)
            // Use [ ,] instead of \s to avoid matching across newlines
            const numberMatches = text.match(/\d[\d ,]{2,}/g) || [];
            // Accept either: 2+ dollar signs with numbers, OR just 2+ numbers (some sites don't use $)
            const hasAmounts = (dollarCount >= 2 && numberMatches.length >= 2) || numberMatches.length >= 2;
            
            // Must have WAGERED label, REWARD label, and at least 2 amounts
            if (hasWageredLabel && hasRewardLabel && hasAmounts) {
              const rect = el.getBoundingClientRect();
              // Podium cards are typically 100-400px wide and 150-500px tall
              if (rect.width >= 80 && rect.width <= 500 && rect.height >= 100 && rect.height <= 600) {
                // Make sure this isn't a parent container of other candidates
                const textLen = text.length;
                if (textLen < 500) { // Individual card, not the whole section
                  podiumCandidates.push({ el, rect, text });
                }
              }
            }
          }
          
          // Filter to get exactly 3 non-overlapping cards
          const uniqueCards = [];
          for (const candidate of podiumCandidates) {
            // Check if this candidate overlaps with any already selected
            const overlaps = uniqueCards.some(existing => {
              const r1 = candidate.rect;
              const r2 = existing.rect;
              return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
            });
            
            if (!overlaps) {
              uniqueCards.push(candidate);
            }
          }
          
          // Extract data from the top 3 cards (sorted by x position for left-to-right order)
          uniqueCards.sort((a, b) => a.rect.x - b.rect.x);
          
          for (const card of uniqueCards.slice(0, 3)) {
            const result = extractFromContainer(card.el);
            if (result.username && result.wager > 0) {
              result.source = 'dom-podium-pattern';
              podiumEntries.push(result);
            }
          }
          
          // Sort by wager (highest first) and assign ranks
          if (podiumEntries.length >= 2) {
            podiumEntries.sort((a, b) => b.wager - a.wager);
            for (let i = 0; i < podiumEntries.length; i++) {
              podiumEntries[i].rank = i + 1;
            }
          }
        } catch (e) {
          console.log('[PODIUM-DEBUG] Pattern matching error:', e.message);
        }
      }
      
      return podiumEntries;
    }
    
    const CONTAINER_SELECTORS = [
      '[class*="entry"]', '[class*="row"]', '[class*="item"]',
      '[class*="player"]', '[class*="card"]', '[class*="user"]',
      '[class*="rank"]', '[class*="leader"]', 'tr', 'li'
    ].join(', ');
    
    const entries = [];
    // Use username+wager as key to allow same usernames with different wagers (e.g., multiple "Anonymous" users)
    const seenEntries = new Set();
    const processedContainers = new Set();
    
    const podiumEntries = extractPodiumCards();
    for (const entry of podiumEntries) {
      // Key: username + wager (allows same username with different wagers)
      const entryKey = `${entry.username.toLowerCase()}|${Math.round(entry.wager)}`;
      if (!seenEntries.has(entryKey)) {
        seenEntries.add(entryKey);
        entries.push(entry);
      }
    }
    
    const potentialUserElements = document.querySelectorAll('span, div, td, p');
    
    // Debug: track extraction stats
    const debugStats = { 
      totalElements: 0, 
      tooShort: 0, 
      tooLong: 0, 
      garbage: 0, 
      noContainer: 0, 
      duplicateContainer: 0,
      containerTooLong: 0,
      containerTooShort: 0,
      navLink: 0,
      noWager: 0,
      duplicateEntry: 0,
      extracted: 0
    };
    
    for (const el of potentialUserElements) {
      const text = (el.textContent || '').trim();
      debugStats.totalElements++;
      
      if (text.length < 2) { debugStats.tooShort++; continue; }
      if (text.length > 30) { debugStats.tooLong++; continue; }
      if (isGarbageEntry(text)) { debugStats.garbage++; continue; }
      
      const container = el.closest(CONTAINER_SELECTORS);
      if (!container) { debugStats.noContainer++; continue; }
      
      // Use a more unique container key that includes text content and position
      // This prevents skipping rows with similar HTML but different data (e.g., two "Anonymous" users)
      const containerRect = container.getBoundingClientRect();
      const containerKey = `${container.innerHTML.substring(0, 150)}|${container.innerText.substring(0, 100)}|${Math.round(containerRect.top)}`;
      if (processedContainers.has(containerKey)) { debugStats.duplicateContainer++; continue; }
      processedContainers.add(containerKey);
      
      const containerText = container.innerText || '';
      if (containerText.length > 800) { debugStats.containerTooLong++; continue; }
      // Lowered from 15 to 8 to handle short entries like "#9 | lu** | 3.20" (12 chars)
      if (containerText.length < 8) { debugStats.containerTooShort++; continue; }
      
      // Skip navigation links (e.g., "PREVIOUS LEADERBOARD", "NEXT PAGE")
      const isNavLink = container.closest('a[href]') !== null || 
                        container.querySelector('a[href*="prev"], a[href*="next"], a[href*="page"]') !== null;
      const hasNavKeywords = /\b(previous|next|back|forward|page|view all|see all)\s+(leaderboard|page|results)/i.test(containerText);
      if (isNavLink && hasNavKeywords) { debugStats.navLink++; continue; }
      
      const extracted = extractFromContainer(container);
      
      if (extracted.username && extracted.wager > 0) {
        // Key: username + wager (allows same username with different wagers, e.g., "Anonymous" users)
        const entryKey = `${extracted.username.toLowerCase()}|${Math.round(extracted.wager)}`;
        if (!seenEntries.has(entryKey)) {
          seenEntries.add(entryKey);
          entries.push({
            rank: extracted.rank,
            username: extracted.username,
            wager: extracted.wager,
            prize: extracted.prize,
            source: 'dom-container'
          });
          debugStats.extracted++;
        } else {
          debugStats.duplicateEntry++;
        }
      } else {
        debugStats.noWager++;
      }
    }
    
    // Log debug stats to console for analysis
    console.log('[DOM-DEBUG]', JSON.stringify(debugStats));
    
    // FALLBACK: If we got fewer than 10 entries, try direct text parsing
    // This handles paxgambles-style sites where the structure is simple text
    if (entries.length < 10) {
      const pageText = document.body.innerText;
      const lines = pageText.split('\n').map(l => l.trim()).filter(l => l);
      
      const textEntries = [];
      let currentEntry = null;
      let lastLabel = null;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const upperLine = line.toUpperCase();
        
        // Skip navigation and UI text
        if (upperLine.includes('PREVIOUS LEADERBOARD') || upperLine.includes('ENDING IN')) continue;
        if (upperLine === 'PLACE' || upperLine === 'USER' || upperLine === 'PRIZE') continue;
        // Note: WAGERED is handled separately below to track label state for podium entries
        
        // Detect rank like #4, #5, etc. (indicates table section)
        const rankMatch = line.match(/^#(\d+)$/);
        if (rankMatch) {
          // Push any pending entry (table entry or incomplete podium entry)
          if (currentEntry && currentEntry.username && currentEntry.wager > 0) {
            textEntries.push(currentEntry);
          }
          // Reset podium label state - we're now in table section
          lastLabel = null;
          currentEntry = { rank: parseInt(rankMatch[1]), username: null, wager: 0, prize: 0, source: 'text-parse' };
          continue;
        }
        
        // Detect "Wagered" label (podium entries) - handles both "WAGERED" and "WAGERED:"
        if (upperLine === 'WAGERED' || upperLine === 'WAGERED:') {
          lastLabel = 'wager';
          continue;
        }
        
        // Detect dollar amounts like "$ 90" or "$150" or "$239.17"
        const dollarMatch = line.match(/^\$\s*([\d,]+(?:\.\d+)?)/);
        if (dollarMatch) {
          const amount = parseFloat(dollarMatch[1].replace(/,/g, ''));
          
          if (lastLabel === 'wager') {
            // ACEBET-style podium: After "WAGERED" label, $X.XX is the wager
            // Look back for the username
            for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
              const prevLine = lines[j];
              if (prevLine && prevLine.length >= 2 && prevLine.length <= 30 && 
                  !prevLine.match(/^[\d$.,]+$/) && !['WAGERED', 'WAGERED:'].includes(prevLine.toUpperCase())) {
                currentEntry = { 
                  rank: textEntries.length + 1, 
                  username: prevLine, 
                  wager: amount, 
                  prize: 0, 
                  source: 'text-parse-podium' 
                };
                break;
              }
            }
            lastLabel = 'expecting-podium-prize';
            continue;
          } else if (lastLabel === 'expecting-podium-prize' && currentEntry) {
            // ACEBET-style podium: Second $X.XX is the prize
            currentEntry.prize = amount;
            textEntries.push(currentEntry);
            currentEntry = null;
            lastLabel = null;
            continue;
          } else if (currentEntry) {
            // Table entry: check context to determine if this is wager or prize
            if (currentEntry.wager === 0) {
              // ACEBET-style table: $X.XX after username is the wager (no prize column)
              currentEntry.wager = amount;
            } else {
              // Already have wager, this is the prize
              currentEntry.prize = amount;
            }
            // Check if next line is a plain number (diceblox table: $prize then plain wager)
            const nextLine = lines[i + 1];
            if (nextLine && nextLine.match(/^([\d,]+(?:\.\d+)?)$/)) {
              // Next line is a plain number, so this $ was likely the prize (diceblox style)
              // Swap: what we just set as wager is actually prize
              if (currentEntry.wager === amount && currentEntry.prize === 0) {
                currentEntry.prize = currentEntry.wager;
                currentEntry.wager = 0;
                lastLabel = 'expecting-wager';
              }
            }
            continue;
          }
        }
        
        // Detect wager amounts (plain numbers) - handles comma-formatted like "1,994,801.80"
        const wagerMatch = line.match(/^([\d,]+(?:\.\d+)?)$/);
        if (wagerMatch) {
          const amount = parseFloat(wagerMatch[1].replace(/,/g, ''));
          if (currentEntry && (currentEntry.wager === 0 || lastLabel === 'expecting-wager')) {
            // Table entry wager (after prize in diceblox format, or after username)
            currentEntry.wager = amount;
            lastLabel = null;
          } else if (lastLabel === 'wager') {
            // DICEBLOX-style podium: plain number is the wager - need to find the username above
            // Look back for the username
            for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
              const prevLine = lines[j];
              if (prevLine && prevLine.length >= 2 && prevLine.length <= 30 && 
                  !prevLine.match(/^[\d$.,]+$/) && !['WAGERED', 'WAGERED:'].includes(prevLine.toUpperCase())) {
                const podiumEntry = { 
                  rank: textEntries.length + 1, 
                  username: prevLine, 
                  wager: amount, 
                  prize: 0, 
                  source: 'text-parse-podium' 
                };
                // Check if next line is a prize
                const nextLine = lines[i + 1];
                if (nextLine) {
                  const nextPrize = nextLine.match(/^\$\s*([\d,]+(?:\.\d+)?)/);
                  if (nextPrize) {
                    podiumEntry.prize = parseFloat(nextPrize[1].replace(/,/g, ''));
                  }
                }
                textEntries.push(podiumEntry);
                break;
              }
            }
            lastLabel = null;
          }
          continue;
        }
        
        // Detect username (after rank)
        if (currentEntry && !currentEntry.username && line.length >= 2 && line.length <= 30) {
          if (!line.match(/^[\d$.,]+$/) && !['PLACE', 'USER', 'PRIZE', 'WAGERED', 'WAGERED:'].includes(upperLine)) {
            currentEntry.username = line;
          }
        }
      }
      
      // Push last entry if valid
      if (currentEntry && currentEntry.username && currentEntry.wager > 0) {
        textEntries.push(currentEntry);
      }
      
      // If text parsing found more entries, use those
      if (textEntries.length > entries.length) {
        return textEntries;
      }
    }
    
    return entries;
  });
  
  log('DOM', `Extracted ${data.length} entries from DOM containers`);
  return data;
}

// ============================================================================
// MARKDOWN EXTRACTION
// ============================================================================

/**
 * Convert page HTML to Markdown and extract leaderboard data
 * This provides much cleaner table parsing than DOM extraction
 * @param {Page} page - Playwright page instance
 * @returns {Array} - Array of entry objects
 */
async function scrapeMarkdownLeaderboard(page) {
  log('MARKDOWN', 'Starting Markdown extraction...');
  
  try {
    // Get page HTML content
    const html = await page.content();
    
    // Convert HTML to Markdown
    const turndown = new TurndownService({ 
      headingStyle: 'atx',
      codeBlockStyle: 'fenced'
    });
    
    // CRITICAL: Remove style and script tags - they create garbage text
    turndown.addRule('removeStyles', {
      filter: ['style', 'script', 'noscript', 'link', 'meta'],
      replacement: function () {
        return '';
      }
    });
    
    // Remove SVG elements (they produce garbage)
    turndown.addRule('removeSvg', {
      filter: 'svg',
      replacement: function () {
        return '';
      }
    });
    
    // Remove hidden elements
    turndown.addRule('removeHidden', {
      filter: function (node) {
        const style = node.getAttribute && node.getAttribute('style');
        if (style && /display\s*:\s*none/i.test(style)) return true;
        if (node.getAttribute && node.getAttribute('hidden') !== null) return true;
        return false;
      },
      replacement: function () {
        return '';
      }
    });
    
    // Keep tables - turndown handles them well
    turndown.addRule('tableCell', {
      filter: ['th', 'td'],
      replacement: function (content, node) {
        return ' ' + content.trim() + ' |';
      }
    });
    
    turndown.addRule('tableRow', {
      filter: 'tr',
      replacement: function (content, node) {
        return '|' + content + '\n';
      }
    });
    
    const markdown = turndown.turndown(html);
    
    // Parse markdown tables
    const tableEntries = parseMarkdownTables(markdown);
    log('MARKDOWN', `Found ${tableEntries.length} entries from tables`);
    
    // Parse podium-style entries (non-table format with "Wagered:" labels)
    const podiumEntries = parseMarkdownPodium(markdown);
    log('MARKDOWN', `Found ${podiumEntries.length} entries from podium`);
    
    // Parse list-style entries (non-table format like paxgambles)
    const listEntries = parseMarkdownList(markdown);
    log('MARKDOWN', `Found ${listEntries.length} entries from list`);
    
    // Parse header-style entries (### username format like yeeterboards)
    const headerEntries = parseMarkdownHeaderEntries(markdown);
    log('MARKDOWN', `Found ${headerEntries.length} entries from headers`);
    
    // Merge all entries, avoiding duplicates
    // Priority: header (highest - most structured) > podium > table > list
    const allEntries = mergeAllMarkdownEntries(headerEntries, podiumEntries, tableEntries, listEntries);
    
    log('MARKDOWN', `Total Markdown extraction: ${allEntries.length} entries`);
    return allEntries;
    
  } catch (err) {
    log('MARKDOWN', `Markdown extraction failed: ${err.message}`);
    return [];
  }
}

/**
 * Check if a row of cells looks like a header row
 * @param {Array} cells - Array of cell strings
 * @returns {boolean}
 */
function isMarkdownHeaderRow(cells) {
  const headerPatterns = [
    /^rank$/i, /^#$/i, /^pos(ition)?$/i, /^place$/i,
    /^player$/i, /^user(name)?$/i, /^name$/i,
    /^wager(ed)?$/i, /^amount$/i, /^bet$/i, /^total$/i,
    /^prize$/i, /^reward$/i, /^bonus$/i, /^win(nings)?$/i
  ];
  
  let matchCount = 0;
  for (const cell of cells) {
    for (const pattern of headerPatterns) {
      if (pattern.test(cell.trim())) {
        matchCount++;
        break;
      }
    }
  }
  
  // At least 2 header-like cells
  return matchCount >= 2;
}

/**
 * Normalize header names to standard field names
 * @param {Array} cells - Array of header cell strings
 * @returns {Array} - Array of normalized field names
 */
function normalizeMarkdownHeaders(cells) {
  return cells.map(cell => {
    const c = cell.trim().toLowerCase();
    if (/^(rank|#|pos|position|place)$/i.test(c)) return 'rank';
    if (/^(player|user|username|name)$/i.test(c)) return 'username';
    if (/^(wager|wagered|amount|bet|total)$/i.test(c)) return 'wager';
    if (/^(prize|reward|bonus|win|winnings)$/i.test(c)) return 'prize';
    return c;
  });
}

/**
 * Map table cells to an entry object based on headers
 * @param {Array} cells - Array of cell values
 * @param {Array} headers - Array of normalized header names
 * @returns {Object|null} - Entry object or null
 */
function mapMarkdownCellsToEntry(cells, headers) {
  const entry = {
    rank: 0,
    username: null,
    wager: 0,
    prize: 0,
    source: 'markdown-table'
  };
  
  // If no headers, try positional mapping (Rank, Player, Wagered, Prize)
  if (headers.length === 0 || !headers.includes('username')) {
    // Assume format: Rank | Player | Wagered | Prize
    if (cells.length >= 3) {
      const rankCell = cells[0];
      const rankMatch = rankCell.match(/(\d+)/);
      if (rankMatch) entry.rank = parseInt(rankMatch[1]);
      
      entry.username = cleanMarkdownUsername(cells[1]);
      entry.wager = parseMarkdownAmount(cells[2]);
      if (cells.length >= 4) {
        entry.prize = parseMarkdownAmount(cells[3]);
      }
    }
  } else {
    // Use headers to map
    for (let i = 0; i < cells.length && i < headers.length; i++) {
      const header = headers[i];
      const value = cells[i].trim();
      
      if (header === 'rank') {
        const rankMatch = value.match(/(\d+)/);
        if (rankMatch) entry.rank = parseInt(rankMatch[1]);
      } else if (header === 'username') {
        entry.username = cleanMarkdownUsername(value);
      } else if (header === 'wager') {
        entry.wager = parseMarkdownAmount(value);
      } else if (header === 'prize') {
        entry.prize = parseMarkdownAmount(value);
      }
    }
  }
  
  // Validate entry
  if (entry.username && entry.username.length >= 2 && entry.wager > 0) {
    return entry;
  }
  
  return null;
}

/**
 * Clean username from markdown cell
 * Handles: "### wsh\*\*\*", "**username**", "#4 player", etc.
 * IMPORTANT: Preserves censored asterisks in usernames like "ken****"
 * @param {string} text - Raw cell text
 * @returns {string} - Cleaned username
 */
function cleanMarkdownUsername(text) {
  if (!text) return null;
  let cleaned = text.trim();
  
  // FIRST: Remove backslash escapes (e.g., \*\*\* -> ***)
  // This must happen first so subsequent patterns can match
  cleaned = cleaned.replace(/\\/g, '');
  
  // Strip markdown headers (###, ##, #) - with or without space after
  // Handles: "### username", "###username", "## user"
  cleaned = cleaned.replace(/^#{1,6}\s*/, '');
  
  // Strip markdown bold/italic markers ONLY when they form complete patterns
  // DO NOT strip asterisks that could be censored username characters!
  // 
  // Safe to strip: **text** -> text, *text* -> text (balanced markers)
  // NOT safe to strip: SAF* (lone trailing asterisk = censored character)
  // 
  // Strategy: Only strip leading markers, trailing markers stay to preserve censored usernames
  // Exception: Strip trailing markers only if the text started with matching markers
  
  // Check for balanced bold (**text**)
  if (/^\*\*[^*]+\*\*$/.test(cleaned)) {
    cleaned = cleaned.slice(2, -2);
  }
  // Check for balanced italic (*text*)
  else if (/^\*[^*]+\*$/.test(cleaned)) {
    cleaned = cleaned.slice(1, -1);
  }
  // Strip only leading markdown bold/italic (preserve trailing for censored names)
  // BUT: don't strip if it would leave a very short string (likely censored username)
  // e.g., "**u" -> "u" is too short, keep as "**u" (censored username)
  else {
    const withoutLeading = cleaned.replace(/^\*{1,2}(?!\*)/, '');
    // Only strip if result is at least 2 chars (otherwise asterisks are likely censored chars)
    if (withoutLeading.length >= 2) {
      cleaned = withoutLeading;
    }
    // else: keep the asterisks (they're part of the censored username)
  }

  // Same for underscores
  if (/^__[^_]+__$/.test(cleaned)) {
    cleaned = cleaned.slice(2, -2);
  } else if (/^_[^_]+_$/.test(cleaned)) {
    cleaned = cleaned.slice(1, -1);
  } else {
    const withoutLeading = cleaned.replace(/^_{1,2}(?!_)/, '');
    if (withoutLeading.length >= 2) {
      cleaned = withoutLeading;
    }
  }
  
  // Remove leading rank indicators like "#4", "1.", "1st", "4:"
  // Be conservative: only strip if followed by clear rank separator (. ) : or space)
  // Don't strip "24/7" - the "/" indicates it's part of username, not a rank
  cleaned = cleaned.replace(/^#\d+\s*/, '');        // "#4 " or "#4"
  cleaned = cleaned.replace(/^\d+[.):\s]+/, '');    // "4. " or "4) " or "4: " or "4 "
  cleaned = cleaned.replace(/^(1st|2nd|3rd|\d+th)\s*/i, '');
  
  // Remove emoji medals
  cleaned = cleaned.replace(/^[🥇🥈🥉]\s*/, '');
  
  // Remove markdown link syntax: [text](url) -> text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  
  // Remove inline code backticks
  cleaned = cleaned.replace(/`/g, '');
  
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ');

  // Final trim
  cleaned = cleaned.trim();

  // Handle empty or quote-only usernames (e.g., "" or '' from sites that don't display username)
  // Replace with placeholder so we still capture the entry
  if (cleaned === '""' || cleaned === "''" || cleaned === '``' ||
      cleaned === '"' || cleaned === "'" || cleaned === '`' ||
      cleaned.length === 0) {
    return '[hidden]';  // Placeholder for users with no visible username
  }

  // Allow single-character usernames - some sites have users like "r", "a", etc.
  // But filter out pure punctuation or whitespace
  if (cleaned.length < 1 || cleaned.length > 50) return null;
  if (cleaned.length === 1 && !/[a-zA-Z0-9]/.test(cleaned)) return null;

  // Filter out email addresses - these are footer garbage, not usernames
  // Pattern: word@word.word (e.g., admin@onlytk.xyz)
  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleaned)) {
    return null;
  }

  // CRITICAL: Filter out UI text that slipped through (HRS, MINS, SECS, Wagered, etc.)
  // Only check if the cleaned text has NO asterisks (preserve censored usernames like "***iv2")
  const hasAsterisks = cleaned.includes('*');
  if (!hasAsterisks && isUIText(cleaned)) {
    return null;
  }

  // Filter out "Wagered: X.XX" patterns that get mistakenly captured
  // These are labels with values, not usernames
  if (/^(wagered|wager|prize|reward|bonus):\s*[\d,.]+$/i.test(cleaned)) {
    return null;
  }

  return cleaned;
}

/**
 * Parse money amount from markdown cell
 * Supports various currency formats: $, €, £, coins, emojis, text labels
 * @param {string} text - Raw cell text
 * @returns {number} - Parsed amount
 */
function parseMarkdownAmount(text) {
  if (!text) return 0;

  // Handle "-" or empty prize
  if (text.trim() === '-' || text.trim() === '') return 0;

  // Remove markdown image syntax first: ![alt](url) -> empty
  // This handles currency icons like ![Currency](/assets/clash-coin.svg)
  let cleaned = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

  // Remove ALL common currency symbols, emojis, and text labels
  cleaned = cleaned
    .replace(/[$€£¥₹฿₿◆♦💰🪙💎⭐✨🏆🎖️🥇🥈🥉]/gu, '')  // Currency symbols + emojis
    .replace(/\b(coins?|credits?|points?|gems?|tokens?|robux|chips?|diamonds?|stars?)\b/gi, '')  // Text labels
    .replace(/\s/g, '');  // Whitespace

  // Handle multipliers (k, m, b)
  let mult = 1;
  if (/b$/i.test(cleaned)) { mult = 1000000000; cleaned = cleaned.replace(/b$/i, ''); }
  else if (/m$/i.test(cleaned)) { mult = 1000000; cleaned = cleaned.replace(/m$/i, ''); }
  else if (/k$/i.test(cleaned)) { mult = 1000; cleaned = cleaned.replace(/k$/i, ''); }

  // Handle comma/dot formatting
  if (cleaned.includes(',') && cleaned.includes('.')) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    if (lastDot > lastComma) cleaned = cleaned.replace(/,/g, '');
    else cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    if (parts.length === 2 && parts[1].length <= 2) cleaned = cleaned.replace(',', '.');
    else cleaned = cleaned.replace(/,/g, '');
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num * mult;
}

/**
 * Parse markdown tables to extract leaderboard entries
 * @param {string} markdown - Markdown content
 * @returns {Array} - Array of entry objects
 */
function parseMarkdownTables(markdown) {
  const entries = [];
  const lines = markdown.split('\n');
  
  let inTable = false;
  let headers = [];
  let entryRank = 1;
  
  for (const line of lines) {
    // Check if line contains table delimiters
    if (!line.includes('|')) {
      inTable = false;
      headers = [];
      continue;
    }
    
    // Skip separator lines (| --- | --- |)
    if (/^\|[\s\-:|]+\|$/.test(line.trim()) || /^[\s\-:|]+$/.test(line.replace(/\|/g, ''))) {
      continue;
    }
    
    // Split cells by pipe
    const cells = line.split('|')
      .map(c => c.trim())
      .filter(c => c.length > 0);
    
    if (cells.length < 2) continue;
    
    // Detect header row
    if (!inTable && isMarkdownHeaderRow(cells)) {
      headers = normalizeMarkdownHeaders(cells);
      inTable = true;
      continue;
    }
    
    // Parse data row
    if (cells.length >= 3) {
      const entry = mapMarkdownCellsToEntry(cells, headers);
      if (entry) {
        // Assign sequential rank if not parsed
        if (entry.rank === 0) {
          entry.rank = entryRank;
        }
        entryRank++;
        entries.push(entry);
      }
    }
  }
  
  return entries;
}

/**
 * Parse podium-style entries from markdown
 * Handles patterns like:
 *   Z****o
 *   Wagered: $285,750
 *   $2,000
 * @param {string} markdown - Markdown content
 * @returns {Array} - Array of entry objects
 */
function parseMarkdownPodium(markdown) {
  const entries = [];
  const lines = markdown.split('\n').map(l => l.trim()).filter(l => l);

  // IMPORTANT: Podium = top 3 only. Stop after finding 3 entries.
  // This prevents the podium parser from eating entries that belong in the list parser.
  const MAX_PODIUM_ENTRIES = 3;

  // Pattern for "Wagered: $X" on same line (handles various currencies)
  const wageredInlinePattern = /Wagered:\s*[$€£¥₹฿₿◆♦💰🪙💎]?\s*([\d,]+(?:\.\d+)?)/i;
  // Pattern for just "Wagered:" label (amount on next line) - also handles markdown headers like "### Wagered"
  const wageredLabelPattern = /^(?:#{1,6}\s*)?Wagered:?$/i;
  // Pattern to extract rank from image path like "rank1-hex.svg" or "rank2-ribbon.svg"
  const rankImagePattern = /rank(\d+)/i;
  // Pattern for markdown underlines/separators
  const separatorPattern = /^[-=]{3,}$/;

  // Helper to strip markdown images from a line before pattern matching
  // Handles lines like " ![Currency](/assets/clash-coin.svg) 1,216.16"
  const stripImages = (line) => line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();

  // Pattern for standalone numbers (wager/prize amounts) - with or without currency symbols/emojis
  // Also handles markdown headers like "### $1,084,372.10"
  const amountPattern = /^(?:#{1,6}\s*)?[$€£¥₹฿₿◆♦💰🪙💎⭐✨]?\s*([\d,]+(?:\.\d+)?)\s*(?:coins?|credits?|points?)?$/i;
  // Pattern for prize - matches with OR without currency symbol (goatgambles has bare numbers like "600.00")
  // Also handles markdown headers like "### $33,000"
  const prizePattern = /^(?:#{1,6}\s*)?[$€£¥₹฿₿◆♦💰🪙💎⭐✨]?\s*([\d,]+(?:\.\d+)?)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Stop if we already have 3 podium entries
    if (entries.length >= MAX_PODIUM_ENTRIES) break;

    // Method 1: "Wagered: $X" on same line (devlrewards style)
    const inlineMatch = line.match(wageredInlinePattern);
    if (inlineMatch) {
      // The username should be on the previous line
      if (i > 0) {
        const usernameLine = lines[i - 1];
        if (!wageredInlinePattern.test(usernameLine) &&
            !amountPattern.test(usernameLine) &&
            !usernameLine.includes('|') &&
            usernameLine.length >= 2 &&
            usernameLine.length <= 50) {

          const username = cleanMarkdownUsername(usernameLine);
          const wager = parseMarkdownAmount(inlineMatch[1]);

          // Look ahead for prize (check labeled "Prize: X" first, then bare amount)
          let prize = 0;
          const labeledPrizePatternInline = /^Prize:\s*(?:!\[[^\]]*\]\([^)]*\)\s*)?[$€£¥₹฿₿◆♦💰🪙💎]?\s*([\d,]+(?:\.\d+)?)/i;
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            // Try labeled prize first: "Prize: 120.00"
            const labeledMatch = nextLine.match(labeledPrizePatternInline);
            if (labeledMatch) {
              prize = parseMarkdownAmount(labeledMatch[1]);
            } else {
              // Try bare amount pattern - BUT filter out likely rank numbers
              // A bare integer 1-100 without currency symbol or decimal is likely a rank, not a prize
              // e.g., "17" after wager is the next rank, not a $17 prize
              const prizeMatch = nextLine.match(prizePattern);
              if (prizeMatch) {
                const potentialPrize = parseMarkdownAmount(prizeMatch[1]);
                // Only accept as prize if:
                // 1. Has currency symbol (starts with $, €, etc.) OR
                // 2. Has decimal (e.g., "100.00") OR
                // 3. Is > 100 (unlikely to be a rank number)
                const hasCurrency = /^[$€£¥₹฿₿]/.test(nextLine.trim());
                const hasDecimal = /\.\d+/.test(nextLine);
                const isLikelyRank = potentialPrize <= 100 && !hasCurrency && !hasDecimal && Number.isInteger(potentialPrize);

                if (!isLikelyRank) {
                  prize = potentialPrize;
                }
              }
            }
          }

          // Allow entries with $0 wager - some users are on the leaderboard with no activity yet
          if (username && wager >= 0) {
            entries.push({
              rank: entries.length + 1,
              username,
              wager,
              prize,
              source: 'markdown-podium',
              _rankFromImage: false  // Flag: rank assigned by parsing order, not from image
            });
          }
        }
      }
      continue;
    }

    // Method 2: "Wagered:" or "### Wagered" on one line, amount on next (paxgambles/betjuicy style)
    if (wageredLabelPattern.test(line)) {
      // Look ahead for the wager amount
      let wagerAmount = 0;
      let prizeAmount = 0;
      let wagerLineIdx = -1;

      // Find the wager amount (next numeric line, within 3 lines)
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        // Skip separator lines
        if (separatorPattern.test(lines[j])) continue;
        // Strip markdown images before testing pattern (handles " ![Currency](...) 1,216.16")
        const cleanedLine = stripImages(lines[j]);
        if (amountPattern.test(cleanedLine)) {
          const amountMatch = cleanedLine.match(amountPattern);
          if (amountMatch) {
            wagerAmount = parseMarkdownAmount(amountMatch[1]);
            wagerLineIdx = j;
            break;
          }
        }
      }

      if (wagerAmount > 0) {
        // Pattern for labeled prize: "Prize: 120.00" or "Prize: $120.00" or "Prize:  ![Currency](...) 50.00"
        const labeledPrizePattern = /^Prize:\s*(?:!\[[^\]]*\]\([^)]*\)\s*)?[$€£¥₹฿₿◆♦💰🪙💎]?\s*([\d,]+(?:\.\d+)?)/i;

        // Look for prize after wager (pattern: "$33,000" or "### $33,000" OR "Prize: 120.00")
        for (let j = wagerLineIdx + 1; j < Math.min(wagerLineIdx + 4, lines.length); j++) {
          // Skip separator lines
          if (separatorPattern.test(lines[j])) continue;
          // Strip markdown images before testing pattern
          const cleanedLine = stripImages(lines[j]);

          // Check labeled prize first: "Prize: 120.00"
          const labeledMatch = lines[j].match(labeledPrizePattern);
          if (labeledMatch) {
            prizeAmount = parseMarkdownAmount(labeledMatch[1]);
            break;
          }

          // Check bare amount pattern
          const prizeMatch = cleanedLine.match(prizePattern);
          if (prizeMatch) {
            prizeAmount = parseMarkdownAmount(prizeMatch[1]);
            break;
          }
        }

        // Look backwards for username and rank (skip image lines, separators, find text)
        let username = null;
        let detectedRank = null;
        // Pattern for explicit rank like "1." or "2." on its own line (muta.bet style)
        const explicitRankPattern = /^(\d+)\.$/;
        for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          const prevLine = lines[j];
          const cleanedPrevLine = stripImages(prevLine);
          // Check for explicit rank (1., 2., 3. etc.)
          const explicitRankMatch = prevLine.match(explicitRankPattern);
          if (explicitRankMatch && !detectedRank) {
            detectedRank = parseInt(explicitRankMatch[1]);
            continue;
          }
          // Check for rank in image path
          if (prevLine.startsWith('![')) {
            const rankMatch = prevLine.match(rankImagePattern);
            if (rankMatch && !detectedRank) {
              detectedRank = parseInt(rankMatch[1]);
            }
            continue;
          }
          // Skip separator lines
          if (separatorPattern.test(prevLine)) continue;
          // Skip amounts and labels (check both raw and cleaned versions)
          if (amountPattern.test(cleanedPrevLine)) continue;
          if (prizePattern.test(cleanedPrevLine)) continue;
          if (wageredLabelPattern.test(prevLine)) continue;
          // Found potential username
          if (!username && prevLine.length >= 2 && prevLine.length <= 50) {
            username = cleanMarkdownUsername(prevLine);
            // Don't break - continue looking for rank in images
          }
          // If we found both username and rank, we can stop
          if (username && detectedRank) break;
        }

        if (username && wagerAmount > 0) {
          // Check for duplicate (same username + wager already exists)
          const isDupe = entries.some(e =>
            e.username === username && Math.abs(e.wager - wagerAmount) < 1
          );

          if (!isDupe) {
            entries.push({
              rank: detectedRank || (entries.length + 1),
              username,
              wager: wagerAmount,
              prize: prizeAmount,
              source: 'markdown-podium',
              _rankFromImage: !!detectedRank  // Flag: true if rank was detected from image path
            });
          }
        }
      }
    }
  }

  return entries;
}

/**
 * Parse list-style leaderboard entries from markdown (non-table format)
 * Handles patterns like:
 *   **#**4
 *   ![](...)username
 *   $ 30
 *   783,116.80
 * @param {string} markdown - Markdown content
 * @returns {Array} - Array of entry objects
 */
function parseMarkdownList(markdown) {
  const entries = [];
  const lines = markdown.split('\n').map(l => l.trim()).filter(l => l);

  // Helper to strip markdown images from a line before pattern matching
  // Handles lines like " ![Currency](/assets/clash-coin.svg) 1,216.16"
  const stripImages = (line) => line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();

  // Helper to strip table pipe characters from a line
  // Handles broken table formats where each cell is on its own line: "|4|" -> "4"
  // This fixes packdraw-style markdown where the table didn't render properly
  const stripPipes = (line) => line.replace(/^\|+|\|+$/g, '').trim();

  // Detect column order from table header: "Prize" then "Wagered" vs "Wagered" then "Prize"
  // This handles sites like blaffsen.com where Prize column comes before Wagered column
  // Look for the SPECIFIC pattern: "Place" then "User" then "Prize" then "Wagered" (table header)
  // This avoids matching podium section "Wagered:" labels
  let prizeBeforeWager = false;
  // Pattern 1: Look for table header row "Place...User...Prize/Reward...Wagered" or "Place...User...Wagered...Prize/Reward"
  // Note: Some sites use "Reward" instead of "Prize" (e.g., spencerrewards.com)
  const tableHeaderMatch = markdown.match(/\bPlace\b[\s\S]{0,30}\bUser\b[\s\S]{0,30}\b(Prize|Reward|Wagered)\b[\s\S]{0,30}\b(Prize|Reward|Wagered)\b/i);
  if (tableHeaderMatch) {
    const first = tableHeaderMatch[1].toLowerCase();
    const second = tableHeaderMatch[2].toLowerCase();
    // "prize" or "reward" before "wagered" means prize column comes first
    if ((first === 'prize' || first === 'reward') && second === 'wagered') {
      prizeBeforeWager = true;
      log('MARKDOWN', 'Detected column order: Prize/Reward before Wagered (from table header)');
    }
  }

  // Pattern for rank like "#4", "**#4**", "4." (requires # prefix OR . suffix)
  // IMPORTANT: Do NOT match bare numbers like "40" - these are often prizes in tables
  // Bare numbers should only be matched by rankPattern3 with strict sequential checking
  const rankPattern = /^(?:\*\*)?#(?:\*\*)?\s*(\d+)(?:\*\*)?$/;  // Requires # prefix
  // Alternative rank pattern with hash inside bold: "**#**4" or "**#** 4"
  const rankPattern2 = /^\*\*#\*\*\s*(\d+)$/;
  // Pattern for rank with period suffix: "4." or "1." (explicit rank marker)
  const rankPatternDot = /^(\d+)\.$/;
  // Pattern for bare rank numbers (4, 5, 6, etc.) - ONLY used with strict context checking
  // This is risky because bare numbers could be prizes, so we require:
  // 1. A "Challengers" or table header context nearby
  // 2. Sequential rank checking (must follow previous rank)
  const rankPattern3 = /^(\d{1,2})$/;  // Only 1-2 digit bare numbers (1-99)

  // Detect if we're in a "Challengers" or leaderboard table context
  // Look for header patterns: "Challengers", "User Wagered Prize", etc.
  const inChallengersContext = /(?:#\s*Challengers|User[\s\S]{0,30}Wagered[\s\S]{0,30}Prize)/i.test(markdown);

  // Track the last rank we found for sequential checking of bare numbers
  let lastFoundRank = 3; // Start at 3 since podium handles 1-3
  // Pattern for username embedded in image markdown: ![](...)username
  const imgUsernamePattern = /^!\[.*?\]\([^)]+\)(.+)$/;
  // Pattern for prize with currency symbol/emoji
  const prizePattern = /^[$€£¥₹฿₿◆♦💰🪙💎⭐✨]\s*([\d,]+(?:\.\d+)?)$/;
  // Pattern for plain amount (with optional currency symbols/text labels)
  const amountPattern = /^[$€£¥₹฿₿◆♦💰🪙💎⭐✨]?\s*([\d,]+(?:\.\d+)?)\s*(?:coins?|credits?|points?)?$/i;
  // Pattern for labeled wager: "Wagered: 575.34" or "Wagered: $575.34" or "Wagered:  ![Currency](...) 420.53"
  const labeledWagerPattern = /^Wagered:\s*(?:!\[[^\]]*\]\([^)]*\)\s*)?[$€£¥₹฿₿◆♦💰🪙💎]?\s*([\d,]+(?:\.\d+)?)/i;
  // Pattern for labeled prize: "Prize: 120.00" or "Prize: $120.00" or "Prize:  ![Currency](...) 50.00"
  const labeledPrizePattern = /^Prize:\s*(?:!\[[^\]]*\]\([^)]*\)\s*)?[$€£¥₹฿₿◆♦💰🪙💎]?\s*([\d,]+(?:\.\d+)?)/i;

  for (let i = 0; i < lines.length; i++) {
    // Strip pipe characters to handle broken table formats (e.g., "|4|" -> "4")
    const line = stripPipes(lines[i]);

    // Look for rank patterns - try explicit patterns first, then dot pattern
    let rankMatch = line.match(rankPattern) || line.match(rankPattern2) || line.match(rankPatternDot);

    // If no explicit rank pattern matched, try bare number pattern with strict checks
    // This handles betjuicy.com "Challengers" table where ranks are bare: 4, 5, 6, etc.
    if (!rankMatch && inChallengersContext) {
      const bareMatch = line.match(rankPattern3);
      if (bareMatch) {
        const potentialRank = parseInt(bareMatch[1]);
        // Only accept if:
        // 1. It's >= 4 (podium handles 1-3) and <= 50
        // 2. It's sequential (follows lastFoundRank)
        if (potentialRank >= 4 && potentialRank <= 50 && potentialRank === lastFoundRank + 1) {
          rankMatch = bareMatch;
          log('MARKDOWN', `Detected bare rank ${potentialRank} in Challengers context (sequential after ${lastFoundRank})`);
        }
      }
    }

    if (rankMatch) {
      const rank = parseInt(rankMatch[1]);
      // Include ranks 1-100 (removed restriction that skipped 1-3)
      // Podium parsing may also find 1-3, deduplication handles it
      if (rank < 1 || rank > 100) continue;

      // Check if this is a podium-style entry (has "Wagered:" label in lookahead)
      // If so, skip it - the podium parser will handle it with correct wager/prize
      // This prevents duplicates with swapped values (muta.bet fix)
      let isPodiumEntry = false;
      for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
        if (/^(?:#{1,6}\s*)?Wagered:?$/i.test(lines[k])) {
          isPodiumEntry = true;
          break;
        }
        // Stop checking if we hit another rank
        if (rankPattern.test(lines[k]) || rankPattern2.test(lines[k])) break;
      }
      if (isPodiumEntry) continue;

      let username = null;
      let prize = 0;
      let wager = 0;

      // Collect all amounts found in this entry for smarter assignment
      const amounts = [];

      // Look ahead for username, prize, wager
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        // Strip pipe characters from look-ahead lines too (for broken table formats)
        const nextLine = stripPipes(lines[j]);

        // Check for next rank (means we've moved to next entry)
        // Also check for "Place" header which indicates we've hit the table header
        // IMPORTANT: Only break on ranks that have the rank prefix pattern (**#** or #)
        // Bare numbers like "150" could be prizes, not ranks, so use rankPattern2 which requires **#**
        // Also check if this looks like **#**N format specifically
        // ALSO: Check for bare sequential ranks (e.g., "5" when we're on rank 4) - these are
        // common on sites like goatgambles/csgogem where ranks appear as bare numbers
        const looksLikeRankPrefix = /^\*\*#\*\*\s*\d+$/.test(nextLine) || /^#\d+$/.test(nextLine);
        // Check for bare sequential rank: exact match of next expected rank number
        const bareNextRank = /^\d{1,3}$/.test(nextLine) && parseInt(nextLine) === rank + 1;
        if (looksLikeRankPrefix || bareNextRank || /^Place$/i.test(nextLine)) break;

        // Username embedded in image
        const imgMatch = nextLine.match(imgUsernamePattern);
        if (imgMatch && !username) {
          username = cleanMarkdownUsername(imgMatch[1]);
          continue;
        }

        // Check for labeled wager first: "Wagered: 575.34"
        const labeledWagerMatch = nextLine.match(labeledWagerPattern);
        if (labeledWagerMatch) {
          wager = parseMarkdownAmount(labeledWagerMatch[1]);
          continue;
        }

        // Check for labeled prize: "Prize: 120.00"
        const labeledPrizeMatch = nextLine.match(labeledPrizePattern);
        if (labeledPrizeMatch) {
          prize = parseMarkdownAmount(labeledPrizeMatch[1]);
          continue;
        }

        // Check for "Wagered" label without colon - next amount should be wager
        // (handles format: "Wagered" on one line, "![Currency]3,503.88" on next)
        if (/^(?:#{1,6}\s*)?Wagered$/i.test(nextLine)) {
          // Look for amount on next line
          if (j + 1 < Math.min(i + 8, lines.length)) {
            const amountLine = stripImages(stripPipes(lines[j + 1]));
            if (amountPattern.test(amountLine)) {
              wager = parseMarkdownAmount(amountLine);
              j++; // Skip the amount line
            }
          }
          continue;
        }

        // Check for "Prize" label without colon - next amount should be prize
        // (handles format: "Prize" on one line, "![Currency]200" on next)
        if (/^(?:#{1,6}\s*)?Prize$/i.test(nextLine)) {
          // Look for amount on next line
          if (j + 1 < Math.min(i + 8, lines.length)) {
            const amountLine = stripImages(stripPipes(lines[j + 1]));
            if (amountPattern.test(amountLine)) {
              prize = parseMarkdownAmount(amountLine);
              j++; // Skip the amount line
            }
          }
          continue;
        }

        // Amount pattern (handles both prize and wager when no labels)
        // Strip images first to handle lines like " ![Currency](...) 420.53"
        const cleanedNextLine = stripImages(nextLine);
        const prizeMatch = cleanedNextLine.match(prizePattern);
        const amountMatch = amountPattern.test(cleanedNextLine);

        if (prizeMatch || amountMatch) {
          const amount = parseMarkdownAmount(nextLine);
          if (amount > 0) {
            // Check if this looks like a rank number (bare integer 1-100, no currency/decimal)
            // BUT if we detected "Prize before Wagered" column order, smaller amounts ARE prizes
            const hasCurrency = /^[$€£¥₹฿₿]/.test(cleanedNextLine);
            const hasDecimal = /\.\d+/.test(cleanedNextLine);
            // Check if there was a coin/gem icon on the previous line (indicates prize)
            // Pattern: ![](/assets/coin.svg) or ![](/assets/gem.svg)
            const prevLine = j > 0 ? lines[j - 1] : '';
            const hadPrizeIcon = /!\[.*?\]\([^)]*(?:coin|gem|currency|prize)[^)]*\)/i.test(prevLine);
            // Only filter as "likely rank" if we don't have prizeBeforeWager detection
            // Sites with "Prize" column before "Wagered" column have small prizes like $25, $50, $100
            const isLikelyRank = !prizeBeforeWager && !hadPrizeIcon && amount <= 100 && !hasCurrency && !hasDecimal && Number.isInteger(amount);

            if (!isLikelyRank) {
              amounts.push({ amount, hasCurrency, hadPrizeIcon });
            }
          }
          continue;
        }

        // Plain username (no image)
        // Note: Check length AFTER removing backslash escapes, as markdown escapes asterisks
        // e.g., "Ad\*\*\*\*ys" is 12 chars raw but 6 chars when unescaped
        const unescapedLen = nextLine.replace(/\\/g, '').length;
        if (!username && unescapedLen >= 2 && unescapedLen <= 50 &&
            !prizePattern.test(cleanedNextLine) && !amountPattern.test(cleanedNextLine) &&
            !nextLine.startsWith('![')) {
          username = cleanMarkdownUsername(nextLine);
        }
      }

      // SMART AMOUNT ASSIGNMENT based on count, currency, and detected column order:
      //
      // IMPORTANT: If we already got labeled values (Wagered: X, Prize: Y), those take priority!
      // Only use unlabeled amounts[] if labeled patterns didn't match.
      //
      // Case 1: ONE amount (common for rank 4+ list entries)
      //   → It's the WAGER (the metric that determines leaderboard position)
      //   → Prize is $0 (not displayed for non-prized positions)
      //
      // Case 2: TWO amounts (some sites show prize + wager)
      //   → Check detected column order from table header (Prize before Wagered)
      //   → If first has currency ($) and second doesn't: first=prize, second=wager
      //     Example: paxgambles DICEBLOX: "$ 20" (prize) then "577,399.80" (wager)
      //   → If prizeBeforeWager detected: first=prize, second=wager
      //     Example: blaffsen.com: "$150" (prize) then "$2,732.62" (wager)
      //   → Otherwise: first=wager, second=prize (original assumption)
      //
      // Skip amount assignment if we already have labeled values
      const hasLabeledWager = wager > 0;
      const hasLabeledPrize = prize > 0;

      if (!hasLabeledWager && !hasLabeledPrize && amounts.length >= 1) {
        // No labeled values found - use unlabeled amounts
        if (amounts.length === 1) {
          // Only one amount = it's the wager (determines rank position)
          wager = amounts[0].amount;
          // prize stays 0
        } else if (amounts.length >= 2) {
          // Two or more amounts - check column order, icons, and currency pattern
          if (prizeBeforeWager) {
            // Table header shows "Prize" before "Wagered" → first=prize, second=wager
            // This handles sites like blaffsen.com/acebet where both amounts have $
            prize = amounts[0].amount;
            wager = amounts[1].amount;
          } else if (amounts[0].hadPrizeIcon && !amounts[1].hadPrizeIcon) {
            // First had a coin/gem icon before it → first=prize, second=wager
            // This handles sites like blaffsen.com/clash that don't have table headers
            prize = amounts[0].amount;
            wager = amounts[1].amount;
          } else if (amounts[0].hasCurrency && !amounts[1].hasCurrency) {
            // First has $, second doesn't → first=prize, second=wager
            // This is the paxgambles DICEBLOX pattern: "$ 20" (prize), "577,399" (wager)
            prize = amounts[0].amount;
            wager = amounts[1].amount;
          } else {
            // Default: first=wager, second=prize
            wager = amounts[0].amount;
            prize = amounts[1].amount;
          }
        }
      } else if (hasLabeledWager && !hasLabeledPrize && amounts.length >= 1) {
        // Have labeled wager but no labeled prize - check if amounts has a prize
        // (unlikely since labeled formats usually have both, but handle edge case)
      } else if (!hasLabeledWager && hasLabeledPrize && amounts.length >= 1) {
        // Have labeled prize but no labeled wager - use first amount as wager
        wager = amounts[0].amount;
      }
      // If both labeled values exist, we already have them - don't override

      // Allow entries with $0 wager - some users are on the leaderboard with no activity yet
      // If we have a rank and wager but no username, the site may only show an avatar
      // Use [hidden] placeholder to preserve the entry (validated in entry-validation.js)
      if (!username && wager > 0) {
        username = '[hidden]';
      }

      if (username && wager >= 0) {
        entries.push({
          rank,
          username,
          wager,
          prize,
          source: 'markdown-list'
        });
        // Update lastFoundRank for sequential bare number detection
        lastFoundRank = rank;
      }
    }
  }

  return entries;
}

/**
 * Parse leaderboard entries that use H3 headers (###) for usernames
 *
 * This is a GENERIC parser for sites that structure entries as:
 *   ### username (with possible censored asterisks like ken****)
 *   [optional tier: Platinum/Gold/Silver/Bronze/VIP/Diamond/etc]
 *   $prize amount
 *   wager amount
 *   [optional: X Points]
 * 
 * Works for: yeeterboards.com and similar sites
 * 
 * @param {string} markdown - Markdown content
 * @returns {Array} - Array of entry objects
 */
function parseMarkdownHeaderEntries(markdown) {
  const entries = [];
  const lines = markdown.split('\n').map(l => l.trim()).filter(l => l);

  // Helper to strip image markdown: "![alt](url) 7,770.83" -> "7,770.83"
  const stripImages = (line) => line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();

  // Patterns
  const headerPattern = /^###\s+(.+)$/;                              // ### username
  const rankPattern = /^#(\d+)$/;                                    // #4, #5, etc.
  const tierPattern = /^(Platinum|Gold|Silver|Bronze|Jade|Diamond|VIP|Iron|Copper|Emerald|Ruby|Sapphire|Master|Grandmaster|Legend|Elite|Pro|Premium|Standard|Basic)$/i;
  const prizePattern = /^[$€£¥₹฿₿◆♦💰🪙💎⭐✨]([\d,]+(?:\.\d+)?)$/;   // $400, €1,000.00, 💰500
  const amountPattern = /^[$€£¥₹฿₿◆♦💰🪙💎⭐✨]?([\d,]+(?:\.\d+)?)$/; // 66,107.79 or $66,107.79
  const pointsPattern = /^([\d,]+(?:\.\d+)?)\s*(?:Points?|Coins?|Credits?|Gems?|Tokens?)$/i; // 66,108 Points/Coins/etc
  // Pattern to detect image-only lines (avatars) vs image-with-value lines (coin icons)
  // Image-only: "![avatar](url)" - skip these
  // Image-with-value: "![coin](url) 7,770.83" or "![coin](url)1,000" - DON'T skip, parse amount
  const isImageOnlyLine = (line) => {
    if (!/^!\[/.test(line)) return false; // Not an image line
    const stripped = stripImages(line);
    return stripped === '' || /^avatar$/i.test(stripped); // Only image, or "avatar" text
  };

  const skipPatterns = [
    // NOTE: Don't skip all image lines - some have amounts like "![coin](...) 7,770.83"
    // Instead, we use isImageOnlyLine() check below
    /^Casino Badge$/i,
    /^\d+[a-z]{2}\s+place$/i,                                        // 1st place, 2nd place
    /^Leaderboard$/i,                                                // Exact match only - don't skip usernames like "CODE Leaderboard"
    /^Leaderboard\s*-/i,                                             // "Leaderboard - Weekly" etc.
    /^This leaderboard/i,
    /^Community$/i,                                                  // Exact match - don't skip usernames
    /^Prize Pool/i,
    /^Duration/i,
    /^Current Volume/i,
    /^members/i,
    /^Referral$/i,                                                   // Exact match
    /^Social$/i,                                                     // Exact match
    /^Start$/i,
    /^End$/i,
    /^left$/i,
    /GMT|EST|PST|UTC/i
  ];
  
  // Track current rank (for entries without explicit rank)
  let implicitRank = 0;
  let lastExplicitRank = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for explicit rank marker (#4, #5, etc.)
    const explicitRankMatch = line.match(rankPattern);
    if (explicitRankMatch) {
      lastExplicitRank = parseInt(explicitRankMatch[1]);
      continue;
    }
    
    // Check for H3 header (username)
    const headerMatch = line.match(headerPattern);
    if (headerMatch) {
      const rawUsername = headerMatch[1];

      // Skip if it matches skip patterns (UI text, not a username)
      const shouldSkip = skipPatterns.some(p => p.test(rawUsername));
      if (shouldSkip) continue;

      // Clean the username (preserves censored asterisks)
      const username = cleanMarkdownUsername(rawUsername);
      if (!username || username.length < 2) continue;

      // Check for position badge BEFORE the header (1-3 lines back)
      // Sites like birb.bet show: avatar, position badge (1/2/3), then ### username
      let positionBadgeRank = 0;
      for (let k = Math.max(0, i - 3); k < i; k++) {
        const prevLine = lines[k];
        // Look for bare number 1-10 on its own line (position badge)
        if (/^[1-9]$|^10$/.test(prevLine)) {
          positionBadgeRank = parseInt(prevLine);
          break;
        }
      }

      // Determine rank - prefer position badge, then explicit #N, then implicit
      let rank;
      if (positionBadgeRank > 0) {
        rank = positionBadgeRank;
      } else if (lastExplicitRank > 0) {
        rank = lastExplicitRank;
        lastExplicitRank = 0; // Reset after use
      } else {
        implicitRank++;
        rank = implicitRank;
      }
      
      // Look ahead for tier, prize, wager, points (up to 8 lines)
      let tier = null;
      let prize = 0;
      let wager = 0;
      let points = 0;
      let expectWagerNext = false; // Track if we just saw a "Wagered" label

      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const nextLine = lines[j];

        // Stop if we hit another header or rank marker
        if (headerPattern.test(nextLine) || rankPattern.test(nextLine)) break;

        // Skip image-only lines (avatars) and known skip patterns
        // But DON'T skip images with amounts like "![coin](...) 7,770.83"
        if (isImageOnlyLine(nextLine)) continue;
        if (skipPatterns.some(p => p.test(nextLine))) continue;

        // Check for "Wagered" label - next amount should be wager
        if (/^Wagered$/i.test(nextLine)) {
          expectWagerNext = true;
          continue;
        }

        // Check for tier
        const tierMatch = nextLine.match(tierPattern);
        if (tierMatch && !tier) {
          tier = tierMatch[1];
          continue;
        }

        // Check for points (XXX Points)
        const pointsMatch = nextLine.match(pointsPattern);
        if (pointsMatch) {
          points = parseMarkdownAmount(pointsMatch[1]);
          continue;
        }

        // Check for amount - could be wager or prize depending on context
        // Strip image markdown first: "![coin](...) 7,770.83" -> "7,770.83"
        const cleanedNextLine = stripImages(nextLine);
        const amountMatch = cleanedNextLine.match(amountPattern);
        if (amountMatch) {
          const amount = parseMarkdownAmount(cleanedNextLine);

          // Skip bare single-digit integers (1-10) that aren't after a currency symbol/coin icon
          // These are likely position badges, not wagers/prizes
          // Exception: if preceded by "Wagered" label, it could be a legitimate small wager
          // Also check original line for coin icon (stripped but indicates currency context)
          const hadCoinIcon = /coin|gem|currency/i.test(nextLine);
          const isBareSmallInt = amount <= 10 && Number.isInteger(amount) &&
            !/^[$€£¥₹฿₿]/.test(cleanedNextLine) && !hadCoinIcon;

          if (expectWagerNext && wager === 0) {
            // If we just saw "Wagered" label, this is the wager (trust the label)
            wager = amount;
            expectWagerNext = false;
          } else if (isBareSmallInt && !expectWagerNext) {
            // Skip bare small integers without labels/icons - likely position badges
            continue;
          } else if (wager === 0) {
            // First amount without label - treat as wager (larger value typically)
            wager = amount;
          } else if (prize === 0) {
            // Second amount - treat as prize (smaller value typically)
            prize = amount;
          }
          continue;
        }
      }
      
      // Accept entry if we have username and either wager or points
      // Some sites use points instead of wager
      const effectiveWager = wager > 0 ? wager : points;
      
      if (username && effectiveWager > 0) {
        entries.push({
          rank,
          username,
          wager: effectiveWager,
          prize,
          tier: tier || null,
          source: 'markdown-header'
        });
      }
    }
  }
  
  return entries;
}

/**
 * Merge podium and table entries, avoiding duplicates
 * Podium entries are ranked 1-3, table entries typically start at 4+
 * @param {Array} podiumEntries - Entries from podium parsing
 * @param {Array} tableEntries - Entries from table parsing
 * @returns {Array} - Merged entries
 */
function mergeMarkdownEntries(podiumEntries, tableEntries) {
  const merged = new Map();
  
  // Add podium entries first (priority for ranks 1-3)
  for (const entry of podiumEntries) {
    const key = `${entry.username.toLowerCase()}|${Math.round(entry.wager)}`;
    merged.set(key, entry);
  }
  
  // Add table entries, skip duplicates
  for (const entry of tableEntries) {
    const key = `${entry.username.toLowerCase()}|${Math.round(entry.wager)}`;
    if (!merged.has(key)) {
      merged.set(key, entry);
    }
  }
  
  // Sort by rank
  return Array.from(merged.values()).sort((a, b) => a.rank - b.rank);
}

/**
 * Merge all markdown entries from header, podium, table, and list sources
 * Priority: header (highest - most structured) > podium > table > list
 * @param {Array} headerEntries - Entries from ### header parsing (yeeterboards style)
 * @param {Array} podiumEntries - Entries from podium parsing (Wagered: style)
 * @param {Array} tableEntries - Entries from table parsing
 * @param {Array} listEntries - Entries from list parsing
 * @returns {Array} - Merged entries
 */
function mergeAllMarkdownEntries(headerEntries, podiumEntries, tableEntries, listEntries) {
  const merged = new Map();
  
  // Helper to normalize username for deduplication
  // IMPORTANT: Preserve censored asterisks for matching
  const normalizeForKey = (username) => {
    if (!username) return '';
    return username
      .toLowerCase()
      .replace(/^#{1,6}\s*/, '')     // Strip markdown headers
      .replace(/\\/g, '')             // Strip backslash escapes
      .trim();
  };
  
  // Add in reverse priority order (later overwrites)
  // DEDUP KEY: username|rank (NOT username|wager - wager can differ between parsers)
  // Same user at same rank = definitely duplicate, keep higher priority version

  // List entries first (lowest priority)
  for (const entry of (listEntries || [])) {
    if (!entry.username) continue;
    const normUser = normalizeForKey(entry.username);
    const key = `${normUser}|${entry.rank || 0}`;
    merged.set(key, entry);
  }

  // Table entries
  for (const entry of (tableEntries || [])) {
    if (!entry.username) continue;
    const normUser = normalizeForKey(entry.username);
    const key = `${normUser}|${entry.rank || 0}`;
    merged.set(key, entry);
  }

  // Podium entries (Wagered: label style)
  for (const entry of (podiumEntries || [])) {
    if (!entry.username) continue;
    const normUser = normalizeForKey(entry.username);
    const key = `${normUser}|${entry.rank || 0}`;
    merged.set(key, entry);
  }

  // Header entries (### username style - highest priority, most structured)
  for (const entry of (headerEntries || [])) {
    if (!entry.username) continue;
    const normUser = normalizeForKey(entry.username);
    const key = `${normUser}|${entry.rank || 0}`;
    merged.set(key, entry);
  }
  
  // Sort by rank
  return Array.from(merged.values()).sort((a, b) => (a.rank || 999) - (b.rank || 999));
}

// ============================================================================
// GEOMETRIC DETECTION
// ============================================================================

/**
 * Extract geometric data for all potential leaderboard elements
 * @param {Page} page - Playwright page instance
 * @returns {Array} - Array of element geometry data
 */
async function extractElementGeometry(page) {
  return await page.evaluate(() => {
    const selectors = 'li, tr, article, div, section, [class*="item"], [class*="rank"], [class*="entry"], [class*="player"], [class*="user"], [class*="row"]';
    const elements = document.querySelectorAll(selectors);
    const results = [];
    
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      
      if (rect.width < 50 || rect.height < 20) continue;
      if (rect.width > window.innerWidth * 0.95) continue;
      if (rect.height > 300) continue;
      
      const text = el.innerText?.trim() || '';
      if (text.length < 5 || text.length > 500) continue;
      
      const childCount = el.children.length;
      
      results.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        area: rect.width * rect.height,
        centerX: rect.x + rect.width / 2,
        centerY: rect.y + rect.height / 2,
        text: text.substring(0, 300),
        childCount,
        tagName: el.tagName.toLowerCase(),
        className: (el.className || '').toString().substring(0, 100)
      });
    }
    
    return results;
  });
}

/**
 * Group elements by size similarity
 * @param {Array} elements - Array of element geometry data
 * @param {number} tolerance - Size tolerance (0-1)
 * @returns {Array} - Array of groups
 */
function groupBySizeSimilarity(elements, tolerance = 0.15) {
  const groups = [];
  
  for (const el of elements) {
    let foundGroup = false;
    
    for (const group of groups) {
      const ref = group[0];
      const widthDiff = Math.abs(el.width - ref.width) / ref.width;
      const heightDiff = Math.abs(el.height - ref.height) / ref.height;
      
      if (widthDiff <= tolerance && heightDiff <= tolerance) {
        group.push(el);
        foundGroup = true;
        break;
      }
    }
    
    if (!foundGroup) {
      groups.push([el]);
    }
  }
  
  return groups.filter(g => g.length >= 3);
}

/**
 * Detect the "3+7" podium+list structure
 * @param {Array} groups - Array of element groups
 * @param {number} xAlignmentTolerance - X-axis alignment tolerance
 * @returns {Object|null} - Structure with podiumElements and listElements
 */
function detectPodiumAndList(groups, xAlignmentTolerance = 10) {
  if (groups.length === 0) return null;
  
  groups.sort((a, b) => b.length - a.length);
  
  let listGroup = null;
  let podiumGroup = null;
  
  for (const group of groups) {
    if (group.length >= 5) {
      const xCoords = group.map(el => el.x);
      const avgX = xCoords.reduce((a, b) => a + b, 0) / xCoords.length;
      const xAligned = xCoords.every(x => Math.abs(x - avgX) <= xAlignmentTolerance);
      
      if (xAligned) {
        group.sort((a, b) => a.y - b.y);
        listGroup = group;
        break;
      }
    }
  }
  
  if (listGroup) {
    const listTopY = Math.min(...listGroup.map(el => el.y));
    const listMedianArea = listGroup.map(el => el.area).sort((a, b) => a - b)[Math.floor(listGroup.length / 2)];
    
    for (const group of groups) {
      if (group === listGroup) continue;
      if (group.length >= 2 && group.length <= 4) {
        const allAbove = group.every(el => el.y < listTopY);
        const avgArea = group.reduce((s, el) => s + el.area, 0) / group.length;
        
        if (allAbove && avgArea > listMedianArea * 1.2) {
          group.sort((a, b) => a.x - b.x);
          podiumGroup = group;
          break;
        }
      }
    }
  }
  
  let confidence = 0;
  if (listGroup) {
    confidence += 0.4;
    if (listGroup.length >= 7) confidence += 0.2;
  }
  if (podiumGroup) {
    confidence += 0.3;
    if (podiumGroup.length === 3) confidence += 0.1;
  }
  
  return {
    podiumElements: podiumGroup || [],
    listElements: listGroup || [],
    confidence
  };
}

/**
 * Extract entries from geometrically identified structure
 * @param {Page} page - Playwright page instance
 * @param {Object} structure - Structure with podiumElements and listElements
 * @returns {Array} - Array of entry objects
 */
async function extractFromGeometricStructure(page, structure) {
  const entries = [];
  
  for (let i = 0; i < structure.podiumElements.length && i < 3; i++) {
    const el = structure.podiumElements[i];
    const extracted = parseEntryFromText(el.text, i + 1);
    if (extracted) {
      extracted.source = 'geometric-podium';
      entries.push(extracted);
    }
  }
  
  const startRank = entries.length + 1;
  for (let i = 0; i < structure.listElements.length && entries.length < 10; i++) {
    const el = structure.listElements[i];
    const rank = startRank + i;
    const extracted = parseEntryFromText(el.text, rank);
    if (extracted) {
      extracted.source = 'geometric-list';
      entries.push(extracted);
    }
  }
  
  return entries;
}

/**
 * Parse username, wager, prize from element text
 * @param {string} text - Element text
 * @param {number} defaultRank - Default rank to assign
 * @returns {Object|null} - Entry object or null
 */
function parseEntryFromText(text, defaultRank) {
  if (!text) return null;
  
  // Check if text block looks like page header/metadata (not a leaderboard entry)
  const textLower = text.toLowerCase();
  
  // Strong header indicators - if ANY of these are present, it's definitely a header
  const strongHeaderIndicators = [
    'current volume', 'total wagered', 'community leaderboard', 
    'prize distribution', 'total participants'
  ];
  
  // If any strong indicator is present, skip this block
  if (strongHeaderIndicators.some(indicator => textLower.includes(indicator))) {
    return null;
  }
  
  // Weak indicators - need 3+ to be considered a header
  const weakHeaderIndicators = [
    'prize pool', 'duration', 'monthly', 'weekly', 'daily',
    'starts', 'ends', 'ending in', 'time left', 'countdown'
  ];
  
  const weakMatchCount = weakHeaderIndicators.filter(indicator => textLower.includes(indicator)).length;
  if (weakMatchCount >= 3) {
    return null;
  }
  
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  
  let username = null;
  let wager = 0;
  let prize = 0;
  let rank = defaultRank;
  const moneyAmounts = [];
  
  for (const line of lines) {
    const upperLine = line.toUpperCase();
    
    if (['WAGERED', 'WAGER', 'REWARD', 'PRIZE', 'BONUS', 'ACTIVE', 'STATUS', 'INACTIVE'].includes(upperLine)) {
      continue;
    }
    
    const rankMatch = line.match(/^#?(\d+)(?:st|nd|rd|th)?$/i);
    if (rankMatch && parseInt(rankMatch[1]) <= 20) {
      rank = parseInt(rankMatch[1]);
      continue;
    }
    
    if (/^[$◆♦€£]?\s*[\d,.]+\s*(k|m|b)?$/i.test(line) || /^[\d,.]+\s*(coins?|credits?|points?)?$/i.test(line)) {
      const amount = parseNum(line);
      if (amount > 0) {
        moneyAmounts.push(amount);
      }
      continue;
    }
    
    if (!username) {
      const cleaned = cleanUsername(line);
      const validation = validateUsername(cleaned);
      if (validation.valid) {
        username = cleaned;
      }
    }
  }
  
  if (!username) return null;
  
  moneyAmounts.sort((a, b) => b - a);
  if (moneyAmounts.length >= 1) wager = moneyAmounts[0];
  if (moneyAmounts.length >= 2) prize = moneyAmounts[1];
  
  return { rank, username, wager, prize };
}

// ============================================================================
// PAGE INTERACTION HELPERS
// ============================================================================

/**
 * Scroll page to load all content
 * @param {Page} page - Playwright page instance
 * @param {number} scrollStep - Pixels per scroll step
 * @param {number} maxScrolls - Maximum number of scroll steps
 */
async function fullPageScroll(page, scrollStep = 400, maxScrolls = 20) {
  log('DOM', 'Scrolling to load all content...');
  
  let scrollPosition = 0;
  let scrollCount = 0;
  let lastHeight = 0;
  
  while (scrollCount < maxScrolls) {
    scrollPosition += scrollStep;
    await page.evaluate((pos) => window.scrollTo(0, pos), scrollPosition);
    await page.waitForTimeout(300);
    
    const { currentPos, totalHeight } = await page.evaluate(() => ({
      currentPos: window.scrollY + window.innerHeight,
      totalHeight: document.body.scrollHeight
    }));
    
    // Check if page height changed (lazy loading triggered)
    if (totalHeight !== lastHeight) {
      lastHeight = totalHeight;
      await page.waitForTimeout(500); // Wait for new content to render
    }
    
    if (currentPos >= totalHeight - 100) {
      await page.waitForTimeout(500);
      break;
    }
    
    scrollCount++;
  }
  
  // Scroll to absolute bottom to ensure all lazy content is loaded
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  
  // Scroll back to leaderboard area for extraction
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(500);
}

/**
 * Click "Show More" / "Expand" buttons
 * @param {Page} page - Playwright page instance
 * @param {number} maxClicks - Maximum buttons to click
 * @returns {number} - Number of buttons clicked
 */
async function clickShowMoreButtons(page, maxClicks = 5) {
  log('DOM', 'Looking for "Show More" / "Expand" buttons...');
  
  let totalClicks = 0;
  
  for (let attempt = 0; attempt < maxClicks; attempt++) {
    const clicked = await page.evaluate(() => {
      const showMorePatterns = [
        /^show\s*(more|all)$/i,
        /^load\s*(more|all)$/i,
        /^view\s*(more|all)$/i,
        /^see\s*(more|all)$/i,
        /^expand$/i,
        /^more$/i,
        /^\+\s*\d+\s*(more)?$/i,
        /^show\s*\d+\s*more$/i,
        /^view\s*\d+\s*more$/i,
        /^load\s*\d+\s*more$/i
      ];
      
      const allButtons = document.querySelectorAll('button, [role="button"], a[class*="btn"], a[class*="button"]');
      
      for (const btn of allButtons) {
        const btnText = (btn.textContent || '').trim().toLowerCase();
        
        if (btn.closest('nav, header, footer, [class*="history"]')) continue;
        
        for (const pattern of showMorePatterns) {
          if (pattern.test(btnText)) {
            const nearLeaderboard = btn.closest('[class*="leaderboard"], [class*="ranking"], [class*="winner"], main, [class*="content"]');
            if (nearLeaderboard || document.querySelector('[class*="leaderboard"]')) {
              btn.click();
              return { clicked: true, text: btnText };
            }
          }
        }
      }
      
      return { clicked: false };
    });
    
    if (clicked.clicked) {
      log('DOM', `Clicked "${clicked.text}"`);
      totalClicks++;
      await page.waitForTimeout(2500);
    } else {
      break;
    }
  }
  
  if (totalClicks > 0) {
    log('DOM', `Clicked ${totalClicks} "Show More" button(s)`);
  } else {
    log('DOM', 'No "Show More" buttons found');
  }
  
  return totalClicks;
}

// ============================================================================
// OCR FALLBACK
// ============================================================================

/**
 * Run OCR fallback for leaderboard extraction
 * @param {Page} page - Playwright page instance
 * @param {string} lbName - Leaderboard name
 * @param {string} tempDir - Directory for temporary files
 * @returns {Array} - Array of entry objects
 */
async function runOCRFallback(page, lbName, tempDir) {
  log('DOM', `Running OCR fallback for ${lbName}...`);
  
  const screenshotPath = path.join(tempDir, `temp-ocr-${Date.now()}.png`);
  
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    
    const result = await Tesseract.recognize(screenshotPath, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          process.stdout.write(`\r    OCR: ${Math.round(m.progress * 100)}%`);
        }
      }
    });
    
    console.log('');
    
    const text = result.data.text;
    const entries = [];
    const seenUsers = new Set();
    const lines = text.split('\n').filter(l => l.trim());
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      const validation = validateUsername(line);
      if (!validation.valid) continue;
      
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nextLine = lines[j].trim();
        const numMatch = nextLine.match(/^[$◆♦]?\s*([\d,]+\.?\d*)$/);
        if (numMatch) {
          const wager = parseNum(numMatch[1]);
          if (wager > 10 && !seenUsers.has(line.toLowerCase())) {
            seenUsers.add(line.toLowerCase());
            entries.push({
              rank: entries.length + 1,
              username: line,
              wager,
              prize: 0,
              source: 'ocr'
            });
            break;
          }
        }
      }
    }
    
    fs.unlinkSync(screenshotPath);
    log('DOM', `OCR found ${entries.length} entries`);
    return entries;
    
  } catch (err) {
    log('ERR', `OCR failed: ${err.message}`);
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    return [];
  }
}

/**
 * Extract prize pool from page
 * @param {Page} page - Playwright page instance
 * @returns {number} - Prize pool amount
 */
async function extractPrizePool(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/(?:prize\s*pool|total\s*rewards?|total\s*prize)[:\s]*[$◆♦]?\s*([\d,]+)/i);
    if (match) return parseFloat(match[1].replace(/,/g, '')) || 0;
    return 0;
  });
}

// ============================================================================
// ENTRY MERGING
// ============================================================================

/**
 * Merge and deduplicate entries from multiple sources
 * @param {Array} apiEntries - Entries from API
 * @param {Array} domEntries - Entries from DOM
 * @param {Array} ocrEntries - Entries from OCR
 * @returns {Array} - Merged entries
 */
function mergeEntries(apiEntries, domEntries, ocrEntries = []) {
  const merged = new Map();
  
  const sources = [
    { entries: apiEntries, priority: 3, name: 'api' },
    { entries: domEntries, priority: 2, name: 'dom' },
    { entries: ocrEntries, priority: 1, name: 'ocr' }
  ];
  
  for (const source of sources) {
    for (const entry of source.entries) {
      if (!entry.username) continue;
      
      // Use username+wager as key to allow same usernames with different wagers (e.g., "Anonymous" users)
      const key = `${entry.username.toLowerCase()}|${Math.round(entry.wager || 0)}`;
      
      if (!merged.has(key)) {
        merged.set(key, { ...entry, priority: source.priority });
      } else {
        const existing = merged.get(key);
        if (source.priority > existing.priority) {
          merged.set(key, { ...entry, priority: source.priority });
        } else if (source.priority === existing.priority) {
          if (entry.wager > 0 && existing.wager === 0) existing.wager = entry.wager;
          if (entry.prize > 0 && existing.prize === 0) existing.prize = entry.prize;
        }
      }
    }
  }
  
  return Array.from(merged.values()).map(({ priority, ...rest }) => rest);
}

/**
 * Merge and deduplicate entries from multiple sources including Markdown
 * Priority: API (4) > Markdown (3) > DOM (2) > OCR (1)
 * @param {Array} apiEntries - Entries from API (highest priority)
 * @param {Array} markdownEntries - Entries from Markdown extraction
 * @param {Array} domEntries - Entries from DOM
 * @param {Array} ocrEntries - Entries from OCR (lowest priority)
 * @returns {Array} - Merged entries sorted by rank
 */
function mergeEntriesWithMarkdown(apiEntries, markdownEntries, domEntries, ocrEntries = []) {
  const merged = new Map();
  
  // Priority order: API (4) > Markdown (3) > DOM (2) > OCR (1)
  // Markdown typically has cleaner data than raw DOM parsing
  const sources = [
    { entries: apiEntries || [], priority: 4, name: 'api' },
    { entries: markdownEntries || [], priority: 3, name: 'markdown' },
    { entries: domEntries || [], priority: 2, name: 'dom' },
    { entries: ocrEntries || [], priority: 1, name: 'ocr' }
  ];
  
  for (const source of sources) {
    for (const entry of source.entries) {
      if (!entry.username) continue;
      
      // Use username+wager as key to allow same usernames with different wagers
      const key = `${entry.username.toLowerCase()}|${Math.round(entry.wager || 0)}`;
      
      if (!merged.has(key)) {
        merged.set(key, { ...entry, priority: source.priority, sourceName: source.name });
      } else {
        const existing = merged.get(key);
        if (source.priority > existing.priority) {
          // Higher priority source wins
          merged.set(key, { ...entry, priority: source.priority, sourceName: source.name });
        } else if (source.priority === existing.priority) {
          // Same priority - fill in missing fields
          if (entry.wager > 0 && existing.wager === 0) existing.wager = entry.wager;
          if (entry.prize > 0 && existing.prize === 0) existing.prize = entry.prize;
          if (entry.rank > 0 && existing.rank === 0) existing.rank = entry.rank;
        }
      }
    }
  }
  
  // Remove internal tracking fields and sort by rank
  return Array.from(merged.values())
    .map(({ priority, sourceName, ...rest }) => rest)
    .sort((a, b) => (a.rank || 999) - (b.rank || 999));
}

// ============================================================================
// CONSENSUS-BASED VALIDATION
// ============================================================================

/**
 * Normalize username for consensus matching
 * Handles censored usernames, different casings, and markdown artifacts
 * @param {string} username - Raw username
 * @returns {string} - Normalized username for comparison
 */
function normalizeUsername(username) {
  if (!username) return '';
  
  let norm = username.toLowerCase().trim();
  
  // Remove markdown artifacts
  norm = norm.replace(/^#{1,6}\s*/, '');        // Headers
  norm = norm.replace(/\\/g, '');               // Backslash escapes
  norm = norm.replace(/^\*+|\*+$/g, '');        // Bold markers
  norm = norm.replace(/^_+|_+$/g, '');          // Italic markers
  norm = norm.replace(/`/g, '');                // Code backticks
  
  // Normalize whitespace
  norm = norm.replace(/\s+/g, ' ').trim();
  
  return norm;
}

/**
 * Build consensus entries from multiple extraction sources
 * Only includes entries that appear in 2+ sources for high confidence
 * @param {Array} apiEntries - Entries from API extraction
 * @param {Array} markdownEntries - Entries from Markdown extraction
 * @param {Array} domEntries - Entries from DOM extraction
 * @param {Array} geometricEntries - Entries from geometric detection
 * @returns {Object} - { verified: [], singleSource: [], sourceAgreement, sourceCounts }
 */
function buildConsensusEntries(apiEntries, markdownEntries, domEntries, geometricEntries) {
  const consensusMap = new Map();
  
  const allSources = [
    { name: 'api', entries: apiEntries || [], priority: 4 },
    { name: 'markdown', entries: markdownEntries || [], priority: 3 },
    { name: 'dom', entries: domEntries || [], priority: 2 },
    { name: 'geometric', entries: geometricEntries || [], priority: 1 }
  ];
  
  // Build map keyed by normalized username + approximate wager bucket
  for (const source of allSources) {
    for (const entry of source.entries) {
      if (!entry.username) continue;
      
      // Normalize username for comparison
      const normUser = normalizeUsername(entry.username);
      if (!normUser || normUser.length < 2) continue;
      
      // Round wager to nearest 100 to handle small discrepancies
      const wagerBucket = Math.round((entry.wager || 0) / 100) * 100;
      const key = `${normUser}|${wagerBucket}`;
      
      if (!consensusMap.has(key)) {
        consensusMap.set(key, { 
          entry: { ...entry }, 
          sources: [source.name], 
          wagers: [entry.wager || 0],
          prizes: [entry.prize || 0],
          ranks: [entry.rank || 0],
          maxPriority: source.priority
        });
      } else {
        const existing = consensusMap.get(key);
        if (!existing.sources.includes(source.name)) {
          existing.sources.push(source.name);
          existing.wagers.push(entry.wager || 0);
          existing.prizes.push(entry.prize || 0);
          existing.ranks.push(entry.rank || 0);
          // Keep the entry from highest priority source
          if (source.priority > existing.maxPriority) {
            existing.entry = { ...entry };
            existing.maxPriority = source.priority;
          }
        }
      }
    }
  }
  
  const verified = [];
  const singleSource = [];
  
  for (const [key, data] of consensusMap) {
    // Calculate average values from sources that agree
    const avgWager = data.wagers.reduce((a, b) => a + b, 0) / data.wagers.length;
    const maxPrize = Math.max(...data.prizes);  // Take max prize (some sources may miss it)
    const minRank = Math.min(...data.ranks.filter(r => r > 0)) || data.entry.rank;
    
    const consensusEntry = {
      ...data.entry,
      wager: avgWager,
      prize: maxPrize,
      rank: minRank,
      sourceCount: data.sources.length,
      sources: data.sources
    };
    
    if (data.sources.length >= 2) {
      verified.push(consensusEntry);
    } else {
      singleSource.push(consensusEntry);
    }
  }
  
  // Sort verified entries by rank (if available) or by wager (descending)
  verified.sort((a, b) => {
    if (a.rank && b.rank) return a.rank - b.rank;
    return b.wager - a.wager;
  });
  
  // Recalculate ranks for verified entries if needed
  verified.forEach((entry, idx) => {
    if (!entry.rank || entry.rank === 0) {
      entry.rank = idx + 1;
    }
  });
  
  // Sort single-source entries by wager (descending)
  singleSource.sort((a, b) => b.wager - a.wager);
  
  // Calculate agreement ratio
  const totalUnique = verified.length + singleSource.length;
  const sourceAgreement = totalUnique > 0 ? verified.length / totalUnique : 0;
  
  // Count entries from each source
  const sourceCounts = {
    api: (apiEntries || []).length,
    markdown: (markdownEntries || []).length,
    dom: (domEntries || []).length,
    geometric: (geometricEntries || []).length
  };
  
  return {
    verified,
    singleSource,
    sourceAgreement,
    sourceCounts,
    totalUnique
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // DOM extraction
  scrapeDOMLeaderboard,
  
  // Markdown extraction
  scrapeMarkdownLeaderboard,
  parseMarkdownTables,
  parseMarkdownPodium,
  parseMarkdownList,
  parseMarkdownHeaderEntries,
  cleanMarkdownUsername,
  parseMarkdownAmount,
  
  // Geometric detection
  extractElementGeometry,
  groupBySizeSimilarity,
  detectPodiumAndList,
  extractFromGeometricStructure,
  parseEntryFromText,
  
  // Page interaction
  fullPageScroll,
  clickShowMoreButtons,
  
  // OCR
  runOCRFallback,
  extractPrizePool,
  
  // Merging
  mergeEntries,
  mergeEntriesWithMarkdown,
  
  // Consensus validation
  normalizeUsername,
  buildConsensusEntries
};
