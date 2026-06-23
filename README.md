# MyCar Prototype

Android-first Expo prototype for a personal vehicle tracker with no backend.

There is also now a separate optional `backend/` service for a scraper/proxy architecture.

## What this version does

- Save multiple UK vehicle registrations locally on the device
- Store a DVLA API key locally on the device
- Refresh DVLA vehicle data on demand
- Show MOT status, MOT expiry, tax status, tax due date, and basic vehicle details
- Store insurance expiry as a manual field for now
- Schedule local MOT and insurance reminder notifications

## Why insurance is manual

Public UK sources can tell you whether a vehicle appears insured, but they do not provide a clean public way to fetch policy expiry from only a registration number. This prototype keeps insurance expiry as user-entered data.

## Run

```bash
npm install
npm run android
```

## Optional backend

```bash
cd backend
npm install
npm run dev
```

Or from the project root:

```bash
npm run backend
```

The backend starts in `govuk` mode by default. See [backend/README.md](/abs/path/C:/Users/smoti/Desktop/MyCar/backend/README.md) for scraper configuration.

## Notes

- The app calls the DVLA Vehicle Enquiry API directly from the device.
- For a personal prototype, that is acceptable.
- For a public app, a direct mobile API key is not a strong design because it can be extracted from the app.
- Local reminders use `expo-notifications`.
- On Android, notification features are most reliable in a development build or standalone app, not plain Expo Go.
