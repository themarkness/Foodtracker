const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { getDb, initSchema, importCoFID } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Food Search ──────────────────────────────────────────────────────────────

// Search CoFID, fall back to Open Food Facts
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const db = getDb();

  // CoFID search
  const local = db.prepare(`
    SELECT id, name, kcal_per_100g, protein_per_100g, source
    FROM foods
    WHERE name LIKE ?
    ORDER BY
      CASE WHEN name LIKE ? THEN 0 ELSE 1 END,
      length(name)
    LIMIT 20
  `).all(`%${q}%`, `${q}%`);

  if (local.length > 0) {
    return res.json(local.map(f => ({
      id: f.id,
      name: f.name,
      kcal_per_100g: f.kcal_per_100g,
      protein_per_100g: f.protein_per_100g,
      source: f.source
    })));
  }

  // Open Food Facts fallback
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=10&fields=product_name,nutriments`;
    const response = await fetch(url, { timeout: 8000 });
    const data = await response.json();

    const results = (data.products || [])
      .filter(p => p.product_name && p.nutriments)
      .map(p => ({
        id: null,
        name: p.product_name,
        kcal_per_100g: p.nutriments['energy-kcal_100g'] ?? p.nutriments['energy-kcal'] ?? null,
        protein_per_100g: p.nutriments['proteins_100g'] ?? null,
        source: 'openfoodfacts'
      }))
      .filter(p => p.kcal_per_100g !== null);

    return res.json(results);
  } catch (err) {
    console.error('Open Food Facts error:', err.message);
    return res.json([]);
  }
});

// Barcode lookup via Open Food Facts
app.get('/api/barcode/:code', async (req, res) => {
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${req.params.code}.json`;
    const response = await fetch(url, { timeout: 8000 });
    const data = await response.json();

    if (data.status !== 1 || !data.product) {
      return res.json(null);
    }

    const p = data.product;
    const n = p.nutriments || {};
    return res.json({
      id: null,
      name: p.product_name || p.generic_name || req.params.code,
      kcal_per_100g: n['energy-kcal_100g'] ?? n['energy-kcal'] ?? null,
      protein_per_100g: n['proteins_100g'] ?? null,
      source: 'openfoodfacts'
    });
  } catch (err) {
    console.error('Barcode lookup error:', err.message);
    return res.json(null);
  }
});

// ── Food Log ─────────────────────────────────────────────────────────────────

app.get('/api/log/:date', (req, res) => {
  const db = getDb();
  const entries = db.prepare(`
    SELECT id, food_name, portion_g, kcal, protein, logged_at
    FROM food_log
    WHERE date = ?
    ORDER BY logged_at ASC
  `).all(req.params.date);
  res.json(entries);
});

app.post('/api/log', (req, res) => {
  const { date, food_id, food_name, portion_g, kcal_per_100g, protein_per_100g } = req.body;

  if (!date || !food_name || !portion_g) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const kcal = ((kcal_per_100g || 0) * portion_g) / 100;
  const protein = ((protein_per_100g || 0) * portion_g) / 100;

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO food_log (date, food_id, food_name, portion_g, kcal, protein)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(date, food_id || null, food_name, portion_g, kcal, protein);

  res.json({ id: result.lastInsertRowid, kcal, protein });
});

app.delete('/api/log/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM food_log WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Weight Log ────────────────────────────────────────────────────────────────

app.get('/api/weight', (req, res) => {
  const db = getDb();
  const entries = db.prepare(`
    SELECT date, weight_kg FROM weight_log ORDER BY date ASC
  `).all();
  res.json(entries);
});

app.post('/api/weight', (req, res) => {
  const { date, weight_kg } = req.body;
  if (!date || !weight_kg) return res.status(400).json({ error: 'Missing fields' });

  const db = getDb();
  db.prepare(`
    INSERT INTO weight_log (date, weight_kg) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg, logged_at = datetime('now')
  `).run(date, weight_kg);

  res.json({ ok: true });
});

app.delete('/api/weight/:date', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM weight_log WHERE date = ?').run(req.params.date);
  res.json({ ok: true });
});

// ── Serve frontend ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

initSchema();
importCoFID().then(() => {
  app.listen(PORT, () => {
    console.log(`\nFoodTracker running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
