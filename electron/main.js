const { app, BrowserWindow, ipcMain, Notification, shell, dialog, Menu, MenuItem } = require('electron')
const path = require('path')
const fs = require('fs')

// Disable sandbox so preload works
app.commandLine.appendSwitch('no-sandbox')

// ── GPU & Rendering Performance Flags ────────────────────────────────────────
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('use-gl', 'desktop')
app.commandLine.appendSwitch('enable-hardware-overlays', 'single-fullscreen,single-on-top,underlay')
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoEncoder,CanvasOopRasterization')
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder')
app.commandLine.appendSwitch('shared-array-buffer')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

console.log('[Main] Starting vLAN-CameraHIK...')

const isDev = !app.isPackaged

let mainWindow = null
let hikService = null
let nativeEngineProcess = null

function startNativeEngine() {
  const { spawn, execSync } = require('child_process')
  const fs = require('fs')
  
  // Clean up any stale instances before starting to free up the port
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM native-engine.exe', { stdio: 'ignore' })
    } else {
      execSync('killall native-engine', { stdio: 'ignore' })
    }
    console.log('[Main] Killed stale native-engine instances.')
  } catch (e) {
    // No stale instances running, which is fine
  }

  const devPath = path.join(__dirname, '..', 'native-engine', 'target', 'release', 'native-engine.exe')
  const prodPath = path.join(process.resourcesPath, 'native-engine.exe')
  const binPath = fs.existsSync(devPath) ? devPath : (fs.existsSync(prodPath) ? prodPath : 'native-engine.exe')
  const binDir = path.dirname(binPath)
  
  console.log('[Main] Launching Rust Native Engine from:', binPath)
  
  try {
    nativeEngineProcess = spawn(binPath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: binDir
    })
    
    nativeEngineProcess.stdout.on('data', (data) => {
      console.log('[Rust Engine]', data.toString().trim())
    })
    
    nativeEngineProcess.stderr.on('data', (data) => {
      console.error('[Rust Engine Error]', data.toString().trim())
    })
    
    nativeEngineProcess.on('close', (code) => {
      console.log(`[Rust Engine] exited with code ${code}`)
      nativeEngineProcess = null
    })
  } catch (err) {
    console.error('[Main] Failed to spawn Rust Native Engine:', err.message)
  }
}

function stopNativeEngine() {
  if (nativeEngineProcess) {
    console.log('[Main] Stopping Rust Native Engine...')
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process')
        execSync(`taskkill /pid ${nativeEngineProcess.pid} /T /F`, { stdio: 'ignore' })
      } else {
        nativeEngineProcess.kill('SIGTERM')
      }
    } catch (e) {
      // Process may already be dead
    }
    nativeEngineProcess = null
  }
}

// ── Simple JSON store with secure encryption ─────────────────────────────────
const crypto = require('crypto')
const ENCRYPTION_KEY = crypto.createHash('sha256').update('ivms-pro-secure-salt-key-2026').digest() // 32 bytes

function encrypt(text) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

function decrypt(text) {
  try {
    const parts = text.split(':')
    const iv = Buffer.from(parts.shift(), 'hex')
    const encryptedText = Buffer.from(parts.join(':'), 'hex')
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv)
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch (e) {
    console.error('[Crypto] Decryption failed:', e.message)
    return null
  }
}

