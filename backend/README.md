# MyCar Backend

Minimal backend for a personal vehicle app.

## What it does

- exposes `POST /vehicle`
- accepts `{ "registrationNumber": "AB12CDE" }`
- returns normalized vehicle JSON
- runs with no database

## Modes

### `govuk`

Uses the public GOV.UK vehicle enquiry flow.

```bash
SCRAPER_MODE=govuk
```

This currently extracts:

- registration number
- make
- colour
- fuel type
- year of manufacture
- engine capacity
- tax status
- tax due date
- MOT status
- MOT expiry date

### `demo`

Safe default for app development.

```bash
SCRAPER_MODE=demo
```

### `html`

Fetches HTML from a URL template and attempts to parse common selectors.

```bash
SCRAPER_MODE=html
SCRAPER_TARGET_URL=https://example.com/vehicle/{registrationNumber}
```

Replace `{registrationNumber}` in the target URL template with the vehicle registration.

## Run

```bash
cd backend
npm install
npm run dev
```

## Deploy on Render

This repo includes `render.yaml` at the project root. In Render, create a
Blueprint from the Git repository, or create a Web Service manually with:

- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Environment variable: `SCRAPER_MODE=govuk`

## Notes

- This backend does not include a database.
- The backend defaults to `govuk` mode unless you override `SCRAPER_MODE`.
- The `html` scraper is a starting point, not a guaranteed DVLA integration.
- If the target site changes markup or blocks bots, scraping will fail and you will need to update `src/vehicle-service.js`.
