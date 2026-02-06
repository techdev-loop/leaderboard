/**
 * API Discovery for LLM Teacher Mode
 * 
 * Uses LLM to analyze API responses and discover:
 * - Historical data patterns
 * - Pagination strategies
 * - Valid site names
 * - ID substitution patterns
 * - Extraction methods
 */

const { log } = require('../utils');

// ============================================================================
// LLM API ANALYSIS
// ============================================================================

/**
 * Analyze API response with LLM to discover historical patterns
 * @param {Object} apiResponse - API response with url and data
 * @param {string} apiUrl - The API URL
 * @param {Object} config - Configuration with LLM settings
 * @returns {Promise<Object>} - Analysis result
 */
async function analyzeApiForHistoricalPatterns(apiResponse, apiUrl, config) {
  if (!config?.llm?.enabled || !config?.llm?.apiKey) {
    log('TEACHER', 'LLM not configured, skipping API analysis');
    return null;
  }
  
  try {
    const { callClaude } = require('./llm-client');
    
    // Truncate response for prompt (avoid token limits)
    const responseStr = JSON.stringify(apiResponse, null, 2);
    const truncatedResponse = responseStr.length > 3000 
      ? responseStr.substring(0, 3000) + '... [truncated]' 
      : responseStr;
    
    const prompt = `Analyze this API response and URL to discover patterns for historical data farming.

## API URL:
${apiUrl}

## API Response:
${truncatedResponse}

## What I Need to Find:

1. **Date Parameters**: Fields suggesting date/period parameters (month, year, startDate, endDate)
2. **Pagination Patterns**: Skip, take, limit, offset, page parameters
3. **Historical Endpoint Hints**: URLs with /previous, /history, /archive patterns
4. **Valid Site Names**: Any field containing lists of valid provider/site names
5. **ID Fields**: IDs that could be used in other endpoints
6. **Substitution Patterns**: URL parameters that can be swapped (site={SITE}, month={MONTH})

## Return JSON with this exact format:
{
  "historicalEndpoint": "/api/leaderboard/previous?site={SITE}&month={MONTH}&year={YEAR}",
  "dateParams": {
    "hasMonthYear": true,
    "monthParam": "month",
    "yearParam": "year",
    "currentMonth": 12,
    "currentYear": 2025
  },
  "paginationParams": {
    "param": "take",
    "currentValue": 10,
    "maxRecommended": 100
  },
  "validSites": ["site1", "site2"],
  "extractedIds": ["id1", "id2"],
  "suggestedVariants": [
    {
      "url": "/api/leaderboard/{SITE}",
      "substituteWith": "keywords",
      "description": "Replace {SITE} with discovered keywords"
    }
  ],
  "historicalFarmingPossible": true,
  "recommendation": "Brief explanation of how to farm historical data"
}

If no patterns are found, return:
{
  "historicalFarmingPossible": false,
  "reason": "Why historical farming is not possible"
}`;

    const response = await callClaude(prompt, {
      ...config,
      maxTokens: 1000
    });
    
    // Parse LLM response
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        log('TEACHER', `LLM API analysis complete: historical=${parsed.historicalFarmingPossible}`);
        return parsed;
      }
    } catch (parseErr) {
      log('ERR', `Failed to parse LLM API analysis: ${parseErr.message}`);
    }
    
  } catch (err) {
    log('ERR', `LLM API analysis failed: ${err.message}`);
  }
  
  return null;
}

/**
 * Analyze multiple API responses to find the best historical pattern
 * @param {Array} apiResponses - Array of API responses
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} - Best historical pattern
 */
async function findBestHistoricalPattern(apiResponses, config) {
  if (!apiResponses || apiResponses.length === 0) return null;
  
  // Priority order for analysis
  const priorityKeywords = ['previous', 'history', 'archive', 'past', 'leaderboard'];
  
  // Sort responses by priority
  const sorted = [...apiResponses].sort((a, b) => {
    const aUrl = (a.url || '').toLowerCase();
    const bUrl = (b.url || '').toLowerCase();
    
    const aScore = priorityKeywords.filter(k => aUrl.includes(k)).length;
    const bScore = priorityKeywords.filter(k => bUrl.includes(k)).length;
    
    return bScore - aScore;
  });
  
  // Analyze top 3 responses with LLM
  const topResponses = sorted.slice(0, 3);
  let bestPattern = null;
  
  for (const response of topResponses) {
    const analysis = await analyzeApiForHistoricalPatterns(
      response.data || response,
      response.url,
      config
    );
    
    if (analysis?.historicalFarmingPossible) {
      bestPattern = analysis;
      log('TEACHER', `Found historical pattern from: ${response.url}`);
      break;
    }
  }
  
  return bestPattern;
}

