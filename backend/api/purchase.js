const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Use /tmp for SQLite in Vercel (ephemeral, but works for queue)
const dbPath = process.env.NODE_ENV === 'production' 
  ? '/tmp/purchases.db' 
  : './purchases.db';

const db = new Database(dbPath);

// Create table
db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cookie TEXT NOT NULL,
    gamepass_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    error_message TEXT,
    user_id TEXT,
    transaction_id TEXT
  )
`);

// Add purchase to queue (PUBLIC endpoint)
app.post('/api/queue-purchase', (req, res) => {
  const { cookie, gamepassId } = req.body;
  
  if (!cookie || !gamepassId) {
    return res.status(400).json({ error: 'Missing cookie or gamepassId' });
  }

  try {
    const stmt = db.prepare(
      'INSERT INTO purchase_queue (cookie, gamepass_id) VALUES (?, ?)'
    );
    const result = stmt.run(cookie, gamepassId);
    
    res.json({ 
      success: true, 
      queueId: result.lastInsertRowid,
      message: 'Purchase queued. Your local bridge will process it.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue purchase' });
  }
});

// Get queue status (PUBLIC endpoint)
app.get('/api/queue-status/:id', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM purchase_queue WHERE id = ?');
    const row = stmt.get(req.params.id);
    
    if (!row) {
      return res.status(404).json({ error: 'Queue item not found' });
    }
    
    // Don't send the cookie back to frontend
    delete row.cookie;
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Get pending purchases (PROTECTED - only for bridge)
app.get('/api/pending-purchases', (req, res) => {
  const authToken = req.headers['x-bridge-token'];
  
  if (authToken !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const stmt = db.prepare(
      "SELECT * FROM purchase_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5"
    );
    const rows = stmt.all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Update purchase status (PROTECTED - only for bridge)
app.post('/api/update-purchase', (req, res) => {
  const authToken = req.headers['x-bridge-token'];
  
  if (authToken !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, status, errorMessage, userId, transactionId } = req.body;

  try {
    const stmt = db.prepare(`
      UPDATE purchase_queue 
      SET status = ?, 
          processed_at = CURRENT_TIMESTAMP,
          error_message = ?,
          user_id = ?,
          transaction_id = ?
      WHERE id = ?
    `);
    stmt.run(status, errorMessage, userId, transactionId, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    name: 'Roblox Gamepass Queue API',
    version: '1.0.0',
    endpoints: [
      'POST /api/queue-purchase',
      'GET /api/queue-status/:id',
      'GET /api/health'
    ]
  });
});

// For Vercel serverless
module.exports = app;

// For local development
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}