const storePath = path.join(app.getPath('userData'), 'config.json')
const store = {
  _data: {},
  _loaded: false,
  _init() {
    if (this._loaded) return
    this._loaded = true
    try {
      if (fs.existsSync(storePath)) {
        this._data = JSON.parse(fs.readFileSync(storePath, 'utf8'))
        
        // Decrypt devices automatically
        if (this._data.devicesEncrypted) {
          const decrypted = decrypt(this._data.devicesEncrypted)
          if (decrypted) {
            this._data.devices = JSON.parse(decrypted)
          }
          delete this._data.devicesEncrypted
        }

        // Migrate devices schema
        if (this._data.devices && Array.isArray(this._data.devices)) {
          let dirty = false
          this._data.devices = this._data.devices.map(dev => {
            const vendor = dev.vendor || 'hikvision'
            const streamEngine = dev.streamEngine || 'hcnet'
            const sdkPort = dev.sdkPort !== undefined ? dev.sdkPort : (dev.port !== undefined ? dev.port : 8000)
            const rtspPort = dev.rtspPort !== undefined ? dev.rtspPort : 554

            if (dev.vendor !== vendor || dev.streamEngine !== streamEngine || dev.sdkPort !== sdkPort || dev.rtspPort !== rtspPort) {
              dirty = true
            }

            return {
              ...dev,
              vendor,
              streamEngine,
              sdkPort,
              rtspPort
            }
          })
          if (dirty) {
            this._save()
          }
        }
        
        // Auto-migrate admin password to secure SHA-256 hash
        if (this._data.appCredentials && this._data.appCredentials.password) {
          const plainPass = this._data.appCredentials.password
          this._data.appCredentials.passwordHash = crypto.createHash('sha256').update(plainPass).digest('hex')
          delete this._data.appCredentials.password
          this._save()
        }
      }
    } catch (e) { console.error('[Store] Load error:', e.message) }
  },
  _save() {
    try {
      const dataToWrite = JSON.parse(JSON.stringify(this._data))
      
      // Encrypt devices automatically
      if (dataToWrite.devices) {
        dataToWrite.devicesEncrypted = encrypt(JSON.stringify(dataToWrite.devices))
        delete dataToWrite.devices
      }
      
      fs.writeFileSync(storePath, JSON.stringify(dataToWrite, null, 2), 'utf8')
    }
    catch (e) { console.error('[Store] Save error:', e.message) }
  },
  get(key) { this._init(); return this._data[key] },
  set(key, value) { this._init(); this._data[key] = value; this._save(); return true },
  delete(key) { this._init(); delete this._data[key]; this._save(); return true }
}

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js')
  console.log('[Main] Preload path:', preloadPath)
  console.log('[Main] Preload exists:', fs.existsSync(preloadPath))

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    backgroundColor: '#0A0E1A',
    icon: path.join(__dirname, '../resources/icon.png'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false,
    }
  })

  // Performance: lock frame rate to 60fps and prevent display sleep
  mainWindow.webContents.setFrameRate(60)
  const { powerSaveBlocker } = require('electron')
  const blockerId = powerSaveBlocker.start('prevent-display-sleep')
  mainWindow.on('closed', () => {
    powerSaveBlocker.stop(blockerId)
  })

  // Handle Vite HMR reloads — re-check preload after navigation
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page loaded, URL:', mainWindow.webContents.getURL())
  })

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Log] ${message} (${sourceId}:${line})`)
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    // Open DevTools detached so we can see renderer console
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

function createPopoutWindow(panelId) {
  const preloadPath = path.join(__dirname, 'preload.js')
  let popoutWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: '#000000',
    title: 'vLAN-CameraHIK Panel',
    icon: path.join(__dirname, '../resources/icon.png'),
    frame: false, // Frameless window
    fullscreen: false, // Windowed by default, can be toggled by the user
    webPreferences: {
      preload: preloadPath,
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      webSecurity: false
    }
  })

  popoutWindow.setMenuBarVisibility(false)

  // Configure relaunch command for Windows taskbar pinning
  if (process.platform === 'win32') {
    let panelName = 'Panel'
    try {
      const savedPanels = store.get('panels') || []
      const p = savedPanels.find(x => x.id === panelId)
      if (p) panelName = p.name
    } catch (e) {}

    popoutWindow.setAppDetails({
      appId: 'com.vlancamerahik.popout.panel.' + panelId,
      relaunchCommand: `"${process.execPath}" --popout=${panelId}`,
      relaunchDisplayName: `vLAN-CameraHIK - ${panelName}`
    })
  }

  if (isDev) {
    popoutWindow.loadURL(`http://localhost:5173/?popout=${panelId}`)
  } else {
    popoutWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { popout: panelId } })
  }

  popoutWindow.on('closed', () => {
    // Let the window be destroyed normally
  })
}

app.whenReady().then(async () => {
  console.log('[Main] App ready, Electron version:', process.versions.electron)

  // Auto-create default snapshot and recording folders upon startup/installation
  try {
    const snapshotPath = store.get('snapshotPath') || path.join(app.getPath('pictures'), 'vLAN-CameraHIK', 'Snapshots')
    const recordingPath = store.get('recordingPath') || path.join(app.getPath('videos'), 'vLAN-CameraHIK', 'Recordings')
    if (!fs.existsSync(snapshotPath)) {
      fs.mkdirSync(snapshotPath, { recursive: true })
      console.log('[Main] Auto-created snapshot folder:', snapshotPath)
    }
    if (!fs.existsSync(recordingPath)) {
      fs.mkdirSync(recordingPath, { recursive: true })
      console.log('[Main] Auto-created recording folder:', recordingPath)
    }
  } catch (e) {
    console.error('[Main] Failed to auto-create default folders:', e.message)
  }

  // Migrate old singular appSession to plural appSessions map
  try {
    const oldSession = store.get('appSession')
    if (oldSession && oldSession.token && oldSession.fingerprint) {
      const sessions = store.get('appSessions') || {}
      sessions[oldSession.fingerprint] = oldSession.token
      store.set('appSessions', sessions)
      store.delete('appSession')
      console.log('[Main] Migrated old appSession to appSessions map.')
    }
  } catch (e) {
    console.error('[Main] Session migration failed:', e.message)
  }

  try {
    const { HikService } = require('./services/hikService')
    hikService = new HikService()
    console.log('[Main] HikService loaded OK')
  } catch (e) {
    console.error('[Main] HikService load FAILED:', e)
  }

  // Load and initialize native HCNetSDK engine service
  try {
    const hcnetService = require('./services/hcnetService')
    if (hcnetService.isAvailable()) {
      hcnetService.init()
    } else {
      console.warn('[Main] Native HCNetSDK service not available (addon not built).')
    }
  } catch (e) {
    console.error('[Main] Native HCNetSDK service init FAILED:', e)
  }

  // Parse command line arguments to see if we should start in popout mode
  let popoutPanelId = null
  for (const arg of process.argv) {
    if (arg.startsWith('--popout=')) {
      popoutPanelId = arg.split('=')[1]
      break
    }
  }

  startNativeEngine()

  if (popoutPanelId) {
    createPopoutWindow(popoutPanelId)
  } else {
    createWindow()
  }
})

