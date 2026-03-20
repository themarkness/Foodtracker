const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

// On Render, DATA_DIR is the persistent disk mount path (/data).
// Locally it defaults to ./data relative to the project root.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'foodtracker.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function initSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS foods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kcal_per_100g REAL,
      protein_per_100g REAL,
      source TEXT DEFAULT 'cofid'
    );

    CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(name);

    CREATE TABLE IF NOT EXISTS food_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      food_id INTEGER,
      food_name TEXT NOT NULL,
      portion_g REAL NOT NULL,
      kcal REAL NOT NULL,
      protein REAL NOT NULL,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_food_log_date ON food_log(date);

    CREATE TABLE IF NOT EXISTS weight_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      weight_kg REAL NOT NULL,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_weight_log_date ON weight_log(date);
  `);
}

async function importCoFID() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM foods').get();
  if (count.c > 0) {
    console.log(`CoFID already imported (${count.c} foods). Skipping.`);
    return;
  }

  // Look for Excel file in the data directory
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const files = fs.readdirSync(dataDir).filter(f =>
    f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.xls')
  );

  if (files.length === 0) {
    console.warn('');
    console.warn('⚠️  No CoFID Excel file found in /data directory.');
    console.warn('   Download from: https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid');
    console.warn('   Place the .xlsx file in the /data folder and restart.');
    console.warn('   The app will still work — food search will use Open Food Facts API as fallback.');
    console.warn('');
    return;
  }

  const xlsxPath = path.join(dataDir, files[0]);
  console.log(`Importing CoFID from: ${files[0]}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  console.log('Sheets found:', workbook.worksheets.map(s => s.name));

  // Find the best sheet — prefer one containing "Proximate" or with substantial rows
  const preferred = ['proximate', 'main', 'data', 'foods', 'composition'];
  let targetSheet = null;

  for (const ws of workbook.worksheets) {
    if (preferred.some(p => ws.name.toLowerCase().includes(p))) {
      targetSheet = ws;
      break;
    }
  }

  // Fallback: first sheet with more than 20 rows
  if (!targetSheet) {
    for (const ws of workbook.worksheets) {
      if (ws.rowCount > 20) {
        targetSheet = ws;
        break;
      }
    }
  }

  if (!targetSheet) {
    console.error('Could not find a suitable data sheet in the Excel file.');
    return;
  }

  console.log(`Using sheet: "${targetSheet.name}" (${targetSheet.rowCount} rows)`);

  // Read first 20 rows to detect header row and column positions
  const rows = [];
  targetSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= 30) {
      rows.push({ rowNumber, values: row.values }); // values[0] is undefined (1-indexed)
    }
  });

  let headerRowIdx = -1;
  let nameCol = -1;
  let kcalCol = -1;
  let proteinCol = -1;

  for (const { rowNumber, values } of rows) {
    const cells = values.slice(1).map(c => {
      if (c == null) return '';
      if (typeof c === 'object' && c.text) return c.text.toLowerCase().trim();
      return String(c).toLowerCase().trim();
    });

    const nameIdx = cells.findIndex(c =>
      c === 'food name' || c === 'name' || c === 'food' || c.includes('food name')
    );
    const kcalIdx = cells.findIndex(c =>
      c.includes('kcal') || c === 'energy (kcal)' || (c.includes('energy') && !c.includes('kj'))
    );
    const proteinIdx = cells.findIndex(c =>
      c.includes('protein') && !c.includes('non-') && !c.includes('non ')
    );

    if (nameIdx >= 0 && (kcalIdx >= 0 || proteinIdx >= 0)) {
      headerRowIdx = rowNumber;
      nameCol = nameIdx + 1; // convert to 1-based
      kcalCol = kcalIdx >= 0 ? kcalIdx + 1 : -1;
      proteinCol = proteinIdx >= 0 ? proteinIdx + 1 : -1;
      console.log(`Header row: ${headerRowIdx}`);
      console.log(`  Name col: ${nameCol}, kcal col: ${kcalCol}, protein col: ${proteinCol}`);
      console.log(`  Headers:`, cells.filter(Boolean).slice(0, 10));
      break;
    }
  }

  if (headerRowIdx < 0) {
    console.error('Could not detect column headers. First 5 rows:');
    rows.slice(0, 5).forEach(({ rowNumber, values }) => {
      console.error(`  Row ${rowNumber}:`, values.slice(1, 10));
    });
    console.error('Please check the Excel structure and update db.js accordingly.');
    return;
  }

  // Insert all data rows
  const insert = db.prepare(
    'INSERT INTO foods (name, kcal_per_100g, protein_per_100g, source) VALUES (?, ?, ?, ?)'
  );

  const insertMany = db.transaction((foodRows) => {
    let n = 0;
    for (const { values } of foodRows) {
      const rawName = values[nameCol];
      if (rawName == null) continue;
      const name = typeof rawName === 'object' && rawName.text
        ? rawName.text.trim()
        : String(rawName).trim();

      if (!name || name.toLowerCase().includes('food name')) continue;

      const rawKcal = kcalCol > 0 ? values[kcalCol] : null;
      const rawProtein = proteinCol > 0 ? values[proteinCol] : null;

      const kcal = rawKcal != null ? parseFloat(rawKcal) : null;
      const protein = rawProtein != null ? parseFloat(rawProtein) : null;

      insert.run(name, isNaN(kcal) ? null : kcal, isNaN(protein) ? null : protein, 'cofid');
      n++;

      if (n % 200 === 0) process.stdout.write(`  Imported ${n} foods...\r`);
    }
    return n;
  });

  const dataRows = [];
  targetSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > headerRowIdx) {
      dataRows.push({ rowNumber, values: row.values });
    }
  });

  const total = insertMany(dataRows);
  console.log(`\nImported ${total} foods from CoFID successfully.`);
}

module.exports = { getDb, initSchema, importCoFID };
