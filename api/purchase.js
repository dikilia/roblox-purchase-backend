const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:l56MlTLdqPIJprtt@db.laceyqhdrxivqhzdvqua.supabase.co:5432/postgres',
  ssl: {
    rejectUnauthorized: false
  }
});

// Initialize table
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_queue (
        id BIGSERIAL PRIMARY KEY,
        cookie TEXT NOT NULL,
        gamepass_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        error_message TEXT,
        user_id TEXT,
        transaction_id TEXT
      )
    `);
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ Database init failed:', err.message);
  } finally {
    client.release();
  }
}

initDatabase();

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', database: 'disconnected', error: err.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    name: 'Roblox Gamepass Queue API',
    version: '2.0.0',
    database: 'Supabase PostgreSQL',
    status: 'online'
  });
});

// Queue purchase
app.post('/api/queue-purchase', async (req, res) => {
  const { cookie, gamepassId } = req.body;
  
  if (!cookie || !gamepassId) {
    return res.status(400).json({ error: 'Missing cookie or gamepassId' });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      'INSERT INTO purchase_queue (cookie, gamepass_id) VALUES ($1, $2) RETURNING id',
      [cookie, gamepassId]
    );
    
    res.json({ 
      success: true, 
      queueId: result.rows[0].id,
      message: 'Purchase queued. Your local bridge will process it.'
    });
  } catch (err) {
    console.error('Queue error:', err.message);
    res.status(500).json({ error: 'Failed to queue purchase' });
  } finally {
    client.release();
  }
});

// Get queue status
app.get('/api/queue-status/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT id, gamepass_id, status, created_at, processed_at, error_message, user_id, transaction_id FROM purchase_queue WHERE id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Queue item not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Status error:', err.message);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// Get pending purchases (PROTECTED - for bridge)
app.get('/api/pending-purchases', async (req, res) => {
  const authToken = req.headers['x-bridge-token'];
  
  if (authToken !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM purchase_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5"
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Pending error:', err.message);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// Update purchase status (PROTECTED - for bridge)
app.post('/api/update-purchase', async (req, res) => {
  const authToken = req.headers['x-bridge-token'];
  
  if (authToken !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, status, errorMessage, userId, transactionId } = req.body;

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE purchase_queue 
       SET status = $1, 
           processed_at = NOW(), 
           error_message = $2, 
           user_id = $3, 
           transaction_id = $4
       WHERE id = $5`,
      [status, errorMessage || null, userId || null, transactionId || null, id]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error('Update error:', err.message);
    res.status(500).json({ error: 'Update failed' });
  } finally {
    client.release();
  }
});

module.exports = app;
