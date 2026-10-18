'use strict'

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, session, screen } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createLocalServer } = require('./local-server')
const { normalizeServerUrl, normalizeDatabaseUrl } = require('./config')
const backendRunner = require('./backend-runner')
const dbRunner = require('./db-runner')

const DEFAULT_SERVER_URL = 'http://localhost:4000'
const DEFAULT_PORT = 47919
const BACKEND_PORT = 47920
const DEFAULT_DATABASE_URL = 'mysql://root@localhost:3306/cloudix'
const DESKTOP_HEADER = 'X-Cloudix-Desktop'
const DIST_DIR = path.join(__dirname, '..', 'app-dist')
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png')
// Packaged: <install>/resources/backend (outside the asar). Dev: desktop/backend-dist.
// Bundled database (Windows builds): resources/mariadb, or desktop/vendor/mariadb in development.
const MARIADB_DIR = app.isPackaged ? path.join(process.resourcesPath, 'mariadb') : path.join(__dirname, '..', 'vendor', 'mariadb')
const BACKEND_DIR = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.join(__dirname, '..', 'backend-dist')

let config = null
let configPath = ''
let localServer = null
let desktopToken = ''
let mainWindow = null
let settingsWindow = null
let appOrigin = ''
let quitting = false
let splashWindow = null
let backendProcess = null
let pendingSettingsAfterStart = false
let databaseHandle = null
let shutdownDone = false
let logPath = ''

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function builtinAvailable() {
  return fs.existsSync(path.join(BACKEND_DIR, 'dist', 'server.js'))
}

function embeddedDatabaseAvailable() {
  return Boolean(dbRunner.resolveMariadb(MARIADB_DIR))
}

function loadConfig() {
  // New installs use the built-in server when it is bundled. Existing config files without a mode keep using an external server.
  const defaults = {
    mode: builtinAvailable() ? 'builtin' : 'external',
    database: embeddedDatabaseAvailable() ? 'embedded' : 'custom',
    serverUrl: DEFAULT_SERVER_URL,
    databaseUrl: DEFAULT_DATABASE_URL,
    port: DEFAULT_PORT,
    window: null,
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const serverUrl = normalizeServerUrl(raw.serverUrl) || defaults.serverUrl
    const databaseUrl = normalizeDatabaseUrl(raw.databaseUrl) || defaults.databaseUrl
    const port = Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535 ? raw.port : defaults.port
    let mode = raw.mode === 'builtin' || raw.mode === 'external' ? raw.mode : 'external'
    if (mode === 'builtin' && !builtinAvailable()) mode = 'external'
    // Older config files (no "database" field) were set up with the user's own MySQL, so keep that.
    let database = raw.database === 'embedded' || raw.database === 'custom' ? raw.database : 'custom'
    if (database === 'embedded' && !embeddedDatabaseAvailable()) database = 'custom'
    return { mode, database, serverUrl, databaseUrl, port, window: raw.window && typeof raw.window === 'object' ? raw.window : null }
  } catch {
    return defaults
  }
}

function effectiveServerUrl() {
  return config.mode === 'builtin' ? `http://127.0.0.1:${BACKEND_PORT}` : config.serverUrl
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const tmp = configPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
    fs.renameSync(tmp, configPath)
  } catch (error) {
    console.error('Could not save config:', error.message)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAppUrl(url) {
  try {
    return new URL(url).origin === appOrigin
  } catch {
    return false
  }
}

function openExternalSafe(url) {
  try {
    const parsed = new URL(url)
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) shell.openExternal(parsed.toString())
  } catch {
    /* ignore malformed URLs */
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return true
}

/** Called by the local server when the system browser returns from Google OAuth. */
function handleExternalCallback(pathAndQuery) {
  if (!/^\/(google-auth|google-connected)(\?|$)/.test(pathAndQuery)) return false
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
  showMainWindow()
  mainWindow.loadURL(appOrigin + pathAndQuery).catch(() => undefined)
  return true
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function restoredBounds() {
  const saved = config.window
  const fallback = { width: 1280, height: 820 }
  if (!saved || ![saved.width, saved.height].every((n) => Number.isFinite(n) && n >= 400)) return fallback
  const bounds = { width: Math.round(saved.width), height: Math.round(saved.height) }
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return saved.x < a.x + a.width - 50 && saved.x + saved.width > a.x + 50 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 50
    })
    if (visible) {
      bounds.x = Math.round(saved.x)
      bounds.y = Math.round(saved.y)
    }
  }
  return bounds
}

