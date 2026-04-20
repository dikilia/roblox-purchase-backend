const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize SQLite database for purchase queue
const db = new sqlite3.Database('./purchases.db');

db.serialize(() => {
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
});

// Add purchase to queue
app.post('/api/queue-purchase', (req, res) => {
  const { cookie, gamepassId } = req.body;
  
  if (!cookie || !gamepassId) {
    return res.status(400).json({ error: 'Missing cookie or gamepassId' });
  }

  db.run(
    'INSERT INTO purchase_queue (cookie, gamepass_id) VALUES (?, ?)',
    [cookie, gamepassId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to queue purchase' });
      }
      res.json({ 
        success: true, 
        queueId: this.lastID,
        message: 'Purchase queued. Your local bridge will process it.'
      });
    }
  );
});

// Get queue status (for frontend polling)
app.get('/api/queue-status/:id', (req, res) => {
  db.get(
    'SELECT * FROM purchase_queue WHERE id = ?',
    [req.params.id],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: 'Queue item not found' });
      }
      res.json(row);
    }
  );
});

// Endpoint for local bridge to fetch pending purchases
app.get('/api/pending-purchases', (req, res) => {
  const authToken = req.headers['x-bridge-token'];
  
  if (authToken !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  db.all(
    "SELECT * FROM purchase_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5",
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(rows);
    }
  );
});

// Endpoint for local bridge to update purchase status
app.post('/api/update-purchase', (req, res) => {
  const authToken = req.headers['x-bridge-token'];
  
  if (authToken !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, status, errorMessage, userId, transactionId } = req.body;

  db.run(
    `UPDATE purchase_queue 
     SET status = ?, 
         processed_at = CURRENT_TIMESTAMP,
         error_message = ?,
         user_id = ?,
         transaction_id = ?
     WHERE id = ?`,
    [status, errorMessage, userId, transactionId, id],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Update failed' });
      }
      res.json({ success: true });
    }
  );
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend queue server running on port ${PORT}`);
});
