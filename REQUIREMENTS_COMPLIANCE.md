# Requirements Compliance - Leaderboard Scraper

> **Purpose**: Maps project requirements to implementation. Use for audits and onboarding.

---

## 1. Core Requirements

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| Process 500+ leaderboard sites per run | ✅ | `batch-runner.js` loads from `websites.txt`, processes sequentially |
| Handle hundreds of sites from provided txt list | ✅ | `loadWebsites()` in utils.js, `websites.txt` |
| Execute in timely and predictable manner | ✅ | Per-site timeout (90s), circuit breaker, configurable delays |
| Save and update data efficiently | ✅ | `db-save.js` (PostgreSQL), JSON to `results/current/` |
| Support near-live internal updates | ✅ | Cron-based, configurable refresh intervals |
| Not a basic scraper – hybrid approach | ✅ | Multi-strategy extraction with fusion |

---

## 2. Site Variety Support

| Challenge | Status | Implementation |
|-----------|--------|----------------|
| Dynamic buttons, tabs, switchers | ✅ | `site-detection.js` – slider, tab, href, image, deep-scan |
| JavaScript-rendered content | ✅ | Playwright, `waitForLeaderboardReady`, fingerprint-based change detection |
| Hybrid navigation (UI + API) | ✅ | Click switchers + network capture for API extraction |
| Tables, card layouts, podium layouts | ✅ | Markdown, DOM, geometric extraction; podium vs list parsing |
| Masked usernames | ✅ | `normalizeUsername`, asterisk handling, `[hidden]` placeholder |
| Inconsistent rank formats | ✅ | Multiple rank patterns in `extraction.js` |
| Different wager/prize ordering | ✅ | Label detection, `prizeBeforeWager` hint, smart assignment |
| Click correct UI elements | ✅ | Image-click, coordinate-click, text-selector fallbacks |
| Detect when full leaderboard loaded | ✅ | `waitForLeaderboardReady`, `scrollUntilStable` |
| Handle async data sources | ✅ | Network capture, API merger, pagination fetch |
| Choose between conflicting data | ✅ | `data-fusion.js` – confidence, cross-validation, Vision validation |

---

## 3. Extraction Architecture

| Component | Status | Location |
|-----------|--------|----------|
| API extraction | ✅ | `strategies/api-extraction.js` |
| API merger (split responses) | ✅ | `strategies/api-merger.js` |
| Markdown extraction | ✅ | `strategies/markdown-extraction.js` |
| DOM extraction | ✅ | `strategies/dom-extraction.js` |
| Geometric extraction | ✅ | `strategies/geometric-extraction.js` |
| OCR fallback | ✅ | `strategies/ocr-extraction.js` (disabled in Node batch) |
| Data fusion | ✅ | `core/data-fusion.js` |
| Cross-validation | ✅ | `core/cross-validator.js` |

---

## 4. Max-Rows / "Show X Users" Dropdown

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| Always select maximum entries | ✅ | `selectMaximumEntries()` - native select → custom dropdown → Show All |
| Target correct dropdown (not filters) | ✅ | Pattern matching: show, entries, rows, users, per page, limit |
| Run per leaderboard after tab switch | ✅ | Called in `scrape-orchestrator.js` per leaderboard |
| BetJuicy-style "Show X users" | ✅ | `users` and `amount of` in ROW_SELECTOR_PATTERNS |
| Trigger change event for SPA | ✅ | `change` + `input` events dispatched |

---

## 5. Previous / Historical Leaderboards

| Requirement | Status | Notes |
|-------------|--------|-------|
| Avoid scraping previous by mistake | ✅ | `page-navigation.js` filters prev-leaderboard links |
| Historical API URL filtering | ✅ | `api-merger.js` – past-winners, history, date patterns |
| Future: scrape previous leaderboards | 🔜 | `discoverHistoricalPaths()` exists; not in main flow yet |
| Priority: current first | ✅ | Current leaderboard scraping is primary focus |

---

## 6. Limitations Addressed

| Limitation | Status | Fix |
|------------|--------|-----|
| Inconsistent button/tab detection | ✅ | Null-safe fingerprint, relaxed coords, multi-strategy detection |
| Partial leaderboards captured | ✅ | `scrollUntilStable`, expanded row selectors, DOM/markdown trust rules |
| Site-specific edge cases | ✅ | Additive validation, relaxed rank mismatch, conservative penalties |
| Extraction methods failing in combination | ✅ | Geometric trust, Vision validation, cross-validator improvements |

---

## 7. Technologies

| Technology | Usage |
|------------|-------|
| Node.js | Runtime |
| Playwright | Browser automation |
| Network interception | API capture during page load |
| HTML → Markdown | Turndown in `page-scraper.js` |
| OCR fallback | Tesseract (browser context) |
| PostgreSQL + TimescaleDB | Storage via Prisma |
| Cron | Hourly runs (external) |

---

## 8. Run Commands

```bash
# Single site
node lbscraper/new-run-scraper.js https://betjuicy.com/leaderboard

# Batch (all sites)
node lbscraper/new-run-scraper.js --batch -p

# Batch (specific URLs)
node lbscraper/new-run-scraper.js --batch https://site1.com https://site2.com
```

---

## 9. Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| SITE_TIMEOUT_MS | 90,000 | Max seconds per site |
| delayBetweenSitesMs | 5,000 | Delay between sites |
| scrollUntilStable | true | Full dataset scroll |
| minConfidence | 50 | Minimum extraction confidence |
| hasValidData threshold | 2 | Min entries to save |

---

*Last updated: February 2026*
