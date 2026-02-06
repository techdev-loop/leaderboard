/**
 * Challenge Bypass Module v3.0 (PRODUCTION)
 * 
 * FIXED: 2Captcha integration - POST instead of GET, proper timing
 * ENHANCED: Better sitekey detection for Cloudflare Turnstile
 * ENHANCED: Detailed logging for debugging
 * 
 * Supports:
 * - Cloudflare Turnstile (with enhanced sitekey extraction)
 * - Cloudflare "I'm Under Attack" mode
 * - hCaptcha
 * - reCAPTCHA v2/v3
 * - Vercel Protection
 * - DataDome
 * 
 * Strategy:
 * 1. Detect challenge type
 * 2. Extract sitekey via multiple methods (enhanced)
 * 3. Try manual interaction first (click checkbox, wait for auto-solve)
 * 4. Fall back to 2Captcha API if manual fails
 * 5. Inject solution and proceed
 */

const axios = require('axios');
const { log } = require('./shared/utils');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // 2Captcha settings - FIXED TIMING per their documentation
  twoCaptcha: {
    apiUrl: 'https://2captcha.com',
    inEndpoint: '/in.php',
    resEndpoint: '/res.php',
    initialWaitTime: 15000,  // Wait 15 seconds before first poll (per 2Captcha docs)
    pollInterval: 5000,      // 5 seconds between polls
    maxWaitTime: 180000,     // 3 minutes max wait
  },
  
  // Manual bypass settings
  manual: {
    maxAttempts: 3,
    waitAfterClick: 4000,    // Wait 4s after clicking
    waitForChallenge: 10000, // Wait up to 10s for challenge to appear
  },
  
  // Detection settings
  detection: {
    waitForLoad: 3000,       // Wait 3s for page to fully load before detecting
  }
};

// ============================================================================
// LOGGING (using shared structured logging)
// ============================================================================

function log2Captcha(message, data = null) {
  log('2CAPTCHA', message, data);
}

function logChallenge(message, data = null) {
  log('CHALLENGE', message, data);
}

// ============================================================================
// CHALLENGE DETECTION
// ============================================================================

/**
 * Challenge types we can detect and handle
 */
const ChallengeType = {
  NONE: 'none',
  CLOUDFLARE_TURNSTILE: 'cloudflare_turnstile',
  CLOUDFLARE_IUAM: 'cloudflare_iuam',  // "I'm Under Attack Mode"
  HCAPTCHA: 'hcaptcha',
  RECAPTCHA_V2: 'recaptcha_v2',
  RECAPTCHA_V3: 'recaptcha_v3',
  VERCEL: 'vercel',
  DATADOME: 'datadome',
  UNKNOWN: 'unknown'
};

/**
 * Detect what type of challenge is present on the page
 * ENHANCED: Better sitekey extraction with multiple methods
 */
