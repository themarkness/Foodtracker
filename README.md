# FoodTracker

A personal calorie and protein tracking web app. Targets 1,600 kcal / 130g protein daily goals.

## Features

- **Food search** — searches CoFID database locally, falls back to Open Food Facts API
- **Daily food log** — log portions, see running kcal/protein totals with progress bars
- **Weight log** — log weight in kg or stone/lbs, view history as a line chart
- **Dark mode**, mobile-friendly, no build step

## Setup

### 1. Download the CoFID Excel file

Go to:
> https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid

Download the Excel (.xlsx) file ("Composition of Foods Integrated Dataset") and place it in the `/data` folder:

```
Foodtracker/
  data/
    McCance_Widdowsons_...xlsx   ← place it here
  index.js
  db.js
  public/
  package.json
```

The filename doesn't matter — the app picks up any `.xlsx` or `.xls` file in `/data`.

### 2. Install dependencies

```bash
npm install
```

### 3. Run

```bash
node index.js
```

The app will:
1. Create the SQLite database at `data/foodtracker.db`
2. Import foods from the CoFID Excel file (first run only, ~2,000 foods)
3. Start the server at **http://localhost:3000**

---

## Usage

### Diary tab

1. Type a food name in the search box
2. Select a result from the dropdown
3. Enter a portion size in grams (or use the quick-select buttons)
4. Click **Add** — the food appears in today's log

Progress bars fill as you approach your daily goals. Over-goal bars turn red.

### Weight tab

Select a date, enter your weight (kg or stone/lbs), and click **Save**. A line chart shows your history.

---

## Tech

- **Backend**: Node.js + Express
- **Database**: SQLite via `better-sqlite3`
- **Frontend**: Single HTML file, vanilla JS, Chart.js from CDN
- **Food data**: CoFID (local) + Open Food Facts API (fallback)

## Troubleshooting

**"No CoFID Excel file found"** — Download the file from GOV.UK and place it in `/data`. See step 1.

**Search returns no results** — If the CoFID import found 0 foods, the app will fall back to Open Food Facts for every search. Check the console output on startup for import errors.

**CoFID column detection failed** — Open `db.js` and look at the console output. It prints the first 5 rows of the sheet so you can identify which columns contain food name, kcal, and protein. Update the header detection logic accordingly.
