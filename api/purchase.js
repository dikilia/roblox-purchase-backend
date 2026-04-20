const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

let db;
const DB_PATH = '/tmp/purchases.db';

// Initialize SQL.js database
async function initDatabase() {
  const SQL = await initSqlJs();
  
  let dbData;
  try {
    dbData = fs.readFileSync(DB_PATH);
  } catch {
    dbData = null;
  }
  
  db = new SQL.Database(dbData);
  
  db.run(`
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
  
  saveDatabase();
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Initialize on startup
initDatabase().catch(console.error);

// Health check endpoint - ADDED FIRST for quick response
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    name: 'Roblox Gamepass Queue API',
    version: '1.0.0',
    status: 'online'
  });
});

// Add purchase to queue
app.post('/api/queue-purchase', async (req, res) => {
  const { cookie, gamepassId } = req.body;
  
  if (!cookie || !gamepassId) {
    return res.status(400).json({ error: 'Missing cookie or gamepassId' });
  }

  try {
    db.run(
      'INSERT INTO purchase_queue (cookie, gamepass_id) VALUES (?, ?)',
      [cookie, gamepassId]
    );
    saveDatabase();
    
    const result = db.exec("SELECT last_insert_rowid() as id");
    const queueId = result[0].values[0][0];
    
    res.json({ 
      success: true, 
      queueId: queueId,
      message: 'Purchase queued. Your local bridge will process it.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue purchase' });
  }
});

// Get queue status
app.get('/api/queue-status/:id', async (req, res) => {
  try {
    const result = db.exec(`SELECT * FROM purchase_queue WHERE id = ${req.params.id}`);
    
    if (!result.length || !result[0].values.length) {
      return res.status(404).json({ error: 'Queue item not found' });
    }
    
    const columns = result[0].columns;
    const values = result[0].values[0];
    
    const row = {};
    columns.forEach((col, i) => {
      if (col !== 'cookie') {
        row[col] = values[i];
      }
    });
    
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Get pending purchases
app.get('/api/pending-purchases', async (req, res) => {
  const authToken = req.headers['x-bridge-token'];
  
  if (authToken !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = db.exec(
      "SELECT * FROM purchase_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5"
    );
    
    if (!result.length) {
      return res.json([]);
    }
    
    const rows = result[0].values.map(values => {
      const row = {};
      result[0].columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row;
    });
    
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Update purchase status
app.post('/api/update-purchase', async (req, res) => {
  const authToken = req.headers['x-bridge-token'];
  
  if (authToken !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, status, errorMessage, userId, transactionId } = req.body;

  try {
    db.run(`
      UPDATE purchase_queue 
      SET status = ?, 
          processed_at = CURRENT_TIMESTAMP,
          error_message = ?,
          user_id = ?,
          transaction_id = ?
      WHERE id = ?
    `, [status, errorMessage || null, userId || null, transactionId || null, id]);
    
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = app;
