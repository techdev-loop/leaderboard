# Claude Vision Teaching System - Implementation Plan

## Current Architecture Understanding

The scraper has **5 extraction strategies** that run in priority order:
1. **API Extraction** (priority 1) - Best source, structured data
2. **Markdown Extraction** (priority 1.5) - Parses converted HTML
3. **DOM Extraction** (priority 2) - Direct HTML parsing
4. **Geometric Extraction** (priority 3) - Visual/spatial analysis
5. **OCR Extraction** (priority 4) - Tesseract fallback (garbage)

**Data Fusion** runs all strategies and cross-validates results.

## What Claude Vision Should Teach (NOT Replace)

Vision should **teach configuration**, NOT extract data every time:

| What Vision Teaches | How It's Used |
|---------------------|---------------|
| Column order (prize vs wager first) | Passed to markdown/DOM parsers |
| Podium layout type (center=1 vs left-to-right) | Corrects rank assignment |
| Tab/button names for each leaderboard | Used by crawler discovery |
| "Show more" button presence | Orchestrator knows to click |
| Scroll requirements | Page scraper scrolls appropriately |
| Table vs cards vs list format | Selects correct parser |

## Edge Cases To Handle

### 1. Button-Based Sites (ilovemav, wrewards)
- Need to discover ALL tabs/buttons
- Click each one and capture config
- Save per-leaderboard configs

### 2. "Show More" / Pagination (wrewards, devlrewards)
- Detect presence of load-more buttons
- Click until all entries visible
- May need multiple screenshots

### 3. Long Scrolling Lists (50-100 entries)
- Full page screenshot may be huge (>20MB)
- Option A: Multiple viewport screenshots stitched
- Option B: Scroll and extract in chunks
- Option C: Only screenshot visible portion, note "has_more_below"

### 4. Podium Sorting Issues
- Center-podium layout: visual order ≠ DOM order
- Vision can identify: "center card is rank 1, left is rank 2, right is rank 3"
- Save as: `podium_layout: "center_first"` or `"left_to_right"`

### 5. API-First Sites (good APIs)
- If API provides complete data, Vision is less important
- Still useful to detect column order for validation
- Can skip Vision if API confidence > 90%

## Teaching Flow Design

```
┌─────────────────────────────────────────────────────────────────────┐
│                     PHASE 1: DISCOVERY                               │
│                                                                      │
│  1. Navigate to leaderboard page                                     │
│  2. Screenshot the page                                              │
│  3. Vision: "What leaderboard tabs/buttons do you see?"              │
│     Returns: ["luxdrop", "chicken", "shock"]                         │
│  4. Save discovered tabs to profile                                  │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  PHASE 2: PER-LEADERBOARD TEACHING                   │
│                                                                      │
│  FOR EACH discovered tab:                                            │
│    1. Click tab (or navigate to URL)                                 │
│    2. Check for "Show More" - click if present                       │
│    3. Scroll to load all content                                     │
│    4. Screenshot (may need multiple for long lists)                  │
│    5. Vision: "Analyze this leaderboard structure"                   │
│       Returns:                                                       │
│       - column_order: "prize_before_wager"                           │
│       - podium_layout: "center_first"                                │
│       - has_show_more: false (already clicked)                       │
│       - total_entries_visible: 10                                    │
│       - entry_format: "table" | "cards" | "list"                     │
│    6. Save config for this leaderboard                               │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PHASE 3: VALIDATION                               │
│                                                                      │
│  1. Run actual extraction with learned config                        │
│  2. Vision: "Does this extracted data look correct?"                 │
│     - Compare Vision's count vs extracted count                      │
│     - Verify rank order matches visual                               │
│  3. If mismatch > threshold, flag for manual review                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Config Structure (site-profiles.json)

```json
{
  "ilovemav.com": {
    "lastTeachingRun": "2026-02-01T12:00:00Z",
    "discoveredTabs": ["luxdrop", "chicken", "shock"],
    "leaderboards": {
      "luxdrop": {
        "column_order": "wager_before_prize",
        "podium_layout": "center_first",
        "entry_format": "cards",
        "has_show_more": true,
        "scroll_required": true,
        "typical_entry_count": 21,
        "confidence": 95
      },
      "chicken": {
        "column_order": "prize_before_wager",
        "podium_layout": "left_to_right",
        "entry_format": "table",
        "has_show_more": false,
        "scroll_required": false,
        "typical_entry_count": 11,
        "confidence": 95
      }
    }
  }
}
```

## Test Sites Selection (10 sites)

Mix of different patterns:

| Site | Pattern | Why Include |
|------|---------|-------------|
| **wrewards.com** | Button-based + Show More + Long list | Reference site, complex |
| **devlrewards.com** | Button-based + 50-100 entries | Long scrolling |
| **goatgambles.com** | Button-based + Multiple LBs | Reference site |
| **paxgambles.com** | URL-based + Simple | Reference site |
| **ilovemav.com** | Button-based + Multiple tabs | Missed tabs before |
| **spencerrewards.com** | URL-based + Reward column | Column order issue |
| **ravengambles.com** | Button-based | New site to test |
| **tanskidegen.com** | Button-based | New site to test |
| **adukes.com** | URL-based | New site to test |
| **rwrds.gg** | URL-based + popup issues | Had popup before |

## Vision Prompts

### Discovery Prompt
```
Look at this leaderboard page screenshot.