async function detectChallenge(page) {
  // Wait a moment for any challenges to render
  await page.waitForTimeout(CONFIG.detection.waitForLoad);
  
  const detection = await page.evaluate(() => {
    const result = {
      type: 'none',
      confidence: 0,
      sitekey: null,
      pageUrl: window.location.href,
      indicators: {},
      extractionMethod: null
    };
    
    const html = document.documentElement.innerHTML.toLowerCase();
    const bodyText = document.body.innerText.toLowerCase();
    
    // ========== CLOUDFLARE TURNSTILE ==========
    // Check for title in multiple languages (English, Swedish, German, French, Spanish)
    const titleLower = document.title.toLowerCase();
    const hasCfTitle = titleLower.includes('just a moment') || 
                       titleLower.includes('vänta') ||           // Swedish
                       titleLower.includes('einen moment') ||    // German
                       titleLower.includes('un instant') ||      // French
                       titleLower.includes('un momento');        // Spanish
    
    const cfTurnstile = {
      hasIframe: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
      hasContainer: !!document.querySelector('.cf-turnstile, [class*="cf-turnstile"]'),
      hasScript: !!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]'),
      hasSitekey: !!document.querySelector('[data-sitekey]'),
      hasTitle: hasCfTitle,
    };
    
    const cfTurnstileScore = Object.values(cfTurnstile).filter(Boolean).length;
    if (cfTurnstileScore >= 2) {
      result.type = 'cloudflare_turnstile';
      result.confidence = cfTurnstileScore;
      result.indicators.cloudflare_turnstile = cfTurnstile;
      
      // Method 1: data-sitekey attribute on cf-turnstile container
      if (!result.sitekey) {
        const turnstileEl = document.querySelector('.cf-turnstile[data-sitekey], [class*="cf-turnstile"][data-sitekey]');
        if (turnstileEl) {
          result.sitekey = turnstileEl.getAttribute('data-sitekey');
          result.extractionMethod = 'cf-turnstile-container';
        }
      }
      
      // Method 2: Any element with data-sitekey
      if (!result.sitekey) {
        const sitekeyEl = document.querySelector('[data-sitekey]');
        if (sitekeyEl) {
          const key = sitekeyEl.getAttribute('data-sitekey');
          if (key && key.length > 20) {
            result.sitekey = key;
            result.extractionMethod = 'data-sitekey-attr';
          }
        }
      }
      
      // Method 3: Extract from iframe src
      if (!result.sitekey) {
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (iframe) {
          const match = iframe.src.match(/sitekey=([0-9A-Za-z_-]+)/);
          if (match && match[1].length > 20) {
            result.sitekey = match[1];
            result.extractionMethod = 'iframe-src';
          }
        }
      }
      
      // Method 4: Extract from script tags
      if (!result.sitekey) {
        const scripts = document.querySelectorAll('script:not([src])');
        for (const script of scripts) {
          const content = script.textContent || script.innerHTML || '';
          const patterns = [
            /sitekey['":\s]+['"]([0-9A-Za-z_-]{30,})['"]/i,
            /data-sitekey['":\s]+['"]([0-9A-Za-z_-]{30,})['"]/i,
            /turnstile.*?['"]([0-9A-Za-z_-]{30,})['"]/i,
          ];
          for (const pattern of patterns) {
            const match = content.match(pattern);
            if (match && match[1].length > 20) {
              result.sitekey = match[1];
              result.extractionMethod = 'inline-script';
              break;
            }
          }
          if (result.sitekey) break;
        }
      }
      
      // Method 5: Extract from page HTML
      if (!result.sitekey) {
        const fullHtml = document.documentElement.innerHTML;
        const htmlPatterns = [
          /data-sitekey="([0-9A-Za-z_-]{30,})"/i,
          /data-sitekey='([0-9A-Za-z_-]{30,})'/i,
          /sitekey=([0-9A-Za-z_-]{30,})/i,
        ];
        for (const pattern of htmlPatterns) {
          const match = fullHtml.match(pattern);
          if (match && match[1].length > 20) {
            result.sitekey = match[1];
            result.extractionMethod = 'html-regex';
            break;
          }
        }
      }
      
      return result;
    }
    
    // ========== CLOUDFLARE IUAM ==========
    const cfIUAM = {
      hasRayId: html.includes('ray id') || !!document.querySelector('.ray-id'),
      hasChallenge: !!document.querySelector('#challenge-form, #challenge-running'),
      hasWaitText: bodyText.includes('checking your browser') || 
                   bodyText.includes('please wait') ||
                   bodyText.includes('ddos protection') ||
                   bodyText.includes('kontrollerar din webbläsare') ||  // Swedish: "checking your browser"
                   bodyText.includes('vänta') ||                        // Swedish: "wait"
                   bodyText.includes('bekräfta att du är en människa'), // Swedish: "confirm you are human"
      hasJsChallenge: html.includes('jschl_vc') || html.includes('jschl_answer'),
      hasTitle: hasCfTitle || document.title.toLowerCase().includes('attention required'),
    };
    
    const cfIUAMScore = Object.values(cfIUAM).filter(Boolean).length;
    if (cfIUAMScore >= 2) {
      result.type = 'cloudflare_iuam';
      result.confidence = cfIUAMScore;
      result.indicators.cloudflare_iuam = cfIUAM;
      return result;
    }
    
    // ========== HCAPTCHA ==========
    const hcaptcha = {
      hasIframe: !!document.querySelector('iframe[src*="hcaptcha.com"]'),
      hasContainer: !!document.querySelector('.h-captcha, [class*="h-captcha"]'),
      hasScript: !!document.querySelector('script[src*="hcaptcha.com"]'),
      hasSitekey: !!document.querySelector('[data-sitekey][class*="h-captcha"]'),
    };
    
    const hcaptchaScore = Object.values(hcaptcha).filter(Boolean).length;
    if (hcaptchaScore >= 2) {
      result.type = 'hcaptcha';
      result.confidence = hcaptchaScore;
      result.indicators.hcaptcha = hcaptcha;
      
      const sitekeyEl = document.querySelector('.h-captcha[data-sitekey], [data-sitekey]');
      if (sitekeyEl) {
        result.sitekey = sitekeyEl.getAttribute('data-sitekey');
        result.extractionMethod = 'hcaptcha-data-attr';
      }
      
      return result;
    }
    
    // ========== RECAPTCHA V2 ==========
    const recaptchaV2 = {
      hasIframe: !!document.querySelector('iframe[src*="google.com/recaptcha"]'),
      hasContainer: !!document.querySelector('.g-recaptcha'),
      hasScript: !!document.querySelector('script[src*="google.com/recaptcha"]'),
      hasSitekey: !!document.querySelector('.g-recaptcha[data-sitekey]'),
    };
    
    const recaptchaV2Score = Object.values(recaptchaV2).filter(Boolean).length;
    if (recaptchaV2Score >= 2) {
      result.type = 'recaptcha_v2';
      result.confidence = recaptchaV2Score;
      result.indicators.recaptcha_v2 = recaptchaV2;
      
      const sitekeyEl = document.querySelector('.g-recaptcha[data-sitekey]');
      if (sitekeyEl) {
        result.sitekey = sitekeyEl.getAttribute('data-sitekey');
        result.extractionMethod = 'recaptcha-data-attr';
      }
      
      return result;
    }
    
    // ========== RECAPTCHA V3 ==========
    const recaptchaV3 = {
      hasScript: !!document.querySelector('script[src*="google.com/recaptcha/api.js?render="]'),
      hasToken: !!document.querySelector('input[name="g-recaptcha-response"]'),
      hasInHtml: html.includes('grecaptcha.execute'),
    };
    
    const recaptchaV3Score = Object.values(recaptchaV3).filter(Boolean).length;
    if (recaptchaV3Score >= 2) {
      result.type = 'recaptcha_v3';
      result.confidence = recaptchaV3Score;
      result.indicators.recaptcha_v3 = recaptchaV3;
      
      const script = document.querySelector('script[src*="google.com/recaptcha/api.js?render="]');
      if (script) {
        const match = script.src.match(/render=([0-9A-Za-z_-]+)/);
        if (match) {
          result.sitekey = match[1];
          result.extractionMethod = 'recaptcha-script-render';
        }
      }
      
      return result;
    }
    
    // ========== VERCEL ==========
    const vercel = {
      hasChallenge: !!document.querySelector('[class*="vercel-challenge"]'),
      hasScript: !!document.querySelector('script[src*="vercel.com"]'),
      hasWaitText: bodyText.includes('vercel security') || 
                   bodyText.includes('vercel is protecting'),
      hasMeta: !!document.querySelector('meta[name*="vercel"]'),
    };
    
    const vercelScore = Object.values(vercel).filter(Boolean).length;
    if (vercelScore >= 2) {
      result.type = 'vercel';
      result.confidence = vercelScore;
      result.indicators.vercel = vercel;
      return result;
    }
    
    // ========== DATADOME ==========
    const datadome = {
      hasIframe: !!document.querySelector('iframe[src*="datadome"]'),
      hasCookie: document.cookie.includes('datadome'),
      hasScript: !!document.querySelector('script[src*="datadome"]'),
      hasGeo: !!document.querySelector('#dd_geo'),
    };
    
    const datadomeScore = Object.values(datadome).filter(Boolean).length;
    if (datadomeScore >= 2) {
      result.type = 'datadome';
      result.confidence = datadomeScore;
      result.indicators.datadome = datadome;
      return result;
    }
    
    // ========== GENERIC CAPTCHA CHECK ==========
    const genericCaptcha = {
      hasCaptchaWord: bodyText.includes('captcha') || html.includes('captcha'),
      hasVerifyText: bodyText.includes('verify you are human') ||
                     bodyText.includes('prove you are human') ||
                     bodyText.includes('not a robot'),
      hasCheckbox: !!document.querySelector('input[type="checkbox"][id*="captcha"]'),
    };
    
    const genericScore = Object.values(genericCaptcha).filter(Boolean).length;
    if (genericScore >= 2) {
      result.type = 'unknown';
      result.confidence = genericScore;
      result.indicators.generic = genericCaptcha;
      return result;
    }
    
    return result;
  });
  
  if (detection.type !== 'none') {
    logChallenge(`Detected: ${detection.type} (confidence: ${detection.confidence})`);
    if (detection.sitekey) {
      logChallenge(`Sitekey extracted via ${detection.extractionMethod}: ${detection.sitekey.substring(0, 25)}...`);
    } else {
      logChallenge('WARNING: Could not extract sitekey from page');
    }
  }
  
  return detection;
}

