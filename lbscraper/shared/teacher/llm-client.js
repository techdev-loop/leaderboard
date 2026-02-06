/**
 * LLM Client for Teacher Mode
 * 
 * Wraps the Claude API with:
 * - Cost tracking integration
 * - Retry logic
 * - Vision (image) support
 * - Token limit enforcement
 */

const { log } = require('../utils');
const { trackUsage, checkBudget, getLimits } = require('./cost-tracker');

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ============================================================================
// CLIENT INITIALIZATION
// ============================================================================

let anthropicClient = null;

/**
 * Initialize the Anthropic client
 * @returns {Object|null} - Anthropic client or null if not configured
 */
function getClient() {
  if (anthropicClient) return anthropicClient;
  
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('ERR', 'ANTHROPIC_API_KEY not set in environment');
    return null;
  }
  
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey });
    log('LLM', 'Anthropic client initialized');
    return anthropicClient;
  } catch (err) {
    log('ERR', `Failed to initialize Anthropic client: ${err.message}`, { 
      hint: 'npm install @anthropic-ai/sdk' 
    });
    return null;
  }
}

// ============================================================================
// MAIN API CALL
// ============================================================================

/**
 * Call Claude API with optional image support
 * @param {Object} options - Call options
 * @param {string} options.systemPrompt - System prompt
 * @param {string} options.userMessage - User message
 * @param {string} options.basePath - Base path for cost tracking
 * @param {string} options.domain - Domain for cost tracking
 * @param {string} [options.imageBase64] - Optional base64 encoded image
 * @param {number} [options.maxTokens] - Max output tokens
 * @param {string} [options.model] - Model to use
 * @returns {Object} - { success, content, usage, error }
 */
async function callClaude(options) {
  // Input validation
  if (!options || typeof options !== 'object') {
    return { success: false, content: null, usage: null, error: 'Options must be an object' };
  }
  
  const {
    systemPrompt,
    userMessage,
    basePath,
    domain = 'unknown',
    imageBase64 = null,
    maxTokens = DEFAULT_MAX_TOKENS,
    model = DEFAULT_MODEL
  } = options;
  
  // Validate required parameters
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return { success: false, content: null, usage: null, error: 'systemPrompt is required and must be a string' };
  }
  if (!userMessage || typeof userMessage !== 'string') {
    return { success: false, content: null, usage: null, error: 'userMessage is required and must be a string' };
  }
  if (!basePath || typeof basePath !== 'string') {
    return { success: false, content: null, usage: null, error: 'basePath is required and must be a string' };
  }
  
  // Check budget before making call
  const budgetCheck = checkBudget(basePath, domain);
  if (!budgetCheck.allowed) {
    log('LLM', `Call blocked: ${budgetCheck.reason}`);
    return {
      success: false,
      content: null,
      usage: null,
      error: `Budget limit: ${budgetCheck.reason}`
    };
  }
  
  // Get client
  const client = getClient();
  if (!client) {
    return {
      success: false,
      content: null,
      usage: null,
      error: 'Anthropic client not initialized'
    };
  }
  
  // Enforce token limit
  const limits = getLimits();
  const effectiveMaxTokens = Math.min(maxTokens, limits.maxTokensPerCall);
  
  // Build message content
  let messageContent;
  if (imageBase64) {
    messageContent = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageBase64
        }
      },
      {
        type: 'text',
        text: userMessage
      }
    ];
  } else {
    messageContent = userMessage;
  }
  
  // Make API call with retries
  let lastError = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log('LLM', `Calling Claude (attempt ${attempt}/${MAX_RETRIES})...`);
      
      const response = await client.messages.create({
        model,
        max_tokens: effectiveMaxTokens,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: messageContent
        }]
      });
      
      // Track usage
      const usageTracked = trackUsage(basePath, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model
      }, domain);
      
      log('LLM', `Response received: ${response.usage.output_tokens} tokens`);
      
      return {
        success: true,
        content: response.content[0].text,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cost: usageTracked.cost
        },
        stopReason: response.stop_reason,
        error: null
      };
      
    } catch (err) {
      lastError = err;
      log('ERR', `LLM attempt ${attempt} failed: ${err.message}`, { status: err.status });
      
      // Check if retryable
      if (err.status === 429 || err.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          log('LLM', `Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
      }
      
      // Non-retryable error
      break;
    }
  }
  
  return {
    success: false,
    content: null,
    usage: null,
    error: lastError?.message || 'Unknown error'
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if LLM is available (SDK installed and API key set)
 * @returns {boolean}
 */
function isLLMAvailable() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return false;
  }
  
  try {
    require('@anthropic-ai/sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Teacher Mode is enabled
 * @returns {boolean}
 */
function isTeacherModeEnabled() {
  const enabled = process.env.LLM_TEACHER_ENABLED;
  return enabled === 'true' || enabled === '1';
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  callClaude,
  getClient,
  isLLMAvailable,
  isTeacherModeEnabled,
  
  // Constants
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  MAX_RETRIES
};
