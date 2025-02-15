const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const BuyeeScraper = require('./scrapper');
const logger = require('morgan');
const fs = require('fs');
const path = require('path');
const rimraf = require('rimraf');
const bidFilePath = path.resolve(__dirname, './data/bids.json');

// Initialize rimraf promise
const rimrafAsync = (path) => new Promise((resolve, reject) => {
  rimraf(path, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

const app = express();

// Configure CORS with more permissive setting
const corsOptions = {
  origin: function(origin, callback) {
    console.log('Request Origin:', origin);
    const allowedOrigins = [
      'https://buyee-scraper-frontend-new-23f2627c6b90.herokuapp.com',
      'http://localhost:5173'
    ];
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('Origin not allowed:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'Connection', 'Keep-Alive'],
  exposedHeaders: ['Access-Control-Allow-Origin', 'Keep-Alive', 'Connection'],
  maxAge: 7200,
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Initialize last activity timestamp
let lastActivityTimestamp = Date.now();
const INACTIVITY_TIMEOUT = 45 * 60 * 1000; // 45 minutes in milliseconds

// Activity tracking middleware
app.use((req, res, next) => {
  lastActivityTimestamp = Date.now();
  next();
});

app.use((err, req, res, next) => {
  if (err.name === 'CORS Error') {
    console.error('CORS Error:', {
      origin: req.headers.origin,
      method: req.method,
      path: req.path
    });
  }
  next(err);
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Middleware
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const scraper = new BuyeeScraper();

// Cleanup function for search contexts
async function cleanupSearchContexts() {
  try {
    const files = await fs.promises.readdir(__dirname);
    const searchContextFiles = files.filter(file => file.startsWith('search_context_'));
    
    for (const file of searchContextFiles) {
      const filePath = path.join(__dirname, file);
      const stats = await fs.promises.stat(filePath);
      const fileAge = Date.now() - stats.mtime.getTime();
      
      // Delete files older than 30 minutes
      if (fileAge > 30 * 60 * 1000) {
        try {
          await fs.promises.unlink(filePath);
          console.log(`Cleaned up old search context: ${file}`);
        } catch (unlinkError) {
          console.error(`Error deleting file ${file}:`, unlinkError);
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning up search contexts:', error);
  }
}

// Place bid endpoint
app.post('/place-bid', async (req, res) => {
  try {
    console.log('Received bid request data:', req.body);
    const { productId: productUrl, amount: bidAmount } = req.body;

    if (!productUrl || !bidAmount || isNaN(bidAmount) || bidAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Product URL must be valid, and bid amount must be a positive number',
      });
    }

    const response = await scraper.placeBid(productUrl, bidAmount);
    
    if (!response.success) {
      return res.status(400).json(response);
    }

    res.json({
      success: true,
      message: response.message,
      details: response.details
    });
    
  } catch (error) {
    console.error('Bid placement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to place the bid. Please try again.',
      error: error.message
    });
  }
});

app.post('/search', async (req, res) => {
  const startTime = Date.now();
  const searchId = Math.random().toString(36).substring(7);

  try {
    // Clean up old search contexts first
    await cleanupSearchContexts();

    const { 
      terms: searchTerms = [], 
      page = 1, 
      pageSize = 100 
    } = req.body;

    if (!searchTerms.length) {
      return res.status(400).json({ 
        success: false,
        error: 'No search terms provided' 
      });
    }

    // Create search context file
    const searchContextPath = path.join(__dirname, `search_context_${searchId}.json`);
    
    // Initialize search context
    const searchContext = {
      searchId,
      terms: searchTerms,
      currentTermIndex: 0,
      currentPage: 1,
      results: [],
      totalResults: 0,
      createdAt: Date.now() // Add timestamp for cleanup
    };

    // Process first search term
    const firstTerm = searchTerms[0];
    const searchResult = await scraper.scrapeSearchResults(
      firstTerm.term, 
      firstTerm.minPrice, 
      firstTerm.maxPrice, 
      1
    );

    // Update search context
    searchContext.results = searchResult.products;
    searchContext.totalResults = searchResult.totalProducts;

    // Save search context
    fs.writeFileSync(searchContextPath, JSON.stringify(searchContext, null, 2));

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

    res.json({
      success: true,
      results: searchResult.products,
      count: searchResult.products.length,
      totalResults: searchResult.totalProducts,
      currentPage: 1,
      searchContextId: searchId,
      duration: totalDuration
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update this endpoint in your app.js
app.post('/load-more', async (req, res) => {
  const { searchContextId, pageSize = 100 } = req.body;

  try {
    // Clean up old search contexts first
    await cleanupSearchContexts();

    // Load search context
    const searchContextPath = path.join(__dirname, `search_context_${searchContextId}.json`);
    
    if (!fs.existsSync(searchContextPath)) {
      return res.status(404).json({
        success: false,
        error: 'Search context not found'
      });
    }

    const searchContext = JSON.parse(fs.readFileSync(searchContextPath, 'utf8'));

    // Determine next page/term
    let currentTermIndex = searchContext.currentTermIndex;
    let currentPage = searchContext.currentPage + 1;

    // Get current search term
    const currentTerm = searchContext.terms[currentTermIndex];

    // Create new scraper instance for this request
    const requestScraper = new BuyeeScraper();

    try {
      // Perform search for next page
      const searchResult = await requestScraper.scrapeSearchResults(
        currentTerm.term, 
        currentTerm.minPrice, 
        currentTerm.maxPrice, 
        currentPage
      );

      // If no results, try next term
      if (searchResult.products.length === 0 && currentTermIndex < searchContext.terms.length - 1) {
        currentTermIndex++;
        currentPage = 1;
        
        const nextTerm = searchContext.terms[currentTermIndex];
        const nextSearchResult = await requestScraper.scrapeSearchResults(
          nextTerm.term, 
          nextTerm.minPrice, 
          nextTerm.maxPrice, 
          1
        );

        searchResult.products = nextSearchResult.products;
      }

      // Update search context
      searchContext.results = [...searchContext.results, ...searchResult.products];
      searchContext.currentTermIndex = currentTermIndex;
      searchContext.currentPage = currentPage;
      searchContext.lastUpdated = Date.now();

      // Save updated context
      fs.writeFileSync(searchContextPath, JSON.stringify(searchContext, null, 2));

      res.json({
        success: true,
        results: searchResult.products,
        count: searchResult.products.length,
        totalResults: searchContext.totalResults,
        currentTerm: searchContext.terms[currentTermIndex].term,
        currentPage: currentPage,
        searchContextId
      });
    } finally {
      // Clean up scraper resources
      await requestScraper.cleanup();
    }
  } catch (error) {
    console.error('Load more error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Details Endpoint
app.post('/details', async (req, res) => {
  try {
    const { urls = [] } = req.body;

    if (!urls.length) {
      return res.status(400).json({ 
        success: false,
        error: 'No URLs provided' 
      });
    }

    console.log('Received URLs for details:', urls);

    const updatedDetails = await scraper.scrapeDetails(urls);

    console.log('Scraped Details:', updatedDetails);

    if (updatedDetails.length === 0) {
      return res.status(200).json({
        success: true,
        updatedDetails: [],
        error: 'No details found for the provided URLs'
      });
    }

    res.json({
      success: true,
      updatedDetails,
    });
  } catch (error) {
    console.error('Details error:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch additional details' 
    });
  }
});

app.get('/bids', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const data = fs.readFileSync(bidFilePath, 'utf-8');
    const bidsData = JSON.parse(data);
    
    // Ensure bids is an array
    const bids = Array.isArray(bidsData) 
      ? bidsData 
      : (bidsData.bids || []);
    
    console.log('Bids retrieved:', bids);
    res.json(bids);
  } catch (error) {
    console.error(`Error reading bids: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    console.log('=== Login Request ===');
    console.log('Request URL:', req.url);
    console.log('Origin:', req.headers.origin);
    console.log('Login data:', {
      hasUsername: !!req.body.username,
      hasPassword: !!req.body.password
    });

    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password required'
      });
    }

    const loginResult = await scraper.login(username, password);
    
    if (loginResult.requiresTwoFactor) {
      return res.json({
        success: true,
        requiresTwoFactor: true,
        message: 'Two-factor authentication required'
      });
    }

    res.json({
      success: true,
      message: 'Login successful',
      data: loginResult
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false, 
      message: error.message || 'Login failed'
    });
  }
});

app.post('/update-bid-prices', async (req, res) => {
  try {
    console.log('Received update bid prices request:', req.body);

    const { productUrls } = req.body;

    if (!Array.isArray(productUrls) || productUrls.length === 0) {
      console.warn('Invalid or empty product URLs array');
      return res.status(400).json({
        success: false,
        message: 'Product URLs must be an array and cannot be empty',
      });
    }

    const updatedBids = [];

    for (const productUrl of productUrls) {
      try {
        const bidDetails = await scraper.updateBid(productUrl);
        updatedBids.push(bidDetails);
      } catch (error) {
        console.error(`Failed to update bid for URL: ${productUrl}`, error);
        updatedBids.push({
          productUrl,
          error: error.message || 'Failed to retrieve bid details',
        });
      }

      // Avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    res.json({
      success: true,
      updatedBids,
      count: updatedBids.length,
    });
  } catch (error) {
    console.error('Update bid prices error:', error);
    res.status(500).json({
      success: false,
      error: `Failed to update bid prices: ${error.message}`,
    });
  }
});

app.post('/login-two-factor', async (req, res) => {
  try {
    const { twoFactorCode } = req.body;

    if (!twoFactorCode) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor code is required'
      });
    }

    const loginResult = await scraper.submitTwoFactorCode(twoFactorCode);
    res.json({
      success: true,
      message: 'Two-factor authentication successful',
      data: loginResult
    });
  } catch (error) {
    console.error('Two-factor authentication error:', error);
    res.status(500).json({
      success: false, 
      message: error.message || 'Two-factor authentication failed'
    });
  }
});

// Debug middleware
app.use((req, res, next) => {
  console.log('\n=== Request ===');
  console.log(`${req.method} ${req.url}`);
  console.log('Origin:', req.headers.origin);
  console.log('Headers:', {
    'content-type': req.headers['content-type'],
    'accept': req.headers.accept,
    'origin': req.headers.origin
  });
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error'
  });
});

const SERVER_TIMEOUT = 900000; // 15 minutes
const PORT = process.env.PORT || 10000;

// Create server with timeout settings
const server = app.listen(PORT, () => console.log(`Server running on ${PORT}`));
server.timeout = SERVER_TIMEOUT;
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

// Inactivity check interval
const inactivityCheck = setInterval(() => {
  const timeSinceLastActivity = Date.now() - lastActivityTimestamp;
  
  if (timeSinceLastActivity > INACTIVITY_TIMEOUT) {
    console.log('No activity for 45 minutes, shutting down server...');
    
    // Cleanup before shutdown
    clearInterval(inactivityCheck);
    
    // Close browser instances
    scraper.cleanup().then(() => {
      // Close the server
      server.close(() => {
        console.log('Server shut down gracefully');
        process.exit(0);
      });
    }).catch(error => {
      console.error('Error during cleanup:', error);
      process.exit(1);
    });
  }
}, 60000); // Check every minute

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  clearInterval(inactivityCheck);
  
  scraper.cleanup().then(() => {
    server.close(() => {
      console.log('Server shut down gracefully');
      process.exit(0);
    });
  }).catch(error => {
    console.error('Error during cleanup:', error);
    process.exit(1);
  });
});