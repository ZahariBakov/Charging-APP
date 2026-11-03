# Tesla Charging Tracker

A small web app for logging EV charging sessions — from the phone right after charging, or from the computer — straight into a Google Sheet.

- Plain HTML, CSS and JavaScript, no external libraries (works without a CDN)
- Runs as a Google Apps Script web app: one private link for phone and desktop, data lives in your own Google Sheet
- Also opens locally with a double click (data is then kept in the browser only)

## Features

- Add, edit and delete charging sessions: date, operator, AC/DC, kWh, price, charging time, ending %, odometer
- Monthly view with previous / next month navigation
- Summary cards (energy, money spent, sessions) and an AC/DC energy chart for the selected month
- Search by operator or date (`02.11` works), filter by AC / DC
- Price per kWh computed the same way as in the sheet (`ROUND(price / kWh, 2)`)
- Phone friendly: stacked cards on small screens, large touch targets, accepts both `5,10` and `5.10`
- kWh and price are rounded to 2 decimals (`23,457` → `23,46`)
- Operator list with "+ New operator…"; typing `evpoint` reuses the existing `EvPoint` spelling
- AC/DC is preselected from the last session with the same operator

## How it works

```
Phone / desktop browser ──► Apps Script web app (Index.html) ──google.script.run──► Code.gs ──► Google Sheet
```

| File | Purpose |
|---|---|
| `src/index.html` | Page structure (HTML) |
| `src/style.css` | Styles: dark theme, cards, form, table |
| `src/media.css` | Media queries for tablets and phones |
| `src/script.js` | Browser logic. Detects whether it runs inside Apps Script (uses the sheet) or locally (uses `localStorage` with sample data). |
| `build.ps1` | Inlines the CSS and JS into one file, `dist/Index.html` |
| `dist/Index.html` | **Generated.** The file that goes into Apps Script. Do not edit by hand. |
| `apps-script/Code.gs` | Server side: reads sessions, inserts new rows sorted by date, edits and deletes rows. |
| `SETUP.md` | Step-by-step installation guide (in Bulgarian). |

### Why a build step

Apps Script can only serve HTML files, not separate `.css` / `.js` files. The sources stay split for editing, and `build.ps1` produces a single `dist/Index.html` so deploying still means copying just two files. The phone downloads the same single page either way.

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

`src/index.html` also opens directly in a browser for local development: it links the CSS and JS files normally.

### Expected sheet layout

| B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|
| Date | Operator | Energy (kWh) | Price (EUR) | Time (min) | AC / DC | Price per kWh (formula) | Odometer | Ending % |

- Row 3 is the header, row 4 is an empty "anchor" row, sessions start at row 5 with the newest on top.
- Totals below the sessions can use ranges that start at the anchor row, e.g. `=SUM(D4:D117)`. New sessions are inserted at row 5, inside that range, so the totals include them automatically.
- Reading stops at the first row whose column G is not `AC` or `DC`, so statistics blocks below the data are left alone.
- `SHEET_ID` in `Code.gs` is the `gid` of the sessions tab (the number after `#gid=` in the sheet URL). If it does not match, the first tab is used.

### Safety

- Deploy with **Execute as: Me** and **Who has access: Only myself**. The link only opens for your own Google account.
- Edit and delete send the row as the app last saw it. If the sheet changed in the meantime (for example you edited it by hand), the server refuses and asks you to reload instead of writing to the wrong row.
- Writes are serialized with `LockService`, so saving from the phone and the computer at the same time is safe.

## Setup

See [SETUP.md](SETUP.md). In short: open the sheet → **Extensions → Apps Script** → paste `apps-script/Code.gs` into `Code.gs` and `dist/Index.html` into an HTML file named `Index` → **Deploy → New deployment → Web app**.

After changing the code, run `build.ps1`, paste the files again and use **Deploy → Manage deployments → Edit → New version**. The link stays the same.

## Known limitations

- No offline queue: without internet a session cannot be saved (the form keeps what you typed).
- Changing the date of an existing session does not move its row in the sheet.
- The UI is in English.