// ============================================================================
// 2CAPTCHA API INTEGRATION
// ============================================================================

function get2CaptchaKey() {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) {
    log2Captcha('WARNING: TWOCAPTCHA_API_KEY not set in environment');
    return null;
  }
  return key;
}

async function check2CaptchaBalance() {
  const apiKey = get2CaptchaKey();
  if (!apiKey) return null;
  
  try {
    const response = await axios.get(`${CONFIG.twoCaptcha.apiUrl}${CONFIG.twoCaptcha.resEndpoint}`, {
      params: { key: apiKey, action: 'getbalance', json: 1 },
      timeout: 10000
    });
    
    if (response.data.status === 1) {
      log2Captcha(`Account balance: $${response.data.request}`);
      return parseFloat(response.data.request);
    }
    return null;
  } catch (e) {
    log2Captcha(`Balance check failed: ${e.message}`);
    return null;
  }
}

async function submit2Captcha(type, sitekey, pageUrl, extraParams = {}) {
  const apiKey = get2CaptchaKey();
  if (!apiKey) {
    log2Captcha('ERROR: No API key available');
    return null;
  }
  
  const methodMap = {
    [ChallengeType.CLOUDFLARE_TURNSTILE]: 'turnstile',
    [ChallengeType.HCAPTCHA]: 'hcaptcha',
    [ChallengeType.RECAPTCHA_V2]: 'userrecaptcha',
    [ChallengeType.RECAPTCHA_V3]: 'userrecaptcha',
  };
  
  const method = methodMap[type];
  if (!method) {
    log2Captcha(`ERROR: No 2Captcha method for type: ${type}`);
    return null;
  }
  
  log2Captcha(`Submitting ${type} challenge...`);
  
  const formData = new URLSearchParams();
  formData.append('key', apiKey);
  formData.append('method', method);
  formData.append('sitekey', sitekey);
  formData.append('pageurl', pageUrl);
  formData.append('json', '1');
  
  for (const [key, value] of Object.entries(extraParams)) {
    formData.append(key, String(value));
  }
  
  if (type === ChallengeType.RECAPTCHA_V3) {
    formData.append('version', 'v3');
    formData.append('action', extraParams.action || 'verify');
    formData.append('min_score', extraParams.min_score || '0.3');
  }
  
  try {
    const response = await axios.post(
      `${CONFIG.twoCaptcha.apiUrl}${CONFIG.twoCaptcha.inEndpoint}`,
      formData.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000
      }
    );
    
    if (response.data.status === 1) {
      const taskId = response.data.request;
      log2Captcha(`Task submitted successfully! ID: ${taskId}`);
      return taskId;
    } else {
      log2Captcha(`ERROR: ${response.data.request}`);
      return null;
    }
  } catch (error) {
    log2Captcha(`Submit error: ${error.message}`);
    return null;
  }
}

