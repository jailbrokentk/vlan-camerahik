/**
 * server.js — Express API server wrapping HikService
 * Replaces Electron IPC for browser-based access
 */
const express = require('express')
const cors = require('cors')
const path = require('path')
const { HikService } = require('./electron/services/hikService')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.text({ type: 'application/sdp', limit: '1mb' }))

const hikService = new HikService()

const fs = require('fs')

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

const storePath = path.join(__dirname, 'config.json')
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
store._init()

// ─── Device / ISAPI ───────────────────────────────────────────────────────────
app.post('/api/hik/connect', async (req, res) => {
  try {
    const result = await hikService.connect(req.body)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/hik/device-info/:id', async (req, res) => {
  try {
    res.json(await hikService.getDeviceInfo(req.params.id))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/hik/channels/:id', async (req, res) => {
  try {
    const channels = await hikService.getChannels(req.params.id)
    console.log('[API] getChannels result:', JSON.stringify(channels).substring(0, 500))
    res.json(channels)
  } catch (e) {
    console.error('[API] getChannels error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/hik/ip-channels/:id', async (req, res) => {
  try {
    res.json(await hikService.getIPChannels(req.params.id))
  } catch (e) {
    console.error('[API] getIPChannels error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/hik/snapshot/:deviceId/:channelId', async (req, res) => {
  try {
    const data = await hikService.snapshot(req.params.deviceId, req.params.channelId)
    res.json({ data })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/hik/ptz/:deviceId/:channelId', async (req, res) => {
  try {
    const { pan, tilt, zoom } = req.body
    res.json(await hikService.ptzControl(req.params.deviceId, req.params.channelId, pan, tilt, zoom))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/hik/ptz-stop/:deviceId/:channelId', async (req, res) => {
  try {
    res.json(await hikService.ptzStop(req.params.deviceId, req.params.channelId))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/hik/search-recordings', async (req, res) => {
  try {
    const { deviceId, trackId, startTime, endTime } = req.body
    res.json(await hikService.searchRecordings(deviceId, trackId, startTime, endTime))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/hik/start-alert/:id', (req, res) => {
  if (!store._alerts) store._alerts = []
  hikService.startAlertStream(req.params.id, (alert) => {
    // Deduplicate: ignore if same eventType from same ipAddress/channelID is already present
    const isDuplicate = store._alerts.some(existing => 
      existing.eventType === alert.eventType &&
      existing.ipAddress === alert.ipAddress &&
      existing.channelID === alert.channelID
    )
    
    if (isDuplicate) return

    store._alerts.push({ ...alert, id: `alert-${Date.now()}`, isNew: true })
    if (store._alerts.length > 200) store._alerts = store._alerts.slice(-100)
  })
  res.json({ ok: true })
})

app.post('/api/hik/stop-alert/:id', (req, res) => {
  hikService.stopAlertStream(req.params.id)
  res.json({ ok: true })
})

app.get('/api/hik/alerts', (req, res) => {
  res.json(store._alerts || [])
})

app.delete('/api/hik/alerts', (req, res) => {
  store._alerts = []
  res.json({ ok: true })
})

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password, fingerprint } = req.body
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex')
  store.set('appCredentials', { username, passwordHash })
  const token = crypto.randomBytes(32).toString('hex')
  const sessions = store.get('appSessions') || {}
  sessions[fingerprint] = token
  store.set('appSessions', sessions)
  res.json({ success: true, token })
})

app.post('/api/auth/login', (req, res) => {
  const { username, password, fingerprint } = req.body
  const creds = store.get('appCredentials')
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex')
  if (!creds || creds.username !== username || (creds.passwordHash ? creds.passwordHash !== passwordHash : creds.password !== password)) {
    return res.json({ success: false, error: 'Tài khoản hoặc mật khẩu không chính xác!' })
  }
  const token = crypto.randomBytes(32).toString('hex')
  const sessions = store.get('appSessions') || {}
  sessions[fingerprint] = token
  store.set('appSessions', sessions)
  res.json({ success: true, token })
})

app.post('/api/auth/validate', (req, res) => {
  const { token, fingerprint } = req.body
  const sessions = store.get('appSessions')
  if (!sessions || sessions[fingerprint] !== token) {
    return res.json(false)
  }
  res.json(true)
})

app.post('/api/auth/logout', (req, res) => {
  const { fingerprint } = req.body
  const sessions = store.get('appSessions') || {}
  delete sessions[fingerprint]
  store.set('appSessions', sessions)
  res.json(true)
})

app.get('/api/auth/is-configured', (req, res) => {
  const creds = store.get('appCredentials')
  res.json(!!(creds && creds.username && (creds.password || creds.passwordHash)))
})

// ─── Store ────────────────────────────────────────────────────────────────────
app.get('/api/store/:key', (req, res) => {
  const { key } = req.params
  if (key === 'appCredentials' || key === 'appSession' || key === 'appSessions') return res.json(null)
  const value = store.get(key)
  const result = value !== undefined ? value : null
  console.log(`[Store API] GET key: "${key}" -> found:`, Array.isArray(result) ? `${result.length} items` : typeof result)
  res.json(result)
})

app.post('/api/store/:key', (req, res) => {
  const { key } = req.params
  if (key === 'appCredentials' || key === 'appSession' || key === 'appSessions') return res.json({ ok: false })
  console.log(`[Store API] SET key: "${key}" ->`, Array.isArray(req.body.value) ? `${req.body.value.length} items` : typeof req.body.value)
  store.set(key, req.body.value)
  res.json({ ok: true })
})

app.delete('/api/store/:key', (req, res) => {
  const { key } = req.params
  if (key === 'appCredentials' || key === 'appSession' || key === 'appSessions') return res.json({ ok: false })
  console.log(`[Store API] DELETE key: "${key}"`)
  store.delete(key)
  res.json({ ok: true })
})

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 3001

async function start() {
  // Migrate old singular appSession to plural appSessions map
  try {
    const oldSession = store.get('appSession')
    if (oldSession && oldSession.token && oldSession.fingerprint) {
      const sessions = store.get('appSessions') || {}
      sessions[oldSession.fingerprint] = oldSession.token
      store.set('appSessions', sessions)
      store.delete('appSession')
      console.log('[Server] Migrated old appSession to appSessions map.')
    }
  } catch (e) {
    console.error('[Server] Session migration failed:', e.message)
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] API running on http://0.0.0.0:${PORT}`)
    console.log(`[Server] Open browser: http://localhost:5173`)
  })
}

start()
