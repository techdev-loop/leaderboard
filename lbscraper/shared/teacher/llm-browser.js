/**
 * LLM Browser Controller for Teacher Mode
 * 
 * Provides browser control via command-execute loop.
 * LLM sends JSON commands, this module executes them on Playwright.
 * 
 * NOTE: The LLM does NOT directly control the browser.
 * All commands are validated and executed by this module.
 */

const { log } = require('../utils');

// ============================================================================
// SELECTOR UTILITIES
// ============================================================================

/**
 * Convert jQuery-style selectors to Playwright-compatible selectors
 * LLM sometimes generates jQuery selectors like :contains() which are invalid CSS
 * @param {string} selector - Potentially invalid selector
 * @returns {string} - Valid Playwright selector
 */
function sanitizeSelector(selector) {
  if (!selector || typeof selector !== 'string') {
    return selector;
  }
  
  // Handle :contains('text') - convert to Playwright text selector
  const containsMatch = selector.match(/^(.+?):contains\(['"](.+?)['"]\)$/);
  if (containsMatch) {
    const [, element, text] = containsMatch;
    // Use Playwright's text selector with element filter
    return `${element}:has-text("${text}")`;
  }
  
  // Handle standalone :contains()
  const standaloneContains = selector.match(/:contains\(['"](.+?)['"]\)/);
  if (standaloneContains) {
    const [fullMatch, text] = standaloneContains;
    // Replace :contains with :has-text
    return selector.replace(fullMatch, `:has-text("${text}")`);
  }
  
  return selector;
}

// ============================================================================
// BROWSER CONTROLLER CLASS
// ============================================================================

class LLMBrowserController {
  /**
   * Create browser controller
   * @param {Page} page - Playwright page instance
   * @param {Object} networkData - Network capture data
   */
  constructor(page, networkData) {
    this.page = page;
    this.networkData = networkData;
    this.actionLog = [];
    this.startTime = Date.now();
  }
  
  // ==========================================================================
  // STATE CAPTURE
  // ==========================================================================
  
  /**
   * Capture current page state for LLM
   * @returns {Object} - { url, screenshot, domSummary, apiResponses }
   */
  async captureState() {
    try {
      // Take screenshot
      const screenshot = await this.page.screenshot({ 
        type: 'png', 
        fullPage: false 
      });
      
      // Get current URL
      const url = this.page.url();
      
      // Get simplified DOM structure (not full HTML - too large for context)
      const domSummary = await this.page.evaluate(() => {
        const summarize = (el, depth = 0) => {
          if (depth > 3) return null;
          if (!el || !el.tagName) return null;
          
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          
          // Skip hidden elements
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return null;
          
          const result = {
            tag: el.tagName.toLowerCase(),
            rect: { 
              x: Math.round(rect.x), 
              y: Math.round(rect.y), 
              w: Math.round(rect.width), 
              h: Math.round(rect.height) 
            }
          };
          
          // Add id if present
          if (el.id) result.id = el.id;
          
          // Add first 3 classes
          if (el.className && typeof el.className === 'string') {
            const classes = el.className.split(' ').filter(c => c).slice(0, 3);
            if (classes.length > 0) result.classes = classes;
          }
          
          // Add text content (truncated)
          const text = el.innerText?.trim();
          if (text && text.length <= 100 && !el.children.length) {
            result.text = text;
          }
          
          // Add clickable indicator
          if (['A', 'BUTTON'].includes(el.tagName) || 
              el.getAttribute('role') === 'button' ||
              el.getAttribute('tabindex') === '0') {
            result.clickable = true;
          }
          
          // Recurse into children (limit to first 5)
          const childSummaries = [];
          const children = Array.from(el.children).slice(0, 5);
          for (const child of children) {
            const childSummary = summarize(child, depth + 1);
            if (childSummary) childSummaries.push(childSummary);
          }
          
          if (childSummaries.length > 0) {
            result.children = childSummaries;
          }
          
          return result;
        };
        
        return summarize(document.body);
      });
      
      // Get recent API responses (last 10)
      const apiResponses = (this.networkData.rawJsonResponses || [])
        .slice(-10)
        .map(r => ({
          url: r.url,
          timestamp: r.timestamp,
          data: r.data
        }));
      
      return {
        url,
        screenshot: screenshot.toString('base64'),
        domSummary,
        apiResponses,
        capturedAt: new Date().toISOString()
      };
      
    } catch (err) {
      log('ERR', `Failed to capture state: ${err.message}`, { stack: err.stack });
      return {
        url: this.page.url(),
        screenshot: null,
        domSummary: null,
        apiResponses: [],
        error: err.message
      };
    }
  }
  
  // ==========================================================================
  // COMMAND EXECUTION
  // ==========================================================================
  
  /**
   * Execute a browser command from the LLM
   * @param {Object} cmd - Command object
   * @returns {Object} - { success, error, duration }
   */
  async executeCommand(cmd) {
    const startTime = Date.now();
    
    // Sanitize selector if present (convert jQuery :contains to Playwright :has-text)
    if (cmd.selector) {
      const originalSelector = cmd.selector;
      cmd.selector = sanitizeSelector(cmd.selector);
      if (cmd.selector !== originalSelector) {
        log('BROWSER', `Sanitized selector: "${originalSelector}" -> "${cmd.selector}"`);
      }
    }
    
    // Log command
    log('BROWSER', `Executing: ${cmd.action} ${cmd.selector || JSON.stringify(cmd.coordinates) || ''}`);
    
    this.actionLog.push({
      ...cmd,
      timestamp: Date.now(),
      elapsed: Date.now() - this.startTime
    });
    
    try {
      switch (cmd.action) {
        case 'click':
          await this.executeClick(cmd);
          break;
          
        case 'scroll':
          await this.executeScroll(cmd);
          break;
          
        case 'wait':
          await this.executeWait(cmd);
          break;
          
        case 'waitForSelector':
          await this.executeWaitForSelector(cmd);
          break;
          
        case 'hover':
          await this.executeHover(cmd);
          break;
          
        default:
          log('BROWSER', `Unknown command: ${cmd.action}`);
          return {
            success: false,
            error: `Unknown command: ${cmd.action}`,
            duration: Date.now() - startTime
          };
      }
      
      return {
        success: true,
        error: null,
        duration: Date.now() - startTime
      };
      
    } catch (err) {
      log('ERR', `Command failed: ${err.message}`, { 
        action: cmd.action, 
        selector: cmd.selector,
        coordinates: cmd.coordinates 
      });
      return {
        success: false,
        error: err.message,
        duration: Date.now() - startTime
      };
    }
  }
  
  /**
   * Execute multiple commands in sequence
   * @param {Array} commands - Array of command objects
   * @returns {Array} - Array of results
   */
  async executeCommands(commands) {
    const results = [];
    
    for (const cmd of commands) {
      const result = await this.executeCommand(cmd);
      results.push(result);
      
      // Add small delay between commands
      await this.page.waitForTimeout(300);
    }
    
    return results;
  }
  
  // ==========================================================================
  // COMMAND IMPLEMENTATIONS
  // ==========================================================================
  
  async executeClick(cmd) {
    if (cmd.coordinates) {
      // Click by coordinates
      const { x, y } = cmd.coordinates;
      
      // Move mouse naturally
      await this.page.mouse.move(x - 20, y - 10, { steps: 5 });
      await this.page.waitForTimeout(100);
      await this.page.mouse.move(x, y, { steps: 5 });
      await this.page.waitForTimeout(50);
      
      // Click
      await this.page.mouse.click(x, y);
      
    } else if (cmd.selector) {
      // Click by selector
      await this.page.click(cmd.selector, { timeout: 5000 });
      
    } else {
      throw new Error('Click requires selector or coordinates');
    }
    
    // Wait for any navigation or content change
    await this.page.waitForTimeout(1000);
  }
  
  async executeScroll(cmd) {
    const direction = cmd.direction || 'down';
    const amount = cmd.amount || 300;
    
    await this.page.evaluate(({ dir, amt }) => {
      window.scrollBy(0, dir === 'down' ? amt : -amt);
    }, { dir: direction, amt: amount });
    
    // Wait for lazy-loaded content
    await this.page.waitForTimeout(500);
  }
  
  async executeWait(cmd) {
    const ms = Math.min(cmd.ms || 2000, 10000); // Max 10 seconds
    await this.page.waitForTimeout(ms);
  }
  
  async executeWaitForSelector(cmd) {
    if (!cmd.selector) {
      throw new Error('waitForSelector requires selector');
    }
    
    const timeout = Math.min(cmd.timeout || 5000, 15000); // Max 15 seconds
    await this.page.waitForSelector(cmd.selector, { timeout });
  }
  
  async executeHover(cmd) {
    if (cmd.selector) {
      await this.page.hover(cmd.selector);
    } else if (cmd.coordinates) {
      await this.page.mouse.move(cmd.coordinates.x, cmd.coordinates.y);
    } else {
      throw new Error('Hover requires selector or coordinates');
    }
    
    await this.page.waitForTimeout(500);
  }
  
  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================
  
  /**
   * Get action log
   * @returns {Array}
   */
  getActionLog() {
    return this.actionLog;
  }
  
  /**
   * Get total elapsed time
   * @returns {number} - Milliseconds since controller was created
   */
  getElapsedTime() {
    return Date.now() - this.startTime;
  }
  
  /**
   * Check if page is still on same domain
   * @param {string} originalDomain - Original domain
   * @returns {boolean}
   */
  isOnSameDomain(originalDomain) {
    try {
      const currentUrl = new URL(this.page.url());
      const originalUrl = new URL(originalDomain.startsWith('http') ? originalDomain : `https://${originalDomain}`);
      return currentUrl.hostname === originalUrl.hostname;
    } catch {
      return true;
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  LLMBrowserController
};