app.on('window-all-closed', async () => {
  stopNativeEngine()
  try {
    const hcnetService = require('./services/hcnetService')
    hcnetService.cleanup()
  } catch (e) {}
  if (process.platform !== 'darwin') app.quit()
})

// ─── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  win?.minimize()
})
ipcMain.on('window:maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win?.isMaximized()) win.restore()
  else win?.maximize()
})
ipcMain.on('window:close', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win === mainWindow) {
    stopNativeEngine()
    try {
      const hcnetService = require('./services/hcnetService')
      hcnetService.cleanup()
    } catch (e) {}
    app.quit()
  } else {
    win?.close()
  }
})
ipcMain.on('window:set-fullscreen', (event, flag) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    win.setFullScreen(flag)
  }
})

ipcMain.on('window:open-popout', (event, panelId) => {
  const { spawn } = require('child_process')
  const args = [`--popout=${panelId}`]

  if (isDev) {
    const mainScriptPath = path.join(__dirname, 'main.js')
    spawn(process.execPath, [mainScriptPath, ...args], {
      detached: true,
      stdio: 'ignore'
    }).unref()
  } else {
    spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore'
    }).unref()
  }
})

// ─── Device / ISAPI ───────────────────────────────────────────────────────────
ipcMain.handle('hik:connect', async (_e, device) => {
  if (!hikService) throw new Error('HikService not available')
  console.log('[IPC] hik:connect called for', device.ip)
  return await hikService.connect(device)
})

ipcMain.handle('hik:getDeviceInfo', async (_e, deviceId) => {
  if (!hikService) throw new Error('HikService not available')
  return hikService.getDeviceInfo(deviceId)
})

ipcMain.handle('hik:getChannels', async (_e, deviceId) => {
  if (!hikService) throw new Error('HikService not available')
  console.log('[IPC] hik:getChannels called for', deviceId)
  return await hikService.getChannels(deviceId)
})

ipcMain.handle('hik:getIPChannels', async (_e, deviceId) => {
  if (!hikService) throw new Error('HikService not available')
  return await hikService.getIPChannels(deviceId)
})

ipcMain.handle('hik:snapshot', async (_e, deviceId, channelId) => {
  if (!hikService) throw new Error('HikService not available')
  return hikService.snapshot(deviceId, channelId)
})

