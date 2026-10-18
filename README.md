![Cloudix cover](https://i.ibb.co.com/35BySv1C/image.png)

# Cloudix

Cloudix is a storage gateway web and desktop application for uniting multiple Google Drive and S3-compatible storage accounts into one seamless virtual storage dashboard.

There is no multi-user registration or login screen: Cloudix is built for personal, homelab, and self-hosted use, opening directly to your storage dashboard as a single built-in local user. Connect your Google Drive accounts from Settings, track combined quotas, upload files into a dedicated `cloudix` folder, organize files with virtual folders, preview/stream files, sync MySQL from Google Drive, and let the backend automatically route uploads to connected drives with sufficient free space.

---

> [!CAUTION]
> **CRITICAL SECURITY NOTICE FOR SERVER / VPS DEPLOYMENTS**
> Cloudix runs as a single built-in user and has **no login screen**. Anyone who can reach the web interface has full control over all files and connected Google Drive / S3 storage accounts.
>
> **NEVER expose ports `5173` or `4000` directly to the public internet.**
> When deploying on a VPS or remote server, you **MUST** put Cloudix behind:
> - **A reverse proxy with HTTP Basic Auth** (Nginx / Caddy with `htpasswd`), or
> - **A private mesh VPN** (e.g., [Tailscale](https://tailscale.com) or WireGuard), or
> - **Zero Trust Tunnel / Cloudflare Access** with email/OAuth protection, or
> - **An SSH Tunnel** (`ssh -N -L 5173:127.0.0.1:5173 -L 4000:127.0.0.1:4000 user@your-vps`).

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
## Features

- **Multi-Account Storage Gateway**: Connect multiple Google Drive and S3-compatible accounts into one virtual drive.
- **S3-Compatible Storage Support**: Custom endpoints for MinIO, Cloudflare R2, Wasabi, Backblaze B2, and AWS S3.
- **Direct Upload Streaming**: Files stream directly through the backend into storage—never saved to server disk.
- **Dedicated Folder Structure**: Google Drive uploads are saved under a dedicated root `cloudix` folder.
- **Large File Splitting**: Files that exceed the remaining capacity of a single drive are automatically split across multiple connected drives and stitched seamlessly upon download or preview.
- **Upload Routing Policies**: Configurable routing modes (`most-available`, `round-robin`, and `priority-order`).
- **External Upload API**: Upload files programmatically via `POST /api/v1/uploads` using hashed API keys.
- **Zero Login Friction**: Designed for personal use—opens straight to your dashboard.
- **Starred Files & Organization**: Favorite files, organize with virtual folders, rename, move, and batch delete.
- **Database Backup & Restore**: Download database backups or restore directly from the Settings UI.
- **Quota Tracking & Auto-Sync**: View total, used, and available space across all accounts and sync changes from Google Drive.
- **Desktop Application**: Includes an Electron-based desktop app bundling MariaDB for true zero-install local usage.
- **Automated Updates**: Trigger background updates via `update.sh` with live logs in the Settings UI.

---
## Project Structure

```txt
backend/   Express API, Prisma ORM, Google Drive & S3 streaming, upload engine
frontend/  React + Vite dashboard UI
desktop/   Electron desktop app bundling local database runner
```

## Requirements

- **Node.js**: 20+
- **npm**
- **MySQL / MariaDB**: MySQL 8+ or MariaDB 10.5+ running locally (or via Docker)
- **Google Cloud Project**: With Google Drive API enabled and OAuth Client ID/Secret

> [!WARNING]
> **Database Security Warning**: The default database configuration (`localhost:3306`, user: `root`, empty password) is intended strictly for rapid local development. Never expose a database with empty or root credentials on a production server. Always configure a dedicated database user with a strong password.

---

## 1. Quick Setup & Installation (Recommended)

The easiest way to set up Cloudix locally is using the automated setup script. It generates `.env` files with secure cryptographic secrets, installs all dependencies, and prepares Prisma:

### Windows (PowerShell)
```powershell
cd Cloudix
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

### Linux / macOS
```bash
cd Cloudix
bash ./setup.sh
```

Follow the prompts to enter your MySQL connection URL.

Once complete, start the backend and frontend in separate terminals:

```bash
# Terminal 1 - Backend
cd backend
npm run prisma:migrate
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

Open `http://localhost:5173` in your browser.

---

## 2. Manual Installation (Alternative)

If you prefer to configure the project step-by-step:

### 2.1 Install Dependencies
```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 2.2 Create Database
```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS cloudix;"
```

### 2.3 Backend Environment Setup
Create `backend/.env` (or copy from `backend/.env.example`):

```env
DATABASE_URL="mysql://root:yourpassword@localhost:3306/cloudix"
APP_PORT=4000
FRONTEND_URL="http://localhost:5173"
JWT_ACCESS_SECRET="generate-a-random-secret-at-least-32-chars-long"
TOKEN_ENCRYPTION_KEY="generate-a-random-secret-at-least-32-chars-long"
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
MAX_UPLOAD_BYTES=5368709120

# Optional Google OAuth config (can also be entered via Settings in UI)
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GOOGLE_REDIRECT_URI="http://localhost:4000/connected-accounts/google/callback"
```

### 2.4 Frontend Environment Setup
Create `frontend/.env` (or copy from `frontend/.env.example`):

```env
VITE_API_URL=http://localhost:4000
```

---

## 3. Run Prisma Migrations

Apply the database schema:

```bash
cd backend
npm run prisma:migrate
```

---

## 4. Google Cloud Setup

OAuth and Drive APIs are managed in the [Google Cloud Console](https://console.cloud.google.com/).

### 4.1 Enable Google Drive API
1. Navigate to **APIs & Services** -> **Library**.
2. Search for **Google Drive API** and click **Enable**.

### 4.2 Configure OAuth Consent Screen
1. Go to **APIs & Services** -> **OAuth consent screen**.
2. Choose **External** user type.
3. Fill in required App name and email fields.
4. Add the following scopes:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
5. If the app publishing status is **Testing**, add your Google account under **Test users**.

### 4.3 Create OAuth Client ID
1. Go to **APIs & Services** -> **Credentials** -> **Create Credentials** -> **OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized JavaScript origins**:
   - `http://localhost:5173` (for local dev) or `https://your-domain.com` (production)
4. **Authorized redirect URIs**:
   - `http://localhost:4000/connected-accounts/google/callback` (for local dev) or `https://api.your-domain.com/connected-accounts/google/callback` (production)
5. Copy your **Client ID** and **Client Secret**.

### 4.4 Save Credentials
You can either run `npm run seed:google-config` in `backend/` or enter them directly in the Cloudix web interface under **Settings -> Google Credentials**.

---

## 5. Docker Deployment

Cloudix includes Docker configuration for running MySQL, Backend, and Frontend together:

```bash
# 1. Copy the docker environment template
cp .env.docker.example .env

# 2. Edit .env with your secrets and domain

# 3. Build and launch containers
docker compose up -d --build
```

Container endpoints:
- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`
- MySQL: `localhost:3306`

To view logs:
```bash
docker compose logs -f
```

To stop:
```bash
docker compose down
```

---

## 6. VPS Deployment & Security Guide

### Secure Setup Checklist for Remote Servers

1. **Do not bind ports 5173 or 4000 to `0.0.0.0`**. In your `docker-compose.yml`, bind ports to localhost only (`127.0.0.1:5173:80` and `127.0.0.1:4000:4000`).
2. **Put Cloudix behind Nginx / Caddy with HTTP Basic Authentication** and SSL.

#### Example Secure Nginx Configuration

Install `apache2-utils` to generate a password:
```bash
sudo apt install apache2-utils -y
sudo htpasswd -c /etc/nginx/.htpasswd yourusername
```

Create `/etc/nginx/sites-available/cloudix`:
```nginx
server {
    listen 80;
    server_name cloudix.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name cloudix.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/cloudix.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cloudix.yourdomain.com/privkey.pem;

    # Require username and password to access Cloudix
    auth_basic "Cloudix Storage Access";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # Frontend
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend API & Uploads
    location /api/ {
        proxy_pass http://127.0.0.1:4000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 50G;
    }
}
```

#### Step-by-Step Server Setup
```bash
# 1. Clone repository
git clone https://github.com/kushagrap716/Cloudix.git
cd Cloudix

# 2. Configure .env with your domain and strong credentials
cp .env.docker.example .env
nano .env

# 3. Start containers
docker compose up -d --build
```

---

## 7. Windows Desktop Application

Cloudix includes an Electron desktop app with an embedded, isolated MariaDB database. It requires no installation of MySQL or Node.js on end-user machines.

- **To run in development:**
  ```powershell
  cd desktop
  npm install
  npm start
  ```
- **To build installer & portable `.exe`:**
  Double-click `build-windows-exe.bat` from the root folder. Output executables are created in `desktop/release/`.

---

## 8. API Overview

All routes run as the built-in local user (`requireAuth`).

### Auth
```txt
GET /auth/me       (Returns current local user session)
```

### Storage Accounts & Quota
```txt
GET /storage/summary                       (Combined quota metrics)
GET /connected-accounts                    (List connected Drive / S3 accounts)
GET /connected-accounts/google/connect-url (Initiate Google OAuth)
GET /connected-accounts/google/callback    (OAuth callback handler)
POST /connected-accounts/:id/sync-quota    (Force quota recalculation)
DELETE /connected-accounts/:id             (Disconnect account)
```

### Virtual Folders
```txt
GET /folders               (List virtual folders)
GET /folders/recent?limit=4
POST /folders              (Create virtual folder)
PATCH /folders/:id         (Rename / move folder)
DELETE /folders/:id        (Delete folder)
```

### Files
```txt
GET /files                 (List files with filtering/sorting)
GET /files?folderId=<id>
GET /files?q=<search>
GET /files/:id             (Get file metadata)
PATCH /files/:id           (Rename / move)
PATCH /files/batch         (Batch move/favorite)
DELETE /files/:id          (Delete file and its storage chunks)
DELETE /files/batch        (Batch delete)
POST /files/sync-google    (Sync missing files from Drive cloudix folder)
POST /files/:id/share      (Create public share link)
DELETE /files/:id/share    (Revoke public share link)
GET /files/:id/download    (Stream file download)
GET /files/:id/view-url    (Get temporary streaming URL)
```

### Uploads
```txt
POST /uploads              (Multipart stream upload to connected storage)
POST /api/v1/uploads       (External API upload using API Key header 'x-api-key')
```

---

## 9. Automated Updates (`update.sh`)

Cloudix includes an automated update script [`update.sh`](update.sh). You can trigger updates directly from the **Settings** page in the UI, or run it manually:

```bash
chmod +x update.sh
./update.sh
```

The script:
1. Resets uncommitted file modifications (`git reset --hard origin/main`).
2. Pulls the latest commits from GitHub.
3. Installs dependencies and recompiles the backend and frontend.
4. Executes any pending Prisma database migrations.
5. Restarts PM2 (`cloudix-backend`) or Docker containers.

---

## 10. Large File Splitting (Multi-Drive Storage)

If a file exceeds the available free space on a single connected Google Drive account:
1. Cloudix automatically cuts the file into chunked parts during upload.
2. Parts are distributed across distinct connected Drive accounts in a `cloudix/cloudix-parts` folder.
3. When previewing or downloading, Cloudix streams and stitches the parts back together sequentially with checksum validation.
4. Deleting a split file cleans up all parts across all corresponding Google Drives.
