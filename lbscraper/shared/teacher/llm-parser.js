/**
 * LLM Response Parser for Teacher Mode
 * 
 * Parses and validates JSON responses from Claude.
 * Handles:
 * - JSON extraction from markdown code blocks
 * - Schema validation
 * - Browser command validation (Phase 2)
 */

// ============================================================================
// VALID BROWSER COMMANDS
// ============================================================================

const VALID_BROWSER_COMMANDS = ['click', 'scroll', 'wait', 'waitForSelector', 'hover'];

// ============================================================================
// JSON EXTRACTION
// ============================================================================

/**
 * Extract JSON from LLM response text
 * Handles plain JSON and markdown code blocks
 * @param {string} responseText - Raw response text from LLM
 * @returns {Object} - { success, json, error }
 */
function extractJSON(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return { success: false, json: null, error: 'Empty or invalid response' };
  }
  
  let jsonStr = responseText.trim();
  
  // Try to extract from markdown code blocks
  const codeBlockPatterns = [
    /```json\s*([\s\S]*?)```/,
    /```\s*([\s\S]*?)```/,
    /`([\s\S]*?)`/
  ];
  
  for (const pattern of codeBlockPatterns) {
    const match = responseText.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // Check if it looks like JSON
      if (candidate.startsWith('{') || candidate.startsWith('[')) {
        jsonStr = candidate;
        break;
      }
    }
  }
  
  // Try to find JSON object/array in the text
  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
    const jsonStartBrace = responseText.indexOf('{');
    const jsonStartBracket = responseText.indexOf('[');
    
    if (jsonStartBrace >= 0 || jsonStartBracket >= 0) {
      const start = jsonStartBrace >= 0 && (jsonStartBracket < 0 || jsonStartBrace < jsonStartBracket)
        ? jsonStartBrace
        : jsonStartBracket;
      
      // Find matching closing brace/bracket
      const openChar = responseText[start];
      const closeChar = openChar === '{' ? '}' : ']';
      let depth = 0;
      let end = start;
      
      for (let i = start; i < responseText.length; i++) {
        if (responseText[i] === openChar) depth++;
        if (responseText[i] === closeChar) depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
      
      if (end > start) {
        jsonStr = responseText.substring(start, end);
      }
    }
  }
  
  // Parse JSON
  try {
    const json = JSON.parse(jsonStr);
    return { success: true, json, error: null };
  } catch (e) {
    return { success: false, json: null, error: `JSON parse error: ${e.message}` };
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate parsed LLM response data
 * @param {Object} data - Parsed JSON data
 * @returns {Object} - { valid, errors, warnings }
 */
function validateResponse(data) {
  const errors = [];
  const warnings = [];
  
  if (!data || typeof data !== 'object') {
    errors.push('Response is not an object');
    return { valid: false, errors, warnings };
  }
  
  // ===== REQUIRED: llmNotes with confidence =====
  if (!data.llmNotes) {
    errors.push('Missing required field: llmNotes');
  } else {
    if (typeof data.llmNotes.confidence !== 'number') {
      errors.push('llmNotes.confidence must be a number');
    } else if (data.llmNotes.confidence < 0 || data.llmNotes.confidence > 100) {
      errors.push('llmNotes.confidence must be between 0 and 100');
    }
    
    if (data.llmNotes.observations && !Array.isArray(data.llmNotes.observations)) {
      warnings.push('llmNotes.observations should be an array');
    }
  }
  
  // ===== OPTIONAL: dataVerification =====
  if (data.dataVerification) {
    if (typeof data.dataVerification.isCorrect !== 'boolean') {
      warnings.push('dataVerification.isCorrect should be a boolean');
    }
  }
  
  // ===== OPTIONAL: switchers =====
  if (data.switchers) {
    if (!Array.isArray(data.switchers)) {
      errors.push('switchers must be an array');
    } else {
      for (let i = 0; i < data.switchers.length; i++) {
        const sw = data.switchers[i];
        if (!sw.name) {
          warnings.push(`switchers[${i}] missing name`);
        }
        if (!sw.selector && !sw.coordinates) {
          warnings.push(`switchers[${i}] has no selector or coordinates`);
        }
      }
    }
  }
  
  // ===== OPTIONAL: extraction =====
  if (data.extraction) {
    if (typeof data.extraction !== 'object') {
      warnings.push('extraction should be an object');
    }
  }
  
  // ===== OPTIONAL: layoutFingerprint =====
  if (data.layoutFingerprint) {
    if (typeof data.layoutFingerprint.switcherCount !== 'number') {
      warnings.push('layoutFingerprint.switcherCount should be a number');
    }
  }
  
  // ===== OPTIONAL: browserCommands (Phase 2) =====
  if (data.browserCommands) {
    if (!Array.isArray(data.browserCommands)) {
      errors.push('browserCommands must be an array');
    } else {
      for (let i = 0; i < data.browserCommands.length; i++) {
        const cmd = data.browserCommands[i];
        if (!cmd.action) {
          errors.push(`browserCommands[${i}] missing action`);
        } else if (!VALID_BROWSER_COMMANDS.includes(cmd.action)) {
          errors.push(`browserCommands[${i}] has invalid action: ${cmd.action}`);
        }
        
        // Validate click command
        if (cmd.action === 'click') {
          if (!cmd.selector && !cmd.coordinates) {
            errors.push(`browserCommands[${i}] click needs selector or coordinates`);
          }
        }
        
        // Validate waitForSelector command
        if (cmd.action === 'waitForSelector' && !cmd.selector) {
          errors.push(`browserCommands[${i}] waitForSelector needs selector`);
        }
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// ============================================================================
// MAIN PARSER
// ============================================================================

/**
 * Parse and validate LLM response
 * @param {string} responseText - Raw response text from LLM
 * @returns {Object} - { valid, data, errors, warnings }
 */
function parseLLMResponse(responseText) {
  // Extract JSON
  const extraction = extractJSON(responseText);
  
  if (!extraction.success) {
    return {
      valid: false,
      data: null,
      errors: [extraction.error],
      warnings: []
    };
  }
  
  // Validate
  const validation = validateResponse(extraction.json);
  
  return {
    valid: validation.valid,
    data: extraction.json,
    errors: validation.errors,
    warnings: validation.warnings
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract specific fields from LLM response
 * @param {Object} data - Parsed LLM data
 * @returns {Object} - Extracted fields with defaults
 */
function extractFields(data) {
  return {
    confidence: data.llmNotes?.confidence || 0,
    isCorrect: data.dataVerification?.isCorrect ?? true,
    issues: data.dataVerification?.issues || [],
    switchers: data.switchers || [],
    extraction: data.extraction || {},
    apiPatterns: data.apiPatterns || {},
    layoutFingerprint: data.layoutFingerprint || {},
    observations: data.llmNotes?.observations || [],
    warnings: data.llmNotes?.warnings || [],
    browserCommands: data.browserCommands || [],
    finished: data.finished === true,
    missedLeaderboards: data.missedLeaderboards || []
  };
}

/**
 * Check if LLM wants to continue browsing (Phase 2)
 * @param {Object} data - Parsed LLM data
 * @returns {boolean}
 */
function wantsToContinue(data) {
  // Continue if not finished and has browser commands
  if (data.finished === true) return false;
  if (data.browserCommands && data.browserCommands.length > 0) return true;
  
  // Continue if confidence is still low
  const confidence = data.llmNotes?.confidence || 0;
  return confidence < 80;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  parseLLMResponse,
  extractJSON,
  validateResponse,
  extractFields,
  wantsToContinue,
  
  // Constants
  VALID_BROWSER_COMMANDS
};
