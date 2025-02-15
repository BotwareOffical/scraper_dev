const { chromium } = require("playwright-core");
const logger = require("pino")();
const fs = require("fs");
const path = require("path");
const bidFilePath = path.resolve(__dirname, "../bids.json");

class BuyeeScraper {
  constructor() {
    this.baseUrl = "https://buyee.jp";
    this.browser = null;
    this.lastBrowserReset = Date.now();
  }

  // Single, merged setupBrowser function that handles both memory and authentication
  async setupBrowser() {
    try {
      // Memory management: Reset browser every hour
      if (this.browser && Date.now() - this.lastBrowserReset > 60 * 60 * 1000) {
        console.log('Resetting browser due to age');
        await this.browser.close();
        this.browser = null;
      }

      // Create new browser if needed
      if (!this.browser || !this.browser.isConnected()) {
        this.browser = await chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            // Memory optimization flags
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            // Heroku-specific flags
            '--no-zygote',
            '--js-flags="--max-old-space-size=460"'
          ]
        });
        this.lastBrowserReset = Date.now();
      }
      
      // Load stored login state
      let loginState;
      try {
        if (fs.existsSync('temp_login.json')) {
          console.log('Using temporary login state');
          loginState = JSON.parse(fs.readFileSync('temp_login.json', 'utf8'));
        } else if (fs.existsSync('login.json')) {
          console.log('Using full login state');
          loginState = JSON.parse(fs.readFileSync('login.json', 'utf8'));
        } else {
          console.log('No login state found, creating fresh context');
          loginState = { cookies: [] };
        }
      } catch (e) {
        console.warn('Error reading login state:', e);
        loginState = { cookies: [] };
      }

      // Create context with comprehensive settings
      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: loginState.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'Europe/Berlin',
        acceptDownloads: true,
        extraHTTPHeaders: {
          'accept': 'application/json, text/javascript, */*; q=0.01',
          'accept-language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
          'x-requested-with': 'XMLHttpRequest',
          'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Linux"'
        }
      });
      
      // Add cookies with complete properties
      if (loginState.cookies && loginState.cookies.length > 0) {
        const cookiesToAdd = loginState.cookies.map(cookie => ({
          ...cookie,
          secure: cookie.secure || false,
          httpOnly: cookie.httpOnly || false,
          sameSite: cookie.sameSite || 'Lax',
          expires: cookie.expires || (Date.now() / 1000 + 86400) // 24 hour expiry
        }));
        await context.addCookies(cookiesToAdd);
      }
      
      // Log the setup for debugging
      const cookies = await context.cookies();
      console.log('Browser context created with cookies:', 
        cookies.map(c => `${c.name}=${c.value}`).join('; '));
      
      return { browser: this.browser, context };
    } catch (error) {
      console.error('Browser setup failed:', error);
      throw error;
    }
  }

  // Scrape search results and save to search.json
  async scrapeSearchResults(term, minPrice = "", maxPrice = "", page = 1) {
    console.log(`Searching for "${term}" - Page ${page}`);
    
    let context;
    let pageInstance;
    try {
      ({ context } = await this.setupBrowser());
      
      pageInstance = await context.newPage();
      
      // Set shorter timeouts to avoid Heroku 30s limit
      pageInstance.setDefaultTimeout(25000);
      pageInstance.setDefaultNavigationTimeout(25000);
      
      // Construct search URL with explicit page parameter
      let searchUrl = `${this.baseUrl}/item/search/query/${encodeURIComponent(term)}`;
      
      const params = [];
      if (minPrice) params.push(`aucminprice=${encodeURIComponent(minPrice)}`);
      if (maxPrice) params.push(`aucmaxprice=${encodeURIComponent(maxPrice)}`);
      params.push("translationType=98");
      params.push(`page=${page}`);
      
      searchUrl += `?${params.join("&")}`;

      // Add console logging for debugging
      console.log(`Navigating to: ${searchUrl}`);

      // Navigate with shorter timeout
      await pageInstance.goto(searchUrl, {
        waitUntil: "domcontentloaded", // Changed from networkidle to faster option
        timeout: 25000,
      });

      console.log('Page loaded, checking for items...');

      // Extract total products on first page with error handling
      let totalProducts = 0;
      if (page === 1) {
        try {
          const totalProductsElement = await pageInstance.$('.result-num');
          if (totalProductsElement) {
            const totalProductsText = await totalProductsElement.innerText();
            const totalProductsMatch = totalProductsText.match(/\/\s*(\d+)/);
            totalProducts = totalProductsMatch ? parseInt(totalProductsMatch[1], 10) : 0;
          }
        } catch (extractionError) {
          console.warn('Could not extract total products:', extractionError);
        }
      }

      // Check for no results message first
      const noResultsElement = await pageInstance.$('.search-no-hits');
      if (noResultsElement) {
        console.log('No results found for search');
        return {
          products: [],
          totalProducts: 0,
          currentPage: page
        };
      }

      // Wait for items with shorter timeout and fallback
      let items = [];
      try {
        await pageInstance.waitForSelector(".itemCard", { timeout: 15000 });
        items = await pageInstance.$$(".itemCard");
      } catch (selectorError) {
        console.log('Timeout waiting for .itemCard, checking alternative selectors...');
        
        // Try alternative selectors
        const alternativeSelectors = ['.g-thumbnail', '.itemCard__itemName'];
        for (const selector of alternativeSelectors) {
          try {
            await pageInstance.waitForSelector(selector, { timeout: 5000 });
            items = await pageInstance.$$(selector);
            if (items.length > 0) break;
          } catch (e) {
            console.log(`Alternative selector ${selector} not found`);
          }
        }
      }

      console.log(`Found ${items.length} items`);
      const products = [];

      for (const item of items) {
        try {
          const productData = await pageInstance.evaluate((itemEl) => {
            const titleElement = itemEl.querySelector(".itemCard__itemName a") || 
                              itemEl.querySelector("a[data-testid='item-name']");
            const title = titleElement ? titleElement.textContent.trim() : "No Title";
            
            let url = titleElement ? titleElement.getAttribute("href") : null;
            if (!url) return null;
            
            url = url.startsWith("http") ? url : `https://buyee.jp${url}`;

            const imgElement = itemEl.querySelector(".g-thumbnail__image") || 
                            itemEl.querySelector("img[data-testid='item-image']");
            const imgSrc = imgElement 
              ? (imgElement.getAttribute("data-src") || 
                imgElement.getAttribute("src") || 
                imgElement.src)
              : null;

            const priceElement = itemEl.querySelector(".g-price") ||
                              itemEl.querySelector("[data-testid='item-price']");
            const price = priceElement ? priceElement.textContent.trim() : "Price Not Available";

            const timeElements = [
              itemEl.querySelector('.itemCard__time'),
              itemEl.querySelector('.g-text--attention'),
              itemEl.querySelector('.timeLeft'),
              itemEl.querySelector('[data-testid="time-remaining"]')
            ];

            const timeRemaining = timeElements.find(el => el && el.textContent)
              ?.textContent.trim() || 'Time Not Available';

            return {
              title,
              price,
              url,
              time_remaining: timeRemaining,
              images: imgSrc ? [imgSrc.split("?")[0]] : [],
            };
          }, item);

          if (productData) {
            products.push(productData);
          }
        } catch (itemError) {
          console.error('Error processing individual item:', itemError);
        }
      }

      return {
        products,
        totalProducts: totalProducts || products.length,
        currentPage: page
      };
    } catch (error) {
      console.error('Search failed:', error);
      // Return empty results instead of throwing
      return {
        products: [],
        totalProducts: 0,
        currentPage: page
      };
    } finally {
      if (pageInstance) await pageInstance.close();
      if (context) await context.close();
    }
  }

  async placeBid(productUrl, bidAmount) {
    let browser = null;
    let context = null;
    let page = null;
    
    try {
      // Extract auction ID from product URL
      const auctionIdMatch = productUrl.match(/auction\/([a-z0-9]+)/i) || productUrl.match(/\/([a-z0-9]+)\?/i);
      if (!auctionIdMatch) {
        throw new Error('Invalid product URL format');
      }
      const auctionId = auctionIdMatch[1];
  
      // Read and parse existing login state
      const loginStateRaw = fs.readFileSync('login.json', 'utf8');
      const loginState = JSON.parse(loginStateRaw);
  
      // Comprehensive browser launch with all stored cookies and headers
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
  
      // Context creation with comprehensive settings
      context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: loginState.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        extraHTTPHeaders: {
          'accept': 'application/json, text/javascript, */*; q=0.01',
          'accept-language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
          'x-requested-with': 'XMLHttpRequest',
          'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"'
        }
      });
  
      // Add ALL cookies from login state
      const cookiesToAdd = loginState.cookies.map(cookie => ({
        ...cookie,
        expires: cookie.expires || (Date.now() / 1000 + 86400), // Default 1-day expiry
        secure: cookie.secure || false,
        httpOnly: cookie.httpOnly || false,
        sameSite: cookie.sameSite || 'Lax'
      }));
      await context.addCookies(cookiesToAdd);
  
      page = await context.newPage();
  
      // Preliminary API calls mimicking browser behavior
      await page.goto(productUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
  
      // Perform cookie sync and other preparatory API calls
      await page.evaluate(() => {
        // Simulate browser-like API calls
        return Promise.all([
          fetch('/api/v1/cookie/get', { credentials: 'include' }),
          fetch('/api/v1/watch_list/find', { credentials: 'include' })
        ]);
      });
  
      // Navigate to bid page
      const bidUrl = `https://buyee.jp/bid/${auctionId}`;
      await page.goto(bidUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
  
      // Verify total amount API call
      await page.evaluate((params) => {
        return fetch(`/api/v1/auction/total_amount?price=${params.bidAmount}&quantity=1&planId=99&auctionId=${params.auctionId}`, {
          method: 'GET',
          credentials: 'include'
        });
      }, { bidAmount, auctionId });
  
      // Fill bid amount and select plan
      await page.fill('input[name="bidYahoo[price]"], #bidYahoo_price', bidAmount.toString());
      await page.evaluate(() => {
        const planSelect = document.querySelector('#bidYahoo_plan');
        if (planSelect) {
          planSelect.value = '99';
          planSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
  
      // Find and click submit button
      const submitSelectors = [
        '#bid_submit', 
        'button[type="submit"]', 
        'input[type="submit"]'
      ];
  
      let submitButton = null;
      for (const selector of submitSelectors) {
        try {
          submitButton = await page.$(selector);
          if (submitButton) {
            await submitButton.click();
            break;
          }
        } catch {}
      }
  
      // Wait for navigation with longer timeout
      await page.waitForNavigation({ 
        waitUntil: 'networkidle0',
        timeout: 30000 
      });
  
      // Verify completion page
      const currentUrl = page.url();
      console.log('Current URL after submission:', currentUrl);
  
      if (!currentUrl.includes('/bid/complete/') && !currentUrl.includes('/complete/')) {
        throw new Error('Navigation to completion page failed');
      }
  
      return {
        success: true,
        message: `Successfully placed bid of ${bidAmount}`,
        details: {
          productUrl,
          bidAmount,
          timestamp: new Date().toISOString()
        }
      };
  
    } catch (error) {
      console.error("Bid placement error:", error);
      
      try {
        // Additional debug screenshot
        await page?.screenshot({ path: 'bid-error.png' });
      } catch {}
  
      return { 
        success: false, 
        message: `Failed to place bid: ${error.message}`,
        debug: {
          currentUrl: page?.url(),
          error: error.message
        }
      };
  
    } finally {
      if (page) await page.close().catch(console.error);
      if (context) await context.close().catch(console.error);
      if (browser) await browser.close().catch(console.error);
    }
  }
    
  // Add retry utility
  async retry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  async updateBid(productUrl) {
    let context;
    let page;
    try {
      ({ context } = await this.setupBrowser());
      page = await context.newPage();
      await page.goto(productUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 300000
      });
  
      // Extract price with multiple selectors
      let price = 'Price Not Available';
      const priceElements = [
        page.locator('.current_price .price'),
        page.locator('.price'),
        page.locator('.itemPrice')
      ];
  
      for (const priceElement of priceElements) {
        try {
          const priceText = await priceElement.textContent();
          if (priceText) {
            price = priceText.trim();
            break;
          }
        } catch {}
      }
  
      // Extract time remaining with multiple selectors
      let timeRemaining = 'Time Not Available';
      const timeRemainingElements = [
        page.locator('.itemInformation__infoItem .g-text--attention'),
        page.locator('.itemInfo__time span'),
        page.locator('.timeLeft'),
        page.locator('.g-text--attention')
      ];
  
      for (const timeElement of timeRemainingElements) {
        try {
          const timeText = await timeElement.textContent();
          if (timeText) {
            timeRemaining = timeText.trim();
            break;
          }
        } catch {}
      }
  
      return {
        productUrl,
        price: price.trim(),
        timeRemaining: timeRemaining.trim()
      };
    } catch (error) {
      console.error("Error during bid update:", error);
      return {
        productUrl,
        error: error.message
      };
    } finally {
      if (page) await page.close();
    }
  }
  
  async login(username, password) {
    let context;
    let page;
  
    try {
      console.log('Checking for existing login state...');
      try {
        if (fs.existsSync('login.json')) {
          console.log('Clearing existing login.json file');
          fs.unlinkSync('login.json');
        }
      } catch (e) {
        console.log('No existing login.json file to clear');
      }
  
      // Create fresh browser context without loading any state
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
      
      context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'Europe/Berlin',
        acceptDownloads: true
      });
      
      page = await context.newPage();
      
      console.log('Starting login process...');
      
      await page.goto("https://buyee.jp/signup/login", {
        waitUntil: 'networkidle',
        timeout: 60000
      });
    
      console.log('Filling login form...');
      await page.fill('#login_mailAddress', username);
      await page.waitForTimeout(500);
      await page.fill('#login_password', password);
      await page.waitForTimeout(500);
  
      // Setup navigation promise before clicking
      const navigationPromise = page.waitForNavigation({
        timeout: 60000,
        waitUntil: 'networkidle'
      });
  
      // Click submit and wait for navigation
      await page.click('#login_submit');
      await navigationPromise;
  
      console.log('Post-login URL:', page.url());
  
      // Take screenshot after navigation
      await page.screenshot({ path: 'post-login.png' });
  
      // Check if we're on the 2FA page
      const is2FAPage = page.url().includes('/signup/twoFactor');
      
      if (is2FAPage) {
        console.log('Two-factor authentication required');
        const pageContent = await page.content();
        console.log('2FA Page HTML:', pageContent);
        
        // Save temporary state for 2FA
        await context.storageState({ path: "temp_login.json" });
        
        return { 
          success: false, 
          requiresTwoFactor: true
        };
      }
  
      // Save final login state
      await context.storageState({ path: "login.json" });
      
      return { success: true };
  
    } catch (error) {
      console.error('Login error:', error);
      await page?.screenshot({ path: 'login-error.png' });
      throw error;
    } finally {
      if (page) await page.close();
    }
  }

  async submitTwoFactorCode(twoFactorCode) {
    let context;
    let page;
  
    try {
      // Create context using the temporary login state
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
  
      // Try to load the temporary login state
      let loginState;
      try {
        loginState = JSON.parse(fs.readFileSync('temp_login.json', 'utf8'));
        console.log('Loaded temporary login state');
      } catch (e) {
        console.error('Failed to load temporary login state:', e);
        throw new Error('No temporary login state found. Please log in again.');
      }
  
      context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'Europe/Berlin',
        acceptDownloads: true,
        storageState: loginState
      });
  
      page = await context.newPage();
      
      console.log('Navigating to 2FA page...');
      await page.goto("https://buyee.jp/signup/twoFactor", {
        waitUntil: 'networkidle',
        timeout: 60000
      });
  
      // Debug: Take screenshot before filling code
      await page.screenshot({ path: '2fa-before.png' });
  
      // Split the 6-digit code into individual digits
      const digits = twoFactorCode.toString().split('');
      
      if (digits.length !== 6) {
        throw new Error('Two-factor code must be exactly 6 digits');
      }
  
      // Fill each digit into its corresponding input box
      for (let i = 1; i <= 6; i++) {
        const inputSelector = `#input${i}`;
        await page.waitForSelector(inputSelector, { timeout: 5000 });
        
        // Clear the input first
        await page.$eval(inputSelector, el => el.value = '');
        
        // Type the digit
        await page.type(inputSelector, digits[i-1], { delay: 100 });
      }
  
      // Debug: Take screenshot after filling code
      await page.screenshot({ path: '2fa-after.png' });
  
      // Wait for any validation to complete
      await page.waitForTimeout(1000);
  
      // Check for error message
      const errorFrame = await page.$('#error-frame');
      const isErrorVisible = await errorFrame.evaluate(el => 
        window.getComputedStyle(el).display !== 'none'
      );
  
      if (isErrorVisible) {
        throw new Error('Invalid two-factor code');
      }
  
      // Wait for navigation after successful 2FA
      await page.waitForNavigation({ 
        timeout: 30000,
        waitUntil: 'networkidle'
      });
  
      // Check if we're still on the 2FA page
      if (page.url().includes('twoFactor')) {
        throw new Error('Still on 2FA page after code entry');
      }
  
      // Save the final login state
      await context.storageState({ path: "login.json" });
      
      // Clean up temporary login state
      try {
        fs.unlinkSync('temp_login.json');
        console.log('Temporary login state cleaned up');
      } catch (e) {
        console.log('No temporary login state to clean up');
      }
      
      return { success: true };
  
    } catch (error) {
      console.error('Two-factor authentication error:', error);
      
      // Take error screenshot
      await page?.screenshot({ path: 'two-factor-error.png' });
      
      // Get additional debug info
      const debugInfo = {
        url: page?.url(),
        content: await page?.content().catch(() => 'Could not get content'),
        error: error.message
      };
      
      console.log('Debug info:', debugInfo);
      
      throw error;
    } finally {
      if (page) await page.close();
      if (context) await context.close();
    }
  }
  async refreshLoginSession() {
    console.log('Refreshing login session...');
    const loginResult = await this.login('teege@machen-sachen.com', '&7.s!M47&zprEv.');
    if (loginResult.success) {
      console.log('Login session refreshed successfully');
      await this.checkLoginState(); // Verify the new session
    } else {
      console.error('Failed to refresh login session');
      throw new Error('Failed to refresh login session');
    }
  }
  
  async checkLoginState() {
    try {
      const loginData = JSON.parse(fs.readFileSync('login.json', 'utf8'));      
      const cookies = loginData.cookies || [];
      const requiredCookies = ['otherbuyee', 'userProfile', 'userId'];
      
      const hasAllRequiredCookies = requiredCookies.every(name => 
        cookies.some(cookie => cookie.name === name && !cookie.expired)
      );
      
      console.log('Has all required cookies:', hasAllRequiredCookies);
      console.log('Number of cookies:', cookies.length);
      
      if (!hasAllRequiredCookies) {
        const missingCookies = requiredCookies.filter(name => 
          !cookies.some(cookie => cookie.name === name && !cookie.expired)
        );
        console.log('Missing or expired cookies:', missingCookies);
      }
      
      return hasAllRequiredCookies;
    } catch (error) {
      console.error('Error checking login state:', error);
      return false;
    }
  }
} 
module.exports = BuyeeScraper;