// ─── File System Operations ──────────────────────────────────────────────────
ipcMain.handle('snapshot:save', async (_e, deviceId, channelId) => {
  if (!hikService) throw new Error('HikService not available')
  const snapshotDir = store.get('snapshotPath') || path.join(app.getPath('pictures'), 'vLAN-CameraHIK', 'Snapshots')
  const filename = `snapshot_ch${channelId}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
  const filePath = path.join(snapshotDir, filename)
  return hikService.snapshotToFile(deviceId, channelId, filePath)
})

ipcMain.handle('recording:download', async (_e, deviceId, channelId, startTime, endTime) => {
  if (!hikService) throw new Error('HikService not available')
  const dev = hikService._getDevice(deviceId)
  if (!dev) throw new Error('Device not found')
  const recordDir = store.get('recordingPath') || path.join(app.getPath('videos'), 'vLAN-CameraHIK', 'Recordings')
  fs.mkdirSync(recordDir, { recursive: true })
  const filename = `recording_ch${channelId}_${new Date(startTime).toISOString().replace(/[:.]/g, '-')}.mp4`
  const filePath = path.join(recordDir, filename)

  // Build RTSP playback URL
  const user = encodeURIComponent(dev.username)
  const pass = encodeURIComponent(dev.password)
  const startF = startTime.replace(/[-:]/g, '').replace('T', 'T').replace('Z', 'Z')
  const endF = endTime.replace(/[-:]/g, '').replace('T', 'T').replace('Z', 'Z')
  const rtspUrl = `rtsp://${user}:${pass}@${dev.ip}:${dev.rtspPort || 554}/Streaming/tracks/${channelId}01?starttime=${startF}&endtime=${endF}`

  // Use ffmpeg to record the stream to file
  const { execFile } = require('child_process')
  return new Promise((resolve, reject) => {
    const candidates = [
      path.join(process.resourcesPath, 'ffmpeg.exe'),
      path.dirname(process.execPath) + '/ffmpeg.exe'
    ]
    let ffmpegBin = 'ffmpeg'
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        ffmpegBin = c
        break
      }
    }

    const duration = Math.min(Math.ceil((new Date(endTime) - new Date(startTime)) / 1000) + 5, 7200)
    const args = [
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-t', String(duration),
      filePath
    ]

    console.log('[Recording] Downloading:', filename, 'duration:', duration, 's')
    const proc = execFile(ffmpegBin, args, { timeout: 7200000 }, (err) => {
      if (err) {
        console.error('[Recording] FFmpeg error:', err.message)
        reject(new Error(`FFmpeg failed: ${err.message}`))
      } else {
        console.log('[Recording] Saved:', filePath)
        resolve({ success: true, filePath, filename })
      }
    })
    proc.stderr?.on('data', (d) => console.log('[FFmpeg]', d.toString().trim()))
  })
})

ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Chọn thư mục lưu trữ'
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle('shell:openPath', async (_e, folderPath) => {
  if (folderPath) {
    try {
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true })
      }
      await shell.openPath(folderPath)
    } catch (err) {
      console.error('[shell:openPath] Error opening path:', err)
    }
  }
})

ipcMain.handle('shell:showInFolder', async (_e, filePath) => {
  shell.showItemInFolder(filePath)
})

ipcMain.handle('app:getDefaultPaths', async () => {
  return {
    snapshotPath: store.get('snapshotPath') || path.join(app.getPath('pictures'), 'vLAN-CameraHIK', 'Snapshots'),
    recordingPath: store.get('recordingPath') || path.join(app.getPath('videos'), 'vLAN-CameraHIK', 'Recordings')
  }
})

ipcMain.handle('hik:ptzControl', async (_e, deviceId, channelId, pan, tilt, zoom) => {
  if (!hikService) throw new Error('HikService not available')
  return hikService.ptzControl(deviceId, channelId, pan, tilt, zoom)
})

ipcMain.handle('hik:ptzStop', async (_e, deviceId, channelId) => {
  if (!hikService) throw new Error('HikService not available')
  return hikService.ptzStop(deviceId, channelId)
})

ipcMain.handle('hik:searchRecordings', async (_e, deviceId, trackId, startTime, endTime) => {
  if (!hikService) throw new Error('HikService not available')
  return hikService.searchRecordings(deviceId, trackId, startTime, endTime)
})

ipcMain.handle('hik:startAlertStream', (_e, deviceId) => {
  if (!hikService) throw new Error('HikService not available')
  hikService.startAlertStream(deviceId, (alert) => {
    // Filter out all "video loss" / "videoloss" notifications
    const typeLower = (alert.eventType || '').toLowerCase()
    const descLower = (alert.eventDescription || '').toLowerCase()
    if (
      typeLower.includes('videoloss') || 
      typeLower.includes('video loss') || 
      descLower.includes('videoloss') || 
      descLower.includes('video loss')
    ) {
      return // Completely ignore and skip
    }

    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) win.webContents.send('hik:alert', alert)
    })
    if (Notification.isSupported()) {
      new Notification({
        title: `⚠️ Cảnh báo — ${alert.channelID}`,
        body: `${alert.eventDescription || alert.eventType}`
      }).show()
    }
  })
})

ipcMain.handle('hik:stopAlertStream', (_e, deviceId) => {
  if (!hikService) throw new Error('HikService not available')
  hikService.stopAlertStream(deviceId)
})

ipcMain.handle('hik:disconnect', async (_e, deviceId) => {
  if (!hikService) throw new Error('HikService not available')
  console.log('[IPC] hik:disconnect called for', deviceId)
  hikService.stopAlertStream(deviceId)
  hikService.devices.delete(deviceId)
  return true
})

// ─── System Info ────────────────────────────────────────────────────────────
ipcMain.handle('get-system-info', () => {
  const os = require('os')
  return {
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    platform: process.platform,
    arch: process.arch,
  }
})

// ─── Auth ─────────────────────────────────────────────────────────────────────
ipcMain.handle('auth:register', async (_e, username, password, fingerprint) => {
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex')
  store.set('appCredentials', { username, passwordHash })
  const token = crypto.randomBytes(32).toString('hex')
  const sessions = store.get('appSessions') || {}
  sessions[fingerprint] = token
  store.set('appSessions', sessions)
  return { success: true, token }
})

