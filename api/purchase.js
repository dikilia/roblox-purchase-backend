const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Enable CORS for your frontend
app.use(cors({
  origin: [
    'https://roblox-purchase-frontend.vercel.app',
    'http://localhost:3000'
  ],
  credentials: true
}));

app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Roblox Purchase Proxy',
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    name: 'Roblox Purchase Proxy API',
    version: '2.0.0',
    endpoints: [
      'POST /api/proxy-purchase - Execute gamepass purchase',
      'GET /api/health - Health check'
    ]
  });
});

// Main proxy endpoint for purchasing gamepasses
app.post('/api/proxy-purchase', async (req, res) => {
  const { cookie, gamepassId } = req.body;

  // Validation
  if (!cookie) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing cookie' 
    });
  }

  if (!gamepassId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing gamepassId' 
    });
  }

  // Validate cookie format
  if (!cookie.includes('_|WARNING')) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid cookie format. Should start with "_|WARNING"' 
    });
  }

  // Validate gamepass ID is numeric
  if (!/^\d+$/.test(gamepassId)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Gamepass ID must be numeric' 
    });
  }

  try {
    // Create axios instance with cookie
    const session = axios.create({
      headers: {
        Cookie: `.ROBLOSECURITY=${cookie.trim()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 30000 // 30 second timeout
    });

    // Step 1: Get CSRF Token
    let csrfToken;
    try {
      const csrfResponse = await session.post('https://auth.roblox.com/v2/logout', {});
      csrfToken = csrfResponse.headers['x-csrf-token'];
      
      if (!csrfToken) {
        throw new Error('No CSRF token in response headers');
      }
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired cookie. Please refresh your cookie and try again.'
        });
      }
      throw new Error(`Failed to get CSRF token: ${error.message}`);
    }

    // Step 2: Get authenticated user info
    let userId, username;
    try {
      const userResponse = await session.get('https://users.roblox.com/v1/users/authenticated');
      userId = userResponse.data.id;
      username = userResponse.data.name;
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: 'Failed to authenticate user. Cookie may be invalid.'
      });
    }

    // Step 3: Get gamepass product info
    let productData;
    try {
      const productResponse = await session.get(
        `https://economy.roblox.com/v1/game-pass/${gamepassId}/product-info`
      );
      productData = productResponse.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return res.status(404).json({
          success: false,
          error: `Gamepass ID ${gamepassId} not found`
        });
      }
      throw new Error(`Failed to get gamepass info: ${error.message}`);
    }

    // Check if gamepass is for sale
    if (!productData.Price) {
      return res.status(400).json({
        success: false,
        error: 'This gamepass is not for sale or is free'
      });
    }

    // Step 4: Execute purchase
    let purchaseResult;
    try {
      const purchaseData = {
        expectedCurrency: 1, // 1 = Robux
        expectedPrice: productData.Price,
        expectedSellerId: productData.Creator.Id
      };

      const purchaseResponse = await session.post(
        `https://economy.roblox.com/v1/purchases/products/${productData.ProductId}`,
        purchaseData,
        { 
          headers: { 
            'x-csrf-token': csrfToken,
            'Content-Type': 'application/json'
          } 
        }
      );

      purchaseResult = purchaseResponse.data;
    } catch (error) {
      // Handle specific Roblox error responses
      if (error.response?.data?.errors) {
        const robloxError = error.response.data.errors[0];
        
        if (robloxError.message?.includes('InsufficientFunds')) {
          return res.status(402).json({
            success: false,
            error: 'Insufficient Robux to purchase this gamepass',
            required: productData.Price
          });
        }
        
        if (robloxError.message?.includes('AlreadyOwned')) {
          return res.status(409).json({
            success: false,
            error: 'You already own this gamepass'
          });
        }
        
        return res.status(400).json({
          success: false,
          error: robloxError.message || 'Purchase failed'
        });
      }
      
      throw error;
    }

    // Success response
    return res.json({
      success: true,
      message: 'Purchase completed successfully',
      data: {
        userId: userId,
        username: username,
        gamepassId: gamepassId,
        gamepassName: productData.Name,
        price: productData.Price,
        productId: productData.ProductId,
        transactionId: purchaseResult.transactionId || 'N/A',
        purchasedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Proxy purchase error:', error.message);
    
    // Check if it's a network/timeout error
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return res.status(504).json({
        success: false,
        error: 'Request timeout. Roblox API may be slow. Please try again.'
      });
    }
    
    // Generic error
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again later.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get gamepass info endpoint (optional, for preview)
app.get('/api/gamepass-info/:id', async (req, res) => {
  const gamepassId = req.params.id;
  const cookie = req.headers['x-roblox-cookie'];

  if (!cookie) {
    return res.status(400).json({ error: 'Cookie required in x-roblox-cookie header' });
  }

  try {
    const session = axios.create({
      headers: {
        Cookie: `.ROBLOSECURITY=${cookie}`,
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const response = await session.get(
      `https://economy.roblox.com/v1/game-pass/${gamepassId}/product-info`
    );

    res.json({
      success: true,
      data: {
        id: gamepassId,
        name: response.data.Name,
        price: response.data.Price,
        creator: response.data.Creator.Name,
        productId: response.data.ProductId
      }
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: 'Failed to fetch gamepass info'
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// For Vercel serverless
module.exports = app;

// For local development
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`✅ Backend proxy running on http://localhost:${PORT}`);
    console.log(`📡 Endpoints:`);
    console.log(`   POST /api/proxy-purchase`);
    console.log(`   GET  /api/health`);
  });
}
