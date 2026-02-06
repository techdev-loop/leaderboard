/**
 * JSON Debug Logger
 *
 * Saves scrape results to timestamped JSON files for debugging.
 * Files are organized by date: results/logs/YYYY-MM-DD/{domain}_{timestamp}.json
 *
 * Features:
 * - Timestamped file names for easy sorting
 * - Organized by date directories
 * - Configurable retention period
 * - Storage statistics tracking
 * - Auto-cleanup of old files
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'results', 'logs');

/**
 * Save scrape result to a timestamped JSON file
 * @param {string} domain - The domain being scraped (e.g., 'elliotrewards.gg')
 * @param {Object} result - The scrape result object
 * @returns {string} - Path to the saved file
 */
function saveDebugLog(domain, result) {
  const now = new Date();
  const dateDir = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timestamp = now.toISOString().replace(/[:.]/g, '-');

  const dirPath = path.join(LOGS_DIR, dateDir);
  const filePath = path.join(dirPath, `${domain}_${timestamp}.json`);

  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));

  return filePath;
}

/**
 * Clean up log files older than the specified retention period
 * @param {number} retentionHours - Hours to keep logs (default: 48)
 * @returns {Object} - { deletedCount, freedBytes }
 */
function cleanupOldLogs(retentionHours = 48) {
  const cutoff = Date.now() - (retentionHours * 60 * 60 * 1000);
  let deletedCount = 0;
  let freedBytes = 0;

  if (!fs.existsSync(LOGS_DIR)) {
    return { deletedCount: 0, freedBytes: 0 };
  }

  // Iterate date directories
  let dateDirs;
  try {
    dateDirs = fs.readdirSync(LOGS_DIR);
  } catch (e) {
    return { deletedCount: 0, freedBytes: 0 };
  }

  for (const dateDir of dateDirs) {
    const datePath = path.join(LOGS_DIR, dateDir);

    let stat;
    try {
      stat = fs.statSync(datePath);
    } catch (e) {
      continue;
    }

    if (!stat.isDirectory()) continue;

    // Check each file in the date directory
    let files;
    try {
      files = fs.readdirSync(datePath);
    } catch (e) {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(datePath, file);

      let fileStat;
      try {
        fileStat = fs.statSync(filePath);
      } catch (e) {
        continue;
      }

      if (fileStat.mtimeMs < cutoff) {
        try {
          freedBytes += fileStat.size;
          fs.unlinkSync(filePath);
          deletedCount++;
        } catch (e) {
          // Failed to delete, skip
        }
      }
    }

    // Remove empty date directories
    try {
      const remaining = fs.readdirSync(datePath);
      if (remaining.length === 0) {
        fs.rmdirSync(datePath);
      }
    } catch (e) {
      // Failed to check/remove directory, skip
    }
  }

  return { deletedCount, freedBytes };
}

/**
 * Get storage statistics for log files
 * @returns {Object} - Storage stats including total files, size, and per-date breakdown
 */
function getStorageStats() {
  const stats = {
    totalFiles: 0,
    totalSizeBytes: 0,
    totalSizeMB: '0.00',
    byDate: {},
    oldestFile: null,
    newestFile: null
  };

  if (!fs.existsSync(LOGS_DIR)) {
    return stats;
  }

  let dateDirs;
  try {
    dateDirs = fs.readdirSync(LOGS_DIR);
  } catch (e) {
    return stats;
  }

  for (const dateDir of dateDirs) {
    const datePath = path.join(LOGS_DIR, dateDir);

    let dirStat;
    try {
      dirStat = fs.statSync(datePath);
    } catch (e) {
      continue;
    }

    if (!dirStat.isDirectory()) continue;

    stats.byDate[dateDir] = { files: 0, sizeBytes: 0 };

    let files;
    try {
      files = fs.readdirSync(datePath);
    } catch (e) {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(datePath, file);

      let fileStat;
      try {
        fileStat = fs.statSync(filePath);
      } catch (e) {
        continue;
      }

      if (!fileStat.isFile()) continue;

      stats.totalFiles++;
      stats.totalSizeBytes += fileStat.size;
      stats.byDate[dateDir].files++;
      stats.byDate[dateDir].sizeBytes += fileStat.size;

      // Track oldest/newest based on modification time
      const mtime = fileStat.mtime.toISOString();
      if (!stats.oldestFile || mtime < stats.oldestFile) {
        stats.oldestFile = mtime;
      }
      if (!stats.newestFile || mtime > stats.newestFile) {
        stats.newestFile = mtime;
      }
    }
  }

  stats.totalSizeMB = (stats.totalSizeBytes / (1024 * 1024)).toFixed(2);

  return stats;
}

module.exports = {
  saveDebugLog,
  cleanupOldLogs,
  getStorageStats,
  LOGS_DIR
};
