require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = 3333;

// API endpoint to get all sites
app.get('/api/sites', async (req, res) => {
  try {
    const sites = await prisma.leaderboardSite.findMany({
      orderBy: { lastScrapedAt: 'desc' }
    });
    res.json(sites);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to get leaderboards for a site
app.get('/api/sites/:siteId/leaderboards', async (req, res) => {
  try {
    const cycles = await prisma.leaderboardCycle.findMany({
      where: { siteId: req.params.siteId },
      orderBy: { startedAt: 'desc' }
    });

    // Deduplicate by siteName (keep latest)
    const seen = new Set();
    const unique = [];
    for (const cycle of cycles) {
      if (!seen.has(cycle.siteName)) {
        seen.add(cycle.siteName);
        unique.push(cycle);
      }
    }

    res.json(unique);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to get all snapshots for a cycle (for version selector)
app.get('/api/cycles/:cycleId/snapshots', async (req, res) => {
  try {
    const snapshots = await prisma.leaderboardSnapshot.findMany({
      where: { cycleId: req.params.cycleId },
      orderBy: { scrapedAt: 'desc' },
      select: {
        id: true,
        scrapedAt: true,
        confidence: true,
        extractionMethod: true,
        totalWager: true,
        prizePool: true,
        _count: {
          select: { entries: true }
        }
      }
    });

    res.json(snapshots.map(s => ({
      id: s.id,
      scrapedAt: s.scrapedAt,
      confidence: s.confidence,
      extractionMethod: s.extractionMethod,
      totalWager: s.totalWager,
      prizePool: s.prizePool,
      entryCount: s._count.entries
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to get entries for a specific snapshot
app.get('/api/snapshots/:snapshotId/entries', async (req, res) => {
  try {
    const snapshot = await prisma.leaderboardSnapshot.findUnique({
      where: { id: req.params.snapshotId },
      include: {
        entries: {
          orderBy: { rank: 'asc' }
        }
      }
    });

    if (!snapshot) {
      return res.json({ snapshot: null, entries: [] });
    }

    res.json({
      snapshot: {
        id: snapshot.id,
        scrapedAt: snapshot.scrapedAt,
        confidence: snapshot.confidence,
        extractionMethod: snapshot.extractionMethod,
        totalWager: snapshot.totalWager,
        prizePool: snapshot.prizePool
      },
      entries: snapshot.entries
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to get entries for a specific leaderboard cycle (latest snapshot)
app.get('/api/cycles/:cycleId/entries', async (req, res) => {
  try {
    const snapshot = await prisma.leaderboardSnapshot.findFirst({
      where: { cycleId: req.params.cycleId },
      orderBy: { scrapedAt: 'desc' },
      include: {
        entries: {
          orderBy: { rank: 'asc' }
          // No limit - get all entries
        }
      }
    });

    if (!snapshot) {
      return res.json({ snapshot: null, entries: [] });
    }

    res.json({
      snapshot: {
        id: snapshot.id,
        scrapedAt: snapshot.scrapedAt,
        confidence: snapshot.confidence,
        extractionMethod: snapshot.extractionMethod,
        totalWager: snapshot.totalWager,
        prizePool: snapshot.prizePool
      },
      entries: snapshot.entries
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to get stats
app.get('/api/stats', async (req, res) => {
  try {
    const [siteCount, cycleCount, snapshotCount, entryCount] = await Promise.all([
      prisma.leaderboardSite.count(),
      prisma.leaderboardCycle.count(),
      prisma.leaderboardSnapshot.count(),
      prisma.leaderboardEntry.count()
    ]);

    res.json({
      sites: siteCount,
      cycles: cycleCount,
      snapshots: snapshotCount,
      entries: entryCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the main HTML page
app.get('/', async (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Argus Database Viewer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; }

    .container { display: flex; height: 100vh; }

    /* Sidebar */
    .sidebar { width: 280px; background: #1a1a1a; border-right: 1px solid #333; display: flex; flex-direction: column; }
    .sidebar-header { padding: 20px; border-bottom: 1px solid #333; }
    .sidebar-header h1 { color: #00ff88; font-size: 18px; margin-bottom: 5px; }
    .sidebar-header .subtitle { color: #666; font-size: 12px; }

    .site-list { flex: 1; overflow-y: auto; }
    .site-item { padding: 12px 20px; cursor: pointer; border-bottom: 1px solid #252525; transition: background 0.2s; }
    .site-item:hover { background: #252525; }
    .site-item.active { background: #2a3a2a; border-left: 3px solid #00ff88; }
    .site-item .domain { font-weight: 500; color: #fff; margin-bottom: 3px; }
    .site-item .meta { font-size: 11px; color: #666; }

    /* Main content */
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

    .header { padding: 15px 25px; background: #1a1a1a; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
    .header h2 { color: #00aaff; font-size: 16px; }

    .stats { display: flex; gap: 15px; }
    .stat { background: #252525; padding: 8px 15px; border-radius: 6px; text-align: center; }
    .stat .number { font-size: 18px; font-weight: bold; color: #00ff88; }
    .stat .label { font-size: 10px; color: #666; text-transform: uppercase; }

    /* Leaderboard tabs */
    .tabs { display: flex; gap: 5px; padding: 15px 25px; background: #151515; border-bottom: 1px solid #333; flex-wrap: wrap; }
    .tab { padding: 8px 16px; background: #252525; border: none; border-radius: 6px; color: #888; cursor: pointer; font-size: 13px; transition: all 0.2s; }
    .tab:hover { background: #333; color: #fff; }
    .tab.active { background: #00aaff; color: #000; font-weight: 500; }

    /* Snapshot selector */
    .snapshot-selector { display: flex; align-items: center; gap: 10px; padding: 10px 25px; background: #1a1a1a; border-bottom: 1px solid #333; }
    .snapshot-selector label { color: #888; font-size: 12px; }
    .snapshot-selector select {
      background: #252525;
      color: #fff;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      min-width: 300px;
    }
    .snapshot-selector select:hover { border-color: #00aaff; }
    .snapshot-selector select:focus { outline: none; border-color: #00aaff; }
    .snapshot-selector .snapshot-count { color: #666; font-size: 11px; margin-left: 10px; }

    /* Entries table */
    .content { flex: 1; overflow-y: auto; padding: 20px 25px; }

    .snapshot-info { display: flex; gap: 20px; margin-bottom: 15px; color: #666; font-size: 12px; flex-wrap: wrap; }
    .snapshot-info span { background: #1a1a1a; padding: 5px 10px; border-radius: 4px; }
    .snapshot-info .confidence { color: #00ff88; }
    .snapshot-info .method { color: #00aaff; }

    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 10px 12px; color: #666; border-bottom: 2px solid #333; font-weight: 500; text-transform: uppercase; font-size: 11px; position: sticky; top: 0; background: #0f0f0f; }
    td { padding: 10px 12px; border-bottom: 1px solid #222; }
    tr:hover { background: #1a1a1a; }

    .rank { color: #ffaa00; font-weight: bold; width: 60px; }
    .rank-1 { color: #ffd700; }
    .rank-2 { color: #c0c0c0; }
    .rank-3 { color: #cd7f32; }
    .username { color: #fff; }
    .wager { color: #00ff88; text-align: right; font-family: 'SF Mono', Monaco, monospace; }
    .prize { color: #00aaff; text-align: right; font-family: 'SF Mono', Monaco, monospace; }

    .empty { color: #666; font-style: italic; padding: 40px; text-align: center; }
    .loading { color: #666; padding: 40px; text-align: center; }

    /* Entry count badge */
    .entry-count { background: #333; color: #888; font-size: 11px; padding: 2px 6px; border-radius: 10px; margin-left: 5px; }
    .tab.active .entry-count { background: rgba(0,0,0,0.2); color: #000; }

    /* Hide snapshot selector when no leaderboard selected */
    .snapshot-selector.hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <div class="sidebar-header">
        <h1>Argus Viewer</h1>
        <div class="subtitle">Database Explorer</div>
      </div>
      <div class="site-list" id="siteList">
        <div class="loading">Loading sites...</div>
      </div>
    </div>

    <div class="main">
      <div class="header">
        <h2 id="currentSite">Select a site</h2>
        <div class="stats" id="stats"></div>
      </div>

      <div class="tabs" id="tabs"></div>

      <div class="snapshot-selector hidden" id="snapshotSelector">
        <label>Snapshot Version:</label>
        <select id="snapshotDropdown" onchange="selectSnapshot(this.value)">
          <option value="">Loading snapshots...</option>
        </select>
        <span class="snapshot-count" id="snapshotCount"></span>
      </div>

      <div class="content" id="content">
        <div class="empty">Select a site from the sidebar to view leaderboards</div>
      </div>
    </div>
  </div>

  <script>
    let currentSiteId = null;
    let currentCycleId = null;
    let currentSnapshotId = null;
    let leaderboards = [];
    let snapshots = [];

    // Load stats
    async function loadStats() {
      const res = await fetch('/api/stats');
      const stats = await res.json();
      document.getElementById('stats').innerHTML = \`
        <div class="stat"><div class="number">\${stats.sites}</div><div class="label">Sites</div></div>
        <div class="stat"><div class="number">\${stats.cycles}</div><div class="label">Leaderboards</div></div>
        <div class="stat"><div class="number">\${stats.snapshots}</div><div class="label">Snapshots</div></div>
        <div class="stat"><div class="number">\${stats.entries.toLocaleString()}</div><div class="label">Entries</div></div>
      \`;
    }

    // Load site list
    async function loadSites() {
      const res = await fetch('/api/sites');
      const sites = await res.json();

      const siteList = document.getElementById('siteList');
      if (sites.length === 0) {
        siteList.innerHTML = '<div class="empty">No sites yet</div>';
        return;
      }

      siteList.innerHTML = sites.map(site => \`
        <div class="site-item" data-id="\${site.id}" onclick="selectSite('\${site.id}', '\${site.domain}')">
          <div class="domain">\${site.domain}</div>
          <div class="meta">Last scraped: \${site.lastScrapedAt ? new Date(site.lastScrapedAt).toLocaleString() : 'Never'}</div>
        </div>
      \`).join('');
    }

    // Select a site
    async function selectSite(siteId, domain) {
      currentSiteId = siteId;

      // Update sidebar selection
      document.querySelectorAll('.site-item').forEach(el => el.classList.remove('active'));
      document.querySelector(\`.site-item[data-id="\${siteId}"]\`).classList.add('active');

      // Update header
      document.getElementById('currentSite').textContent = domain;

      // Hide snapshot selector until leaderboard is selected
      document.getElementById('snapshotSelector').classList.add('hidden');

      // Load leaderboards for this site
      const res = await fetch(\`/api/sites/\${siteId}/leaderboards\`);
      leaderboards = await res.json();

      // Render tabs
      const tabs = document.getElementById('tabs');
      if (leaderboards.length === 0) {
        tabs.innerHTML = '';
        document.getElementById('content').innerHTML = '<div class="empty">No leaderboards for this site</div>';
        return;
      }

      tabs.innerHTML = leaderboards.map((lb, i) => \`
        <button class="tab \${i === 0 ? 'active' : ''}" data-cycle-id="\${lb.id}" onclick="selectLeaderboard('\${lb.id}')">
          \${lb.siteName}
        </button>
      \`).join('');

      // Select first leaderboard
      selectLeaderboard(leaderboards[0].id);
    }

    // Select a leaderboard
    async function selectLeaderboard(cycleId) {
      currentCycleId = cycleId;
      currentSnapshotId = null;

      // Update tab selection
      document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      document.querySelector(\`.tab[data-cycle-id="\${cycleId}"]\`).classList.add('active');

      // Show loading
      document.getElementById('content').innerHTML = '<div class="loading">Loading snapshots...</div>';

      // Load all snapshots for this cycle
      const snapshotRes = await fetch(\`/api/cycles/\${cycleId}/snapshots\`);
      snapshots = await snapshotRes.json();

      // Show snapshot selector
      const selector = document.getElementById('snapshotSelector');
      const dropdown = document.getElementById('snapshotDropdown');
      const countLabel = document.getElementById('snapshotCount');

      if (snapshots.length === 0) {
        selector.classList.add('hidden');
        document.getElementById('content').innerHTML = '<div class="empty">No snapshots for this leaderboard</div>';
        return;
      }

      // Populate dropdown
      dropdown.innerHTML = snapshots.map((snap, i) => {
        const date = new Date(snap.scrapedAt);
        const dateStr = date.toLocaleDateString();
        const timeStr = date.toLocaleTimeString();
        const label = \`\${dateStr} \${timeStr} - \${snap.entryCount} entries, \${snap.confidence}% confidence (\${snap.extractionMethod})\`;
        return \`<option value="\${snap.id}" \${i === 0 ? 'selected' : ''}>\${label}</option>\`;
      }).join('');

      countLabel.textContent = \`\${snapshots.length} snapshot\${snapshots.length === 1 ? '' : 's'} available\`;
      selector.classList.remove('hidden');

      // Update tab with entry count from latest snapshot
      const tab = document.querySelector(\`.tab[data-cycle-id="\${cycleId}"]\`);
      const tabName = tab.textContent.split('<')[0].trim();
      tab.innerHTML = tabName + \` <span class="entry-count">\${snapshots[0].entryCount}</span>\`;

      // Load entries for the first (latest) snapshot
      selectSnapshot(snapshots[0].id);
    }

    // Select a specific snapshot
    async function selectSnapshot(snapshotId) {
      currentSnapshotId = snapshotId;

      // Load entries
      document.getElementById('content').innerHTML = '<div class="loading">Loading entries...</div>';

      const res = await fetch(\`/api/snapshots/\${snapshotId}/entries\`);
      const data = await res.json();

      if (!data.snapshot || data.entries.length === 0) {
        document.getElementById('content').innerHTML = '<div class="empty">No entries in this snapshot</div>';
        return;
      }

      // Render snapshot info and entries
      const snapshotTime = new Date(data.snapshot.scrapedAt).toLocaleString();
      const totalWager = data.snapshot.totalWager ? '$' + Number(data.snapshot.totalWager).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-';
      const prizePool = data.snapshot.prizePool ? '$' + Number(data.snapshot.prizePool).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-';

      let html = \`
        <div class="snapshot-info">
          <span>Scraped: \${snapshotTime}</span>
          <span class="confidence">Confidence: \${data.snapshot.confidence}%</span>
          <span class="method">Method: \${data.snapshot.extractionMethod}</span>
          <span>Entries: \${data.entries.length}</span>
          <span>Total Wagered: \${totalWager}</span>
          <span>Prize Pool: \${prizePool}</span>
        </div>
        <table>
          <tr>
            <th>Rank</th>
            <th>Username</th>
            <th style="text-align:right">Wager</th>
            <th style="text-align:right">Prize</th>
          </tr>
      \`;

      for (const entry of data.entries) {
        const rankClass = entry.rank <= 3 ? \`rank-\${entry.rank}\` : '';
        const wager = entry.wager ? '$' + Number(entry.wager).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-';
        const prize = entry.prize ? '$' + Number(entry.prize).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-';

        html += \`
          <tr>
            <td class="rank \${rankClass}">#\${entry.rank}</td>
            <td class="username">\${escapeHtml(entry.username)}</td>
            <td class="wager">\${wager}</td>
            <td class="prize">\${prize}</td>
          </tr>
        \`;
      }

      html += '</table>';
      document.getElementById('content').innerHTML = html;
    }

    function escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // Initialize
    loadStats();
    loadSites();
  </script>
</body>
</html>
`;

  res.send(html);
});

app.listen(PORT, () => {
  console.log(`Admin viewer running at http://localhost:${PORT}`);
});