1. Identify ALL clickable tabs, buttons, or links that switch between different casino/gambling site leaderboards.
2. List the names you see (e.g., "Gamdom", "Stake", "Packdraw", "CSGORoll", etc.)
3. Note if there's a dropdown menu that might contain more options.
4. Note if there's a "Show More" or "Load More" button visible.

Return JSON:
{
  "tabs_found": ["name1", "name2"],
  "has_dropdown": false,
  "has_show_more": false,
  "current_active_tab": "name1",
  "notes": ""
}
```

### Structure Analysis Prompt
```
Analyze this leaderboard screenshot and determine its structure.

1. Column Order: Look at the table/list headers. Is "Prize/Reward" before or after "Wagered/Wager"?
2. Podium Layout: For the top 3, is #1 in the center (with #2 left, #3 right) or left-to-right?
3. Entry Format: Is it a table, card layout, or simple list?
4. Visible Entries: How many entries can you see?

Return JSON:
{
  "column_order": "prize_before_wager" | "wager_before_prize" | "unknown",
  "podium_layout": "center_first" | "left_to_right" | "no_podium",
  "entry_format": "table" | "cards" | "list",
  "visible_entries": 10,
  "has_more_below": true,
  "notes": ""
}
```

### Validation Prompt
```
I extracted this leaderboard data:
{extracted_data}

Looking at the screenshot, verify:
1. Does the entry count match what you see?
2. Is rank #1 the correct user?
3. Are wager and prize columns in the right order?

Return JSON:
{
  "count_matches": true,
  "rank1_correct": true,
  "columns_correct": true,
  "issues": []
}
```

## Cost Estimate

- Discovery: ~$0.01 per site
- Structure analysis: ~$0.01 per leaderboard
- Validation: ~$0.01 per leaderboard

For 10 test sites with ~3 leaderboards each:
- Discovery: 10 × $0.01 = $0.10
- Structure: 30 × $0.01 = $0.30
- Validation: 30 × $0.01 = $0.30
- **Total: ~$0.70 for full test**

For all 650 sites (one-time teaching):
- ~$6.50 discovery
- ~$19.50 structure (assuming 3 LBs per site)
- **Total: ~$26 one-time cost**

## Implementation Steps

1. **Create `vision-teacher.js`** - Main teaching orchestrator
2. **Create `vision-prompts.js`** - Prompt templates
3. **Update `site-profiles.js`** - Store learned configs
4. **Update `scrape-orchestrator.js`** - Use learned configs
5. **Create `test-vision-teaching.js`** - Test on 10 sites
6. **Generate HTML report** - Viewable results

## Success Criteria

- [ ] All 10 test sites get complete configs
- [ ] Podium sorting correct on all sites
- [ ] All tabs discovered on button-based sites
- [ ] "Show More" correctly detected and clicked
- [ ] Column order correctly identified
- [ ] Validation confirms extracted data matches visual