/**
 * Use LLM to discover extraction config from API structure
 * @param {Array} apiResponses - Captured API responses
 * @param {string} domain - Domain name
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} - Extraction config
 */
async function discoverExtractionConfigFromApis(apiResponses, domain, config) {
  if (!config?.llm?.enabled || !config?.llm?.apiKey) {
    return null;
  }
  
  if (!apiResponses || apiResponses.length === 0) {
    return null;
  }
  
  try {
    const { callClaude } = require('./llm-client');
    
    // Build API summary
    const apiSummary = apiResponses.slice(0, 5).map(r => ({
      url: r.url,
      sampleData: JSON.stringify(r.data || r, null, 2).substring(0, 500)
    }));
    
    const prompt = `Analyze these API responses from ${domain} and create an extraction configuration.

## Captured APIs:
${JSON.stringify(apiSummary, null, 2)}

## Create an extraction config with:

1. **method**: "api", "dom", or "hybrid"
2. **apiConfig**: Endpoints with {SITE}, {TAKE}, {ID}, {MONTH}, {YEAR} placeholders
3. **substitutionRules**: How to substitute placeholders
4. **knownProviders**: Site/provider names found
5. **historicalConfig**: How to get previous data

## Return JSON:
{
  "method": "api",
  "apiConfig": {
    "baseUrl": "https://api.example.com",
    "endpoints": {
      "providers": "/active-providers",
      "leaderboardList": "/leaderboard/{SITE}?take={TAKE}",
      "leaderboardDetails": "/leaderboard/details?id={ID}",
      "historical": "/leaderboard/previous?site={SITE}&month={MONTH}&year={YEAR}"
    },
    "substitutionRules": {
      "{SITE}": { "source": "keywords", "transform": "uppercase" },
      "{TAKE}": { "source": "config", "default": 10, "max": 100 }
    }
  },
  "knownProviders": ["gamdom", "stake"],
  "historicalConfig": {
    "supported": true,
    "minYear": 2025,
    "method": "month-year-params"
  },
  "confidence": 85
}`;

    const response = await callClaude(prompt, {
      ...config,
      maxTokens: 1500
    });
    
    // Parse LLM response
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        log('TEACHER', `Discovered extraction config for ${domain} (confidence: ${parsed.confidence}%)`);
        return parsed;
      }
    } catch (parseErr) {
      log('ERR', `Failed to parse extraction config: ${parseErr.message}`);
    }
    
  } catch (err) {
    log('ERR', `Extraction config discovery failed: ${err.message}`);
  }
  
  return null;
}

/**
 * Analyze an API error to extract information about valid parameters
 * @param {Object} errorResponse - Error response
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} - Extracted information
 */
async function analyzeApiError(errorResponse, config) {
  if (!config?.llm?.enabled) {
    // Use simple extraction without LLM
    const sites = [];
    
    if (errorResponse.message) {
      const match = errorResponse.message.match(/valid\s+(?:sites?|providers?)[:\s]+([a-z,\s]+)/i);
      if (match) {
        sites.push(...match[1].split(',').map(s => s.trim().toLowerCase()));
      }
    }
    
    return { validSites: sites };
  }
  
  try {
    const { callClaude } = require('./llm-client');
    
    const prompt = `Analyze this API error response and extract any useful information:

${JSON.stringify(errorResponse, null, 2)}

Look for:
1. Valid site/provider names mentioned
2. Valid parameter values
3. Correct URL format hints
4. Authentication requirements

Return JSON:
{
  "validSites": ["site1", "site2"],
  "validParams": { "param": ["value1", "value2"] },
  "urlHints": "Any hints about correct URL format",
  "authRequired": false
}`;

    const response = await callClaude(prompt, {
      ...config,
      maxTokens: 500
    });
    
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
  } catch (err) {
    log('ERR', `API error analysis failed: ${err.message}`);
  }
  
  return null;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  analyzeApiForHistoricalPatterns,
  findBestHistoricalPattern,
  discoverExtractionConfigFromApis,
  analyzeApiError
};