function createMainWindow() {
  const bounds = restoredBounds()
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Cloudix',
    icon: ICON_PATH,
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = win
  if (config.window && config.window.maximized) win.maximize()

  win.once('ready-to-show', () => win.show())

  const wc = win.webContents

  // Anything that is not the app itself (Google sign-in, share links, docs...) opens in the real browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) openExternalSafe(url)
    return { action: 'deny' }
  })

  const guardNavigation = (event) => {
    const url = event.url
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternalSafe(url)
  }
  wc.on('will-navigate', guardNavigation)
  wc.on('will-redirect', guardNavigation)

  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = aborted (normal when we cancel a navigation)
    console.error(`Failed to load ${url}: ${description} (${code})`)
  })

  win.on('close', () => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const b = maximized ? win.getNormalBounds() : win.getBounds()
    config.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized }
    saveConfig()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.loadURL(appOrigin + '/')
  return win
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 540,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'Cloudix Server Settings',
    icon: ICON_PATH,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: Boolean(mainWindow && !mainWindow.isDestroyed()),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'settings-preload.js'),
    },
  })
  settingsWindow = win
  win.removeMenu()
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })
  // The settings page never navigates and never opens windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.loadFile(path.join(__dirname, 'settings.html'))
}

// ---------------------------------------------------------------------------
// Built-in backend
// ---------------------------------------------------------------------------

function showSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) return
  splashWindow = new BrowserWindow({
    width: 360,
    height: 200,
    frame: false,
    resizable: false,
    movable: true,
    show: true,
    alwaysOnTop: true,
    icon: ICON_PATH,
    backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const html =
    '<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif">' +
    '<div style="font-size:22px;font-weight:700">Cloudix</div><div style="margin-top:8px;font-size:13px;color:#94a3b8">Starting… the first start can take a minute</div></body>'
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

function hideSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  splashWindow = null
}

function stopBackend() {
  if (backendProcess) backendProcess.stop()
  backendProcess = null
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'backend.pid'), { force: true })
  } catch {
    /* ignore */
  }
}

/** Stops the bundled database cleanly (so no data is lost). */
async function stopDatabase() {
  const handle = databaseHandle
  databaseHandle = null
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'database.pid'), { force: true })
  } catch {
    /* ignore */
  }
  if (handle) await handle.stop().catch(() => handle.stopHard())
}

/** Starts (or restarts) the built-in server. Resolves { ok } or { ok:false, error }. */
async function startBuiltinBackend() {
  stopBackend()
  await stopDatabase()
  backendRunner.rotateLog(logPath)
  const secrets = backendRunner.loadOrCreateSecrets(path.join(app.getPath('userData'), 'secrets.json'))

  let databaseUrl = config.databaseUrl
  if (config.database === 'embedded') {
    const dbPidPath = path.join(app.getPath('userData'), 'database.pid')
    await dbRunner.killLeftoverDatabase(dbPidPath)
    const db = await dbRunner.prepareDatabase({
      mariadbDir: MARIADB_DIR,
      dataDir: path.join(app.getPath('userData'), 'mariadb-data'),
      rootPassword: secrets.DB_PASSWORD,
      dbName: 'cloudix',
      logPath: path.join(path.dirname(logPath), 'database.log'),
    })
    if (!db.ok) return { ok: false, error: db.error }
    databaseHandle = db
    try {
      fs.writeFileSync(dbPidPath, JSON.stringify({ pid: db.pid, port: db.port }))
    } catch {
      /* not critical */
    }
    databaseUrl = `mysql://root:${secrets.DB_PASSWORD}@127.0.0.1:${db.port}/cloudix`
  }

  const env = {
    DATABASE_URL: databaseUrl,
    FRONTEND_URL: appOrigin,
    JWT_ACCESS_SECRET: secrets.JWT_ACCESS_SECRET,
    TOKEN_ENCRYPTION_KEY: secrets.TOKEN_ENCRYPTION_KEY,
    BACKUP_DIR: path.join(app.getPath('userData'), 'backups'),
    ...(config.database === 'embedded' ? { MARIADB_BASE_DIR: MARIADB_DIR } : {}),
  }
  const pidPath = path.join(app.getPath('userData'), 'backend.pid')
  await backendRunner.killLeftoverBackend({ pidPath, port: BACKEND_PORT })
  const migrated = await backendRunner.runMigrations({ backendDir: BACKEND_DIR, env, logPath })
  if (!migrated.ok) return migrated
  const started = await backendRunner.startBackend({ backendDir: BACKEND_DIR, env, logPath, port: BACKEND_PORT })
  if (started.ok) {
    backendProcess = started
    try {
      fs.writeFileSync(pidPath, String(started.pid))
    } catch {
      /* not critical */
    }
  }
  return started
}