ipcMain.handle('auth:login', async (_e, username, password, fingerprint) => {
  const creds = store.get('appCredentials')
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex')
  if (!creds || creds.username !== username || (creds.passwordHash ? creds.passwordHash !== passwordHash : creds.password !== password)) {
    return { success: false, error: 'Tài khoản hoặc mật khẩu không chính xác!' }
  }
  const token = crypto.randomBytes(32).toString('hex')
  const sessions = store.get('appSessions') || {}
  sessions[fingerprint] = token
  store.set('appSessions', sessions)
  return { success: true, token }
})

ipcMain.handle('auth:validate', async (_e, token, fingerprint) => {
  const sessions = store.get('appSessions')
  if (!sessions || sessions[fingerprint] !== token) {
    return false
  }
  return true
})

ipcMain.handle('auth:logout', async (_e, fingerprint) => {
  const sessions = store.get('appSessions') || {}
  delete sessions[fingerprint]
  store.set('appSessions', sessions)
  return true
})

ipcMain.handle('auth:isConfigured', async () => {
  const creds = store.get('appCredentials')
  return !!(creds && creds.username && (creds.password || creds.passwordHash))
})

// ─── Store ────────────────────────────────────────────────────────────────────
ipcMain.handle('store:get', (_e, key) => {
  if (key === 'appCredentials' || key === 'appSession' || key === 'appSessions') return null
  return store.get(key)
})
ipcMain.handle('store:set', (_e, key, value) => {
  if (key === 'appCredentials' || key === 'appSession' || key === 'appSessions') return false
  return store.set(key, value)
})
ipcMain.handle('store:delete', (_e, key) => {
  if (key === 'appCredentials' || key === 'appSession' || key === 'appSessions') return false
  return store.delete(key)
})

// ─── Playback & NVR Search ───────────────────────────────────────────────────
ipcMain.handle('search-nvr-recordings', async (event, nvrIp, channel, startTime, endTime) => {
  const DigestClientModule = await import('digest-fetch')
  const DigestClient = DigestClientModule.default
  const { XMLParser } = require('fast-xml-parser')

  // Get credentials from config
  const devices = store.get('devices') || []
  const cleanIp = (ipStr) => ipStr ? ipStr.split(':')[0] : ''
  const targetIp = cleanIp(nvrIp)
  const nvr = devices.find((d) => cleanIp(d.ip) === targetIp || d.id === nvrIp)
  if (!nvr) {
    console.error(`[search-nvr-recordings] NVR with IP ${nvrIp} not found in devices`)
    return []
  }

  const nvrIpClean = cleanIp(nvr.ip)
  const nvrHost = nvr.port && nvr.port !== 80 ? `${nvrIpClean}:${nvr.port}` : nvrIpClean
  const client = new DigestClient(nvr.username, nvr.password)

  const startDate = new Date(startTime)
  const endDate = new Date(endTime)
  const searchId = crypto.randomUUID()

  const searchXml = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
  <searchID>${searchId}</searchID>
  <trackList>
    <trackID>${channel}01</trackID>
  </trackList>
  <timeSpanList>
    <timeSpan>
      <startTime>${startDate.toISOString().replace(/\.\d{3}Z$/, 'Z')}</startTime>
      <endTime>${endDate.toISOString().replace(/\.\d{3}Z$/, 'Z')}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>200</maxResults>
  <searchResultPosition>0</searchResultPosition>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>`

  try {
    const response = await client.fetch(`http://${nvrHost}/ISAPI/ContentMgmt/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: searchXml,
    })

    const xml = await response.text()

    // Parse XML in main process
    const parser = new XMLParser()
    const result = parser.parse(xml)

    const matches = result?.CMSearchResult?.matchList?.searchMatchItem || []
    const items = Array.isArray(matches) ? matches : [matches]

    return items
      .filter((item) => item?.timeSpan)
      .map((item) => ({
        startTime: item.timeSpan.startTime,
        endTime: item.timeSpan.endTime,
        sourceUrl: item.mediaSegmentDescriptor?.playbackURI || null,
      }))
  } catch (err) {
    console.error(`ISAPI search failed for ${nvrIp}:`, err)
    return []
  }
})