async function poll2CaptchaSolution(taskId) {
  const apiKey = get2CaptchaKey();
  if (!apiKey) return null;
  
  const startTime = Date.now();
  
  log2Captcha(`Waiting ${CONFIG.twoCaptcha.initialWaitTime / 1000}s before first poll...`);
  await new Promise(resolve => setTimeout(resolve, CONFIG.twoCaptcha.initialWaitTime));
  
  let pollCount = 0;
  while ((Date.now() - startTime) < CONFIG.twoCaptcha.maxWaitTime) {
    pollCount++;
    
    try {
      const response = await axios.get(`${CONFIG.twoCaptcha.apiUrl}${CONFIG.twoCaptcha.resEndpoint}`, {
        params: { key: apiKey, action: 'get', id: taskId, json: 1 },
        timeout: 30000
      });
      
      if (response.data.status === 1) {
        const token = response.data.request;
        log2Captcha(`Solution received after ${pollCount} polls!`);
        return token;
      } else if (response.data.request === 'CAPCHA_NOT_READY') {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log2Captcha(`Poll #${pollCount}: Not ready yet (${elapsed}s elapsed)`);
      } else {
        log2Captcha(`ERROR: ${response.data.request}`);
        return null;
      }
    } catch (error) {
      log2Captcha(`Poll error: ${error.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, CONFIG.twoCaptcha.pollInterval));
  }
  
  log2Captcha('TIMEOUT: Max wait time exceeded');
  return null;
}

async function report2CaptchaBad(taskId) {
  const apiKey = get2CaptchaKey();
  if (!apiKey) return;
  
  try {
    const response = await axios.get(`${CONFIG.twoCaptcha.apiUrl}${CONFIG.twoCaptcha.resEndpoint}`, {
      params: { key: apiKey, action: 'reportbad', id: taskId, json: 1 },
      timeout: 10000
    });
    log2Captcha(`Reported bad solution for task ${taskId}`);
    return response.data;
  } catch (err) {
    log2Captcha(`Report error for task ${taskId}: ${err.message}`);
  }
}

async function report2CaptchaGood(taskId) {
  const apiKey = get2CaptchaKey();
  if (!apiKey) return;
  
  try {
    await axios.get(`${CONFIG.twoCaptcha.apiUrl}${CONFIG.twoCaptcha.resEndpoint}`, {
      params: { key: apiKey, action: 'reportgood', id: taskId, json: 1 },
      timeout: 10000
    });
    log2Captcha(`Reported good solution for task ${taskId}`);
  } catch (err) {
    log2Captcha(`Failed to report good solution for task ${taskId}: ${err.message}`);
  }
}

// ============================================================================
// MANUAL BYPASS ATTEMPTS
// ============================================================================

async function tryManualTurnstile(page) {
  logChallenge('Attempting manual Turnstile bypass...');
  
  for (let attempt = 1; attempt <= CONFIG.manual.maxAttempts; attempt++) {
    try {
      const iframeHandle = await page.$('iframe[src*="challenges.cloudflare.com"]');
      
      if (iframeHandle) {
        const frame = await iframeHandle.contentFrame();
        
        if (frame) {
          const selectors = ['input[type="checkbox"]', '.ctp-checkbox-label', '[class*="checkbox"]'];
          
          for (const selector of selectors) {
            try {
              await frame.waitForSelector(selector, { timeout: 2000 });
              await frame.click(selector);
              break;
            } catch (e) {}
          }
          
          await page.waitForTimeout(CONFIG.manual.waitAfterClick);
          
          const stillBlocked = await detectChallenge(page);
          if (stillBlocked.type === ChallengeType.NONE) {
            logChallenge('Manual bypass successful!');
            return true;
          }
        }
      }
      
      const box = await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile, [class*="turnstile"]');
        if (el) {
          const rect = el.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
        return null;
      });
      
      if (box) {
        await page.mouse.move(box.x - 100, box.y - 50, { steps: 10 });
        await page.waitForTimeout(100);
        await page.mouse.move(box.x, box.y, { steps: 15 });
        await page.mouse.click(box.x, box.y);
        
        await page.waitForTimeout(CONFIG.manual.waitAfterClick);
        
        const stillBlocked = await detectChallenge(page);
        if (stillBlocked.type === ChallengeType.NONE) {
          logChallenge('Manual bypass successful via mouse click!');
          return true;
        }
      }
      
    } catch (e) {
      logChallenge(`Attempt ${attempt} error: ${e.message}`);
    }
    
    await page.waitForTimeout(1000);
  }
  
  logChallenge('Manual bypass failed');
  return false;
}

async function tryManualHCaptcha(page) {
  logChallenge('Attempting manual hCaptcha bypass...');
  
  try {
    const iframeHandle = await page.$('iframe[src*="hcaptcha.com"]');
    
    if (iframeHandle) {
      const frame = await iframeHandle.contentFrame();
      
      if (frame) {
        await frame.waitForSelector('#checkbox', { timeout: 5000 });
        await frame.click('#checkbox');
        
        await page.waitForTimeout(CONFIG.manual.waitAfterClick);
        
        const stillBlocked = await detectChallenge(page);
        if (stillBlocked.type === ChallengeType.NONE) {
          logChallenge('hCaptcha checkbox click successful!');
          return true;
        }
      }
    }
  } catch (e) {
    logChallenge(`hCaptcha manual error: ${e.message}`);
  }
  
  return false;
}

async function tryManualRecaptchaV2(page) {
  logChallenge('Attempting manual reCAPTCHA v2 bypass...');
  
  try {
    const iframeHandle = await page.$('iframe[src*="google.com/recaptcha"][title*="reCAPTCHA"]');
    
    if (iframeHandle) {
      const frame = await iframeHandle.contentFrame();
      
      if (frame) {
        await frame.waitForSelector('.recaptcha-checkbox', { timeout: 5000 });
        await frame.click('.recaptcha-checkbox');
        
        await page.waitForTimeout(CONFIG.manual.waitAfterClick);
        
        const stillBlocked = await detectChallenge(page);
        if (stillBlocked.type === ChallengeType.NONE) {
          logChallenge('reCAPTCHA checkbox click successful!');
          return true;
        }
      }
    }
  } catch (e) {
    logChallenge(`reCAPTCHA manual error: ${e.message}`);
  }
  
  return false;
}

async function waitForCloudflareIUAM(page) {
  logChallenge('Waiting for Cloudflare IUAM to auto-solve...');
  
  const maxWait = 15000;
  const checkInterval = 1000;
  let waited = 0;
  
  while (waited < maxWait) {
    await page.waitForTimeout(checkInterval);
    waited += checkInterval;
    
    const detection = await detectChallenge(page);
    if (detection.type === ChallengeType.NONE) {
      logChallenge(`IUAM auto-solved after ${waited}ms!`);
      return true;
    }
  }
  
  logChallenge('IUAM did not auto-solve');
  return false;
}

// ============================================================================
// SOLUTION INJECTION
// ============================================================================

async function injectTurnstileToken(page, token) {
  log2Captcha('Injecting Turnstile token...');
  
  const result = await page.evaluate((solvedToken) => {
    const results = { inputsSet: [], callbackCalled: false };
    
    const cfInput = document.querySelector('[name="cf-turnstile-response"]');
    if (cfInput) {
      cfInput.value = solvedToken;
      results.inputsSet.push('cf-turnstile-response');
    }
    
    const gInput = document.querySelector('[name="g-recaptcha-response"]');
    if (gInput) {
      gInput.value = solvedToken;
      results.inputsSet.push('g-recaptcha-response');
    }
    
    const containers = document.querySelectorAll('.cf-turnstile, [class*="turnstile"], [data-callback]');
    for (const container of containers) {
      const callback = container.getAttribute('data-callback');
      if (callback && typeof window[callback] === 'function') {
        try {
          window[callback](solvedToken);
          results.callbackCalled = true;
        } catch (e) {}
      }
    }
    
    return results;
  }, token);
  
  log2Captcha(`Token injection results:`, result);
  return result;
}

async function injectHCaptchaToken(page, token) {
  log2Captcha('Injecting hCaptcha token...');
  
  await page.evaluate((solvedToken) => {
    const hInput = document.querySelector('[name="h-captcha-response"], textarea[name="h-captcha-response"]');
    if (hInput) {
      hInput.value = solvedToken;
    }
    
    const gInput = document.querySelector('[name="g-recaptcha-response"]');
    if (gInput) {
      gInput.value = solvedToken;
    }
    
    const container = document.querySelector('.h-captcha[data-callback]');
    if (container) {
      const callback = container.getAttribute('data-callback');
      if (callback && typeof window[callback] === 'function') {
        try { window[callback](solvedToken); } catch (e) {}
      }
    }
  }, token);
}

async function injectRecaptchaToken(page, token) {
  log2Captcha('Injecting reCAPTCHA token...');
  
  await page.evaluate((solvedToken) => {
    const textarea = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
    if (textarea) {
      textarea.value = solvedToken;
      textarea.innerHTML = solvedToken;
    }
    
    const container = document.querySelector('.g-recaptcha[data-callback]');
    if (container) {
      const callback = container.getAttribute('data-callback');
      if (callback && typeof window[callback] === 'function') {
        try { window[callback](solvedToken); } catch (e) {}
      }
    }
  }, token);
}

async function submitChallengeForm(page) {
  log2Captcha('Attempting to submit challenge form...');
  
  const submitted = await page.evaluate(() => {
    const submitSelectors = [
      '#challenge-form [type="submit"]',
      'form[action*="challenge"] [type="submit"]',
      'form button[type="submit"]',
      '[type="submit"]'
    ];
    
    for (const selector of submitSelectors) {
      const btn = document.querySelector(selector);
      if (btn) {
        btn.click();
        return { method: 'button', selector };
      }
    }
    
    const form = document.querySelector('#challenge-form, form');
    if (form) {
      form.submit();
      return { method: 'form.submit()' };
    }
    
    return null;
  });
  
  if (submitted) {
    log2Captcha(`Form submitted via: ${JSON.stringify(submitted)}`);
  }
  
  return submitted;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

async function handleChallenge(page, options = {}) {
  const { 
    skipManual = false,
    skip2Captcha = false,
    maxRetries = 2
  } = options;
  
  const detection = await detectChallenge(page);
  
  if (detection.type === ChallengeType.NONE) {
    return { success: true, type: 'none', method: 'none' };
  }
  
  logChallenge(`Challenge detected: ${detection.type}`);
  
  if (!skipManual) {
    let manualSuccess = false;
    
    switch (detection.type) {
      case ChallengeType.CLOUDFLARE_TURNSTILE:
        manualSuccess = await tryManualTurnstile(page);
        break;
        
      case ChallengeType.CLOUDFLARE_IUAM:
        manualSuccess = await waitForCloudflareIUAM(page);
        break;
        
      case ChallengeType.HCAPTCHA:
        manualSuccess = await tryManualHCaptcha(page);
        break;
        
      case ChallengeType.RECAPTCHA_V2:
        manualSuccess = await tryManualRecaptchaV2(page);
        break;
        
      case ChallengeType.VERCEL:
        await page.waitForTimeout(5000);
        const vercelCheck = await detectChallenge(page);
        manualSuccess = vercelCheck.type === ChallengeType.NONE;
        break;
    }
    
    if (manualSuccess) {
      return { success: true, type: detection.type, method: 'manual' };
    }
  }
  
  if (!skip2Captcha && detection.sitekey) {
    log2Captcha('Falling back to 2Captcha service...');
    
    await check2CaptchaBalance();
    
    for (let retry = 0; retry < maxRetries; retry++) {
      if (retry > 0) {
        log2Captcha(`Retry ${retry + 1}/${maxRetries}...`);
        await page.waitForTimeout(5000);
      }
      
      const taskId = await submit2Captcha(detection.type, detection.sitekey, detection.pageUrl);
      
      if (!taskId) continue;
      
      const solution = await poll2CaptchaSolution(taskId);
      
      if (!solution) continue;
      
      switch (detection.type) {
        case ChallengeType.CLOUDFLARE_TURNSTILE:
          await injectTurnstileToken(page, solution);
          break;
          
        case ChallengeType.HCAPTCHA:
          await injectHCaptchaToken(page, solution);
          break;
          
        case ChallengeType.RECAPTCHA_V2:
        case ChallengeType.RECAPTCHA_V3:
          await injectRecaptchaToken(page, solution);
          break;
      }
      
      await page.waitForTimeout(2000);
      await submitChallengeForm(page);
      await page.waitForTimeout(5000);
      
      const postSolve = await detectChallenge(page);
      if (postSolve.type === ChallengeType.NONE) {
        log2Captcha('Challenge solved successfully!');
        await report2CaptchaGood(taskId);
        return { success: true, type: detection.type, method: '2captcha', taskId };
      } else {
        log2Captcha('Solution did not work');
        await report2CaptchaBad(taskId);
      }
    }
  }
  
  logChallenge('Challenge bypass failed');
  return { 
    success: false, 
    type: detection.type, 
    method: 'failed',
    error: 'All bypass methods failed',
    sitekeyFound: !!detection.sitekey
  };
}

async function hasChallenge(page) {
  const detection = await detectChallenge(page);
  return detection.type !== ChallengeType.NONE;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  handleChallenge,
  hasChallenge,
  detectChallenge,
  ChallengeType,
  tryManualTurnstile,
  tryManualHCaptcha,
  tryManualRecaptchaV2,
  waitForCloudflareIUAM,
  submit2Captcha,
  poll2CaptchaSolution,
  report2CaptchaBad,
  report2CaptchaGood,
  check2CaptchaBalance,
  injectTurnstileToken,
  injectHCaptchaToken,
  injectRecaptchaToken,
  submitChallengeForm,
  CONFIG
};