/** Keeps trying until the server is up or the user chooses to continue / open settings. */
async function ensureBackendRunning() {
  if (config.mode !== 'builtin') return
  for (;;) {
    const result = await startBuiltinBackend()
    if (result.ok || quitting) return
    hideSplash()
    const dbTail = config.database === 'embedded' ? backendRunner.readLogTail(path.join(path.dirname(logPath), 'database.log'), 700) : ''
    const tail = (dbTail && /database|files|password/i.test(result.error) ? dbTail : backendRunner.readLogTail(logPath, 900))
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Cloudix',
      message: "Cloudix's built-in server could not start",
      detail: `${result.error}${tail ? '\n\nLog:\n' + tail : ''}`,
      buttons: ['Server Settings…', 'Retry', 'Open Logs Folder', 'Continue Anyway'],
      defaultId: 1,
      cancelId: 3,
    })
    if (response === 0) {
      pendingSettingsAfterStart = true
      return
    }
    if (response === 2) {
      shell.openPath(path.dirname(logPath))
      continue
    }
    if (response === 3) return
    showSplash()
  }
}

// ---------------------------------------------------------------------------
// Backend reachability check
// ---------------------------------------------------------------------------

async function backendIsReachable() {
  try {
    const response = await fetch(effectiveServerUrl() + '/health', { signal: AbortSignal.timeout(5000) })
    return response.ok
  } catch {
    return false
  }
}

async function checkBackendAndWarn() {
  // Loop so "Retry" can be pressed as many times as needed.
  for (;;) {
    if (quitting || (await backendIsReachable())) return
    if (quitting) return
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const options = {
      type: 'warning',
      title: 'Cloudix',
      message: "Can't reach the Cloudix server",
      detail:
        `Tried: ${effectiveServerUrl()}/health\n\n` +
        'Make sure the Cloudix server (and its MySQL database) is running, or change it in Server Settings.',
      buttons: ['Server Settings…', 'Retry', 'Continue Anyway'],
      defaultId: 1,
      cancelId: 2,
    }
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    if (response === 0) {
      openSettingsWindow()
      return
    }
    if (response === 2) return
  }
}

// ---------------------------------------------------------------------------
// IPC for the settings window
// ---------------------------------------------------------------------------