// Download video clip from NVR
ipcMain.handle('download-file', async (event, options) => {
  const { nvrIp, httpPort, channel, startTimeStr, endTimeStr, username, password, playbackURI } = options || {}
  const DigestClientModule = await import('digest-fetch')
  const DigestClient = DigestClientModule.default
  const client = new DigestClient(username, password)

  // Ask user where to save
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save Video Clip',
    defaultPath: `clip_${Date.now()}.mp4`,
    filters: [{ name: 'Video', extensions: ['mp4'] }],
  })

  if (!filePath) return { success: false, reason: 'cancelled' }

  const nvrHost = httpPort && httpPort !== 80 ? `${nvrIp}:${httpPort}` : nvrIp

  // Dùng playbackURI chính xác từ API search để tránh lỗi parameter error (statusCode 6)
  let targetPlaybackUri = playbackURI;
  if (!targetPlaybackUri) {
    targetPlaybackUri = `rtsp://${nvrIp}/Streaming/tracks/${channel}01?starttime=${startTimeStr}&endtime=${endTimeStr}`;
  }

  // Escape '&' to '&amp;' for XML validation
  const escapedPlaybackUri = targetPlaybackUri.replace(/&/g, '&amp;');

  const downloadXml = `<?xml version="1.0" encoding="UTF-8"?>
<downloadRequest version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <playbackURI>${escapedPlaybackUri}</playbackURI>
</downloadRequest>`

  const downloadUrl = `http://${nvrHost}/ISAPI/ContentMgmt/download`;
  console.log('[download-file] Target URL (POST):', downloadUrl)
  console.log('[download-file] XML Body:', downloadXml)

  const tempFilePath = filePath + '.tmp';

  try {
    const response = await client.fetch(downloadUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/xml',
        'Connection': 'close' // Cô lập kết nối TCP để tránh lỗi bộ đệm Keep-Alive của Hikvision NVR
      },
      body: downloadXml
    })
    
    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${response.statusText || ''}. ${errText.slice(0, 200)}`)
    }

    // 1. Tải file stream thô về file tạm có báo cáo tiến độ
    const contentLength = parseInt(response.headers.get('content-length'), 10) || 0;
    const fileStream = fs.createWriteStream(tempFilePath);
    const reader = response.body.getReader();
    
    let downloadedBytes = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      fileStream.write(Buffer.from(value));
      downloadedBytes += value.length;
      
      if (contentLength > 0) {
        const percent = (downloadedBytes / contentLength) * 100;
        event.sender.send('download-progress', { status: 'downloading', percent });
      }
    }
    
    fileStream.end();
    
    // Đợi đóng stream hoàn toàn
    await new Promise((resolve) => fileStream.on('close', resolve));

    // 2. Chuyển đổi file PS thô của Hikvision sang định dạng MP4 tiêu chuẩn bằng FFmpeg
    event.sender.send('download-progress', { status: 'converting', percent: 98 });
    console.log('[download-file] Converting Hikvision raw PS format to standard MP4 with FFmpeg...');

    const { exec } = require('child_process');
    // Chạy ffmpeg remux chuẩn hóa file video
    // -c:v copy để không tốn CPU transcode hình, chỉ sửa header container và convert âm thanh sang aac
    const ffmpegCmd = `ffmpeg -err_detect ignore_err -y -i "${tempFilePath}" -c:v copy -c:a aac -movflags +faststart "${filePath}"`;
    
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
          console.error('[download-file] FFmpeg error:', stderr);
          // Fallback: Nếu FFmpeg lỗi, copy file thô ra file thật để tránh mất video
          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            fs.renameSync(tempFilePath, filePath);
            resolve();
          } catch (e) {
            reject(new Error(`FFmpeg failed: ${error.message}`));
          }
        } else {
          console.log('[download-file] FFmpeg conversion completed successfully!');
          // Xóa file tạm
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          resolve();
        }
      });
    });

    event.sender.send('download-progress', { status: 'completed', percent: 100 });
    return { success: true, path: filePath }
  } catch (err) {
    console.error('Download failed:', err)
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
    return { success: false, reason: err.message }
  }
})

// ─── HCNetSDK Native Engine IPC Handlers ─────────────────────────────────────
const hcnetService = require('./services/hcnetService')

ipcMain.handle('hcnet:isAvailable', () => {
  return hcnetService.isAvailable()
})

ipcMain.handle('hcnet:getAddonError', () => {
  return hcnetService.getAddonError()
})

ipcMain.handle('hcnet:testConnection', async (_e, ip, port, username, password) => {
  try {
    const tempId = `test_${Date.now()}`
    const session = hcnetService.login(tempId, ip, port, username, password)
    if (session.userId >= 0) {
      hcnetService.logout(tempId)
      return { success: true, sdkChannels: session.sdkChannels }
    }
    return { success: false, error: 'Login failed with invalid User ID' }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('hcnet:startPlay', async (event, deviceId, channelId, streamType, x, y, w, h, enableSmart, linkModeOverride, bufNumOverride, bitrateLimitKBps, initialDecodeFrameType) => {
  const devices = store.get('devices') || []
  const dev = devices.find(d => d.id === deviceId)
  if (!dev) throw new Error('Device not found')

  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('Window not found')
  const parentHwnd = win.getNativeWindowHandle()

  // Ưu tiên cấu hình riêng của Panel truyền xuống, sau đó đến cấu hình thiết bị, cuối cùng là cài đặt toàn cục
  const linkMode = Number(linkModeOverride ?? dev.linkMode ?? store.get('liveLinkMode') ?? 0)
  const bufNum = Number(bufNumOverride ?? store.get('liveBufferFrames') ?? 15)

  return hcnetService.startPlay(
    deviceId,
    channelId,
    streamType,
    parentHwnd,
    x, y, w, h,
    dev.ip,
    dev.sdkPort || 8000,
    dev.username,
    dev.password,
    dev.channels || [],
    enableSmart,
    linkMode,
    bufNum,
    bitrateLimitKBps,
    initialDecodeFrameType
  )
})

ipcMain.handle('hcnet:stopPlay', async (_e, streamKey) => {
  return hcnetService.stopPlay(streamKey)
})

ipcMain.handle('hcnet:moveWindow', async (_e, childHwnd, x, y, w, h) => {
  return hcnetService.moveWindow(childHwnd, x, y, w, h)
})

ipcMain.handle('hcnet:startPlayback', async (event, deviceId, channelId, startTimeStr, endTimeStr, x, y, w, h) => {
  const devices = store.get('devices') || []
  const dev = devices.find(d => d.id === deviceId)
  if (!dev) throw new Error('Device not found')

  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('Window not found')
  const parentHwnd = win.getNativeWindowHandle()

  return hcnetService.startPlayback(
    deviceId,
    channelId,
    startTimeStr,
    endTimeStr,
    parentHwnd,
    x, y, w, h,
    dev.ip,
    dev.sdkPort || 8000,
    dev.username,
    dev.password,
    dev.channels || []
  )
})

ipcMain.handle('hcnet:stopPlayback', async (_e, playbackKey) => {
  return hcnetService.stopPlayback(playbackKey)
})

ipcMain.handle('show-camera-context-menu', async (event, options = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null

  const { isMuted, enableSmart, resolvedQuality, language } = options || {}

  const t = language === 'vi' ? {
    snapshot: '📸 Chụp ảnh nhanh',
    ptz: '🕹️ Điều khiển PTZ',
    playback: '🎥 Xem lại (Playback)',
    reload: '🔄 Tải lại camera (Reload)',
    fullscreen: '🔍 Phóng to / Thu nhỏ ô video',
    switchToSD: '📺 Chuyển sang chất lượng SD',
    switchToHD: '📺 Chuyển sang chất lượng HD',
    unmute: '🔊 Bật âm thanh',
    mute: '🔇 Tắt âm thanh',
    disableSmart: '⬜ Tắt Smart Rules (VCA)',
    enableSmart: '🟢 Bật Smart Rules (VCA)',
    remove: '✕ Gỡ camera khỏi ô này'
  } : {
    snapshot: '📸 Snapshot',
    ptz: '🕹️ PTZ Control',
    playback: '🎥 Playback',
    reload: '🔄 Reload Camera',
    fullscreen: '🔍 Toggle Fullscreen',
    switchToSD: '📺 Switch to SD Quality',
    switchToHD: '📺 Switch to HD Quality',
    unmute: '🔊 Unmute Audio',
    mute: '🔇 Mute Audio',
    disableSmart: '⬜ Disable Smart Rules (VCA)',
    enableSmart: '🟢 Enable Smart Rules (VCA)',
    remove: '✕ Remove Camera from Cell'
  }

  return new Promise((resolve) => {
    const menu = new Menu()
    menu.append(new MenuItem({
      label: t.snapshot,
      click: () => resolve('snapshot')
    }))
    menu.append(new MenuItem({
      label: t.ptz,
      click: () => resolve('ptz')
    }))
    menu.append(new MenuItem({
      label: t.playback,
      click: () => resolve('playback')
    }))
    menu.append(new MenuItem({
      label: t.reload,
      click: () => resolve('reload')
    }))
    menu.append(new MenuItem({
      label: t.fullscreen,
      click: () => resolve('toggleFullscreen')
    }))
    menu.append(new MenuItem({
      type: 'separator'
    }))
    menu.append(new MenuItem({
      label: resolvedQuality === 'HD' ? t.switchToSD : t.switchToHD,
      click: () => resolve(resolvedQuality === 'HD' ? 'switchToSD' : 'switchToHD')
    }))
    menu.append(new MenuItem({
      label: isMuted ? t.unmute : t.mute,
      click: () => resolve(isMuted ? 'unmute' : 'mute')
    }))
    menu.append(new MenuItem({
      label: enableSmart ? t.disableSmart : t.enableSmart,
      click: () => resolve(enableSmart ? 'disableSmart' : 'enableSmart')
    }))
    menu.append(new MenuItem({
      type: 'separator'
    }))
    menu.append(new MenuItem({
      label: t.remove,
      click: () => resolve('remove')
    }))

    menu.once('menu-will-close', () => {
      setTimeout(() => resolve(null), 100)
    })

    menu.popup({ window: win })
  })
})

ipcMain.handle('hcnet:controlPlayback', async (_e, playbackKey, cmd, param) => {
  return hcnetService.controlPlayback(playbackKey, cmd, param)
})

ipcMain.handle('hcnet:getPlaybackTime', async (_e, playbackKey) => {
  return hcnetService.getPlaybackTime(playbackKey)
})

ipcMain.handle('hcnet:seekPlaybackTime', async (_e, playbackKey, timeObj) => {
  return hcnetService.seekPlaybackTime(playbackKey, timeObj)
})

ipcMain.handle('hcnet:getPlaybackProgress', async (_e, playbackKey) => {
  return hcnetService.getPlaybackProgress(playbackKey)
})

ipcMain.handle('hcnet:setPlaybackAudio', async (_e, playbackKey, enable) => {
  return hcnetService.setPlaybackAudio(playbackKey, enable)
})

ipcMain.handle('hcnet:ptzControl', async (_e, deviceId, channelId, pan, tilt, zoom, stop) => {
  const devices = store.get('devices') || []
  const dev = devices.find(d => d.id === deviceId)
  if (!dev) throw new Error('Device not found')

  // Map pan/tilt/zoom offsets to native commands
  let command = 0
  if (pan < 0) command = 23 // PAN_LEFT
  else if (pan > 0) command = 24 // PAN_RIGHT
  else if (tilt > 0) command = 21 // TILT_UP
  else if (tilt < 0) command = 22 // TILT_DOWN
  else if (zoom > 0) command = 11 // ZOOM_IN
  else if (zoom < 0) command = 12 // ZOOM_OUT

  if (command === 0 && !stop) return false

  return hcnetService.ptzControl(
    deviceId,
    channelId,
    command || 23, // If stopping, use fallback PAN_LEFT or trigger multiple stops
    stop ? 1 : 0,  // 1 is stop, 0 is start
    dev.ip,
    dev.sdkPort || 8000,
    dev.username,
    dev.password,
    dev.channels || []
  )
})

ipcMain.handle('hcnet:ptzStop', async (_e, deviceId, channelId) => {
  const devices = store.get('devices') || []
  const dev = devices.find(d => d.id === deviceId)
  if (!dev) throw new Error('Device not found')

  const ch = dev.channels || []
  // Stop pan, tilt, and zoom natively
  hcnetService.ptzControl(deviceId, channelId, 23, 1, dev.ip, dev.sdkPort || 8000, dev.username, dev.password, ch)
  hcnetService.ptzControl(deviceId, channelId, 21, 1, dev.ip, dev.sdkPort || 8000, dev.username, dev.password, ch)
  hcnetService.ptzControl(deviceId, channelId, 11, 1, dev.ip, dev.sdkPort || 8000, dev.username, dev.password, ch)
  return true
})

ipcMain.handle('hcnet:getStreamStats', async (_event, fullscreenUiKey, focusedUiKey) => {
  return hcnetService.getStreamStats(fullscreenUiKey, focusedUiKey)
})

ipcMain.handle('hcnet:setWindowVisible', async (_e, childHwnd, visible) => {
  return hcnetService.setWindowVisible(childHwnd, visible)
})

ipcMain.handle('hcnet:setRenderPrivateData', async (_e, previewHandle, enable) => {
  return hcnetService.setRenderPrivateData(previewHandle, enable)
})

ipcMain.handle('hcnet:setAudioEnabled', async (_e, previewHandle, enabled) => {
  return hcnetService.setAudioEnabled(previewHandle, enabled)
})

ipcMain.handle('hcnet:setPlaybackRenderPrivateData', async (_e, playbackKey, enable) => {
  return hcnetService.setPlaybackRenderPrivateData(playbackKey, enable)
})

ipcMain.handle('hcnet:setWindowClip', async (_e, childHwnd, left, top, right, bottom) => {
  return hcnetService.setWindowClip(childHwnd, left, top, right, bottom)
})

ipcMain.handle('hcnet:redrawWindow', async (_e, childHwnd) => {
  return hcnetService.redrawWindow(childHwnd)
})

ipcMain.handle('playback:snapshot', async (_e, playbackKey, channelId) => {
  if (!hcnetService) throw new Error('HCNetService not available')
  const snapshotDir = store.get('snapshotPath') || path.join(app.getPath('pictures'), 'vLAN-CameraHIK', 'Snapshots')
  const fs = require('fs')
  fs.mkdirSync(snapshotDir, { recursive: true })
  const filename = `playback_snapshot_ch${channelId}_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
  const filePath = path.join(snapshotDir, filename)
  
  const success = hcnetService.capturePlaybackPicture(playbackKey, filePath)
  if (success) {
    return { filename, filePath }
  }
  return null
})

console.log('[Main] All IPC handlers registered')


