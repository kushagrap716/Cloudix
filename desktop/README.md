# Cloudix Desktop

One `.exe`, nothing else to install. The app contains the Cloudix interface, the Cloudix server and its own
database (MariaDB). Double-click it and it starts everything; closing it stops everything.

## Build the .exe (on Windows)

1. Install Node.js (nodejs.org) once.
2. Double-click `build-windows-exe.bat` in the project root.
   It builds the web app and server, downloads the official MariaDB Windows zip (about 90 MB, checksum-verified),
   and packages everything. The first build takes several minutes and needs internet.
3. Your files are in `desktop/release/`:
   - `Cloudix Setup 1.0.0.exe` installer
   - `Cloudix 1.0.0.exe` portable, runs without installing

Give either file to anyone: they just double-click it.

## Using it

- First launch: it sets up its database automatically (can take a minute), then opens the dashboard directly.
- There is no login or registration; the app opens straight to the dashboard.
- To add storage: **Settings → Google Credentials** (your Google Cloud Client ID/Secret, redirect URI
  `http://localhost:47920/connected-accounts/google/callback`), then **Settings → Connect Drive** for each Google account.
- Your data lives in the app's settings folder (Help → Show Settings Folder): `mariadb-data` (database),
  `secrets.json` (keys; keep it, losing it breaks saved Drive connections), `logs/`.

## Options (File → Server Settings…, Ctrl+,)

- **Built-in server + Included database** is the default.
- **Built-in server + My own MySQL**: use an existing MySQL/MariaDB (address like `mysql://root:pw@localhost:3306/cloudix`).
- **Separate server**: connect to a backend you run yourself (set `FRONTEND_URL=http://127.0.0.1:47919` on it).

## Notes

- Windows may ask about the firewall the first time (the server runs only on your PC); "Private networks" is enough.
- If Windows reports a missing component when the database starts, install "Microsoft Visual C++ Redistributable 2015-2022 (x64)".
- Share links point at this PC, so they only work on this computer.
- reCAPTCHA is disabled in this build.
- If the database download is blocked during the build, download the Windows ZIP from https://mariadb.org/download/ into `desktop/vendor/` and build again, or build anyway: the app then asks for your own MySQL.
- MariaDB is GPL-licensed software bundled unmodified.
- Developers: `cd desktop && npm install && npm start`; `npm test` runs the tests.