function registerIpc() {
  const fromSettings = (event) => settingsWindow && !settingsWindow.isDestroyed() && event.sender === settingsWindow.webContents

  ipcMain.handle('settings:get', (event) => {
    if (!fromSettings(event)) return null
    return {
      mode: config.mode,
      database: config.database,
      serverUrl: config.serverUrl,
      databaseUrl: config.databaseUrl,
      builtinAvailable: builtinAvailable(),
      embeddedAvailable: embeddedDatabaseAvailable(),
      appOrigin,
    }
  })

  ipcMain.handle('settings:save', async (event, input) => {
    if (!fromSettings(event)) return { ok: false, error: 'Not allowed.' }
    const data = input && typeof input === 'object' ? input : {}
    const mode = data.mode === 'builtin' && builtinAvailable() ? 'builtin' : 'external'

    const next = { mode, database: config.database, serverUrl: config.serverUrl, databaseUrl: config.databaseUrl }
    if (mode === 'builtin') {
      next.database = data.database === 'embedded' && embeddedDatabaseAvailable() ? 'embedded' : 'custom'
      if (next.database === 'custom') {
        const db = normalizeDatabaseUrl(data.databaseUrl)
        if (!db) return { ok: false, error: 'Enter a MySQL address like mysql://root:password@localhost:3306/cloudix' }
        next.databaseUrl = db
      }
    } else {
      const url = normalizeServerUrl(typeof data.serverUrl === 'string' ? data.serverUrl : '')
      if (!url) return { ok: false, error: 'Enter a valid http:// or https:// address, for example http://localhost:4000' }
      next.serverUrl = url
    }

    const needsRestart = mode === 'builtin' && (!backendProcess || config.database !== next.database || config.databaseUrl !== next.databaseUrl)
    const switchedAway = config.mode === 'builtin' && mode !== 'builtin'
    Object.assign(config, next)
    saveConfig()
    settingsWindow.close()

    if (switchedAway) {
      stopBackend()
      await stopDatabase()
    }
    const apply = async () => {
      if (needsRestart) {
        showSplash()
        await ensureBackendRunning()
        hideSplash()
        if (pendingSettingsAfterStart) {
          pendingSettingsAfterStart = false
          openSettingsWindow()
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.loadURL(appOrigin + '/').catch(() => undefined)
      if (!needsRestart) await checkBackendAndWarn()
    }
    apply().catch(() => undefined)
    return { ok: true }
  })

  ipcMain.handle('settings:cancel', (event) => {
    if (fromSettings(event)) settingsWindow.close()
  })
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Server Settings…', accelerator: 'CmdOrCtrl+,', click: openSettingsWindow },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Show Settings Folder',
          click: () => shell.showItemInFolder(configPath),
        },
        {
          label: 'Open Cloudix in Browser',
          click: () => openExternalSafe(appOrigin),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!showMainWindow() && localServer) createMainWindow()
  })

  app.whenReady().then(async () => {
    configPath = path.join(app.getPath('userData'), 'config.json')
    const firstRun = !fs.existsSync(configPath)
    config = loadConfig()
    appOrigin = `http://127.0.0.1:${config.port}`
    desktopToken = crypto.randomBytes(24).toString('hex')

    // Mark every request made by our own windows so the local server can tell them apart from the system browser.
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${appOrigin}/*`] }, (details, callback) => {
      details.requestHeaders[DESKTOP_HEADER] = desktopToken
      callback({ requestHeaders: details.requestHeaders })
    })

    localServer = createLocalServer({
      distDir: DIST_DIR,
      getBackendUrl: effectiveServerUrl,
      desktopHeaderName: DESKTOP_HEADER,
      desktopToken,
      onExternalCallback: handleExternalCallback,
    })

    try {
      await localServer.listen(config.port)
    } catch (error) {
      dialog.showErrorBox(
        'Cloudix could not start',
        error && error.code === 'EADDRINUSE'
          ? `Port ${config.port} is already in use by another program.\n\nClose that program, or change "port" in:\n${configPath}\n(then update FRONTEND_URL on your Cloudix server to match).`
          : `The local app server failed to start:\n${error && error.message}`,
      )
      app.exit(1)
      return
    }

    logPath = path.join(app.getPath('userData'), 'logs', 'backend.log')
    registerIpc()
    buildMenu()

    if (firstRun) saveConfig()
    // With the bundled database nothing needs to be asked. With the user's own MySQL, ask for its address first (Server Settings opens below).
    const autoStart = config.mode === 'builtin' && (!firstRun || config.database === 'embedded')
    if (autoStart) {
      showSplash()
      await ensureBackendRunning()
      hideSplash()
    }
    createMainWindow()

    if ((firstRun && !autoStart) || pendingSettingsAfterStart) {
      pendingSettingsAfterStart = false
      mainWindow.once('ready-to-show', openSettingsWindow)
    } else if (config.mode !== 'builtin') {
      checkBackendAndWarn().catch(() => undefined)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    quitting = true
    if (shutdownDone || (!backendProcess && !databaseHandle)) return
    // Give the database time to shut down cleanly before the app exits.
    event.preventDefault()
    stopBackend()
    stopDatabase()
      .catch(() => undefined)
      .finally(() => {
        shutdownDone = true
        app.quit()
      })
  })

  app.on('will-quit', () => {
    if (localServer) localServer.close()
  })
}
