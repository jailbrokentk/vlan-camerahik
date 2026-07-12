/**
 * hikService.js — Hikvision ISAPI client
 * Manual HTTP Digest Auth implementation (no external deps)
 */

const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

// ── Digest Auth helper ────────────────────────────────────────────────────────

function parseWWWAuth(header) {
  const getParam = (key) => {
    let m = header.match(new RegExp(`${key}="([^"]+)"`))
    if (m) return m[1]
    m = header.match(new RegExp(`${key}=([^\\s,]+)`))
    if (m) return m[1].replace(/"/g, '')
    return ''
  }
  const realm = getParam('realm')
  const nonce = getParam('nonce')
  const qop = getParam('qop')
  const opaque = getParam('opaque')
  const algo = getParam('algorithm') || 'MD5'
  return { realm, nonce, qop, opaque, algo }
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex')
}

function buildDigestAuth({ username, password, method, url, realm, nonce, qop, opaque, nc, cnonce }) {
  const ha1 = md5(`${username}:${realm}:${password}`)
  const ha2 = md5(`${method}:${url}`)
  const ncHex = nc.toString(16).padStart(8, '0')
  let response
  if (qop === 'auth' || qop === 'auth-int') {
    response = md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`)
  }

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${url}", response="${response}"`
  if (qop) header += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`
  if (opaque) header += `, opaque="${opaque}"`
  return header
}

/**
 * Perform HTTP request with Digest Authentication
 * Returns { status, headers, body, bodyBuffer }
 */
function digestRequest(options, body = null) {
  const { baseUrl, path, method = 'GET', username, password, extraHeaders = {}, binary = false } = options

  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl)
    const lib = parsed.protocol === 'https:' ? https : http
    const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80)

    const reqOptions = {
      hostname: parsed.hostname,
      port,
      path,
      method,
      headers: { ...extraHeaders },
      rejectUnauthorized: false
    }

    // Step 1: Initial request (will get 401)
    const req1 = lib.request(reqOptions, (res1) => {
      if (res1.statusCode !== 401) {
        const chunks = []
        res1.on('data', (chunk) => chunks.push(chunk))
        res1.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks)
          const bodyText = bodyBuffer.toString('utf8')
          resolve({ status: res1.statusCode, headers: res1.headers, body: bodyText, bodyBuffer })
        })
        return
      }

      res1.resume()
      res1.on('end', () => {

        const wwwAuth = res1.headers['www-authenticate'] || ''
        const { realm, nonce, qop, opaque } = parseWWWAuth(wwwAuth)
        const cnonce = crypto.randomBytes(8).toString('hex')
        const nc = 1

        const authHeader = buildDigestAuth({
          username, password, method, url: path,
          realm, nonce, qop, opaque, nc, cnonce
        })

        const req2Options = {
          ...reqOptions,
          headers: {
            ...extraHeaders,
            Authorization: authHeader
          }
        }

        if (body) {
          req2Options.headers['Content-Length'] = Buffer.byteLength(body)
        }

        // Step 2: Authenticated request
        const req2 = lib.request(req2Options, (res2) => {
          const chunks = []
          res2.on('data', (chunk) => chunks.push(chunk))
          res2.on('end', () => {
            const bodyBuffer = Buffer.concat(chunks)
            const bodyText = bodyBuffer.toString('utf8')
            resolve({ status: res2.statusCode, headers: res2.headers, body: bodyText, bodyBuffer })
          })
        })

        req2.on('error', reject)
        if (body) req2.write(body)
        req2.end()
      })
    })

    req1.on('error', reject)
    req1.end()
  })
}

// ── HikService ────────────────────────────────────────────────────────────────

class HikService {
  constructor() {
    this.devices = new Map()
    this.alertControllers = new Map()
  }

  async connect(device) {
    const { id, ip, port, username, password } = device
    const baseUrl = `http://${ip}:${port}`

    const res = await digestRequest({ baseUrl, path: '/ISAPI/System/deviceInfo', method: 'GET', username, password })

    if (res.status !== 200) {
      throw new Error(`Kết nối thất bại: HTTP ${res.status}. Kiểm tra IP/Port/User/Pass.`)
    }

    const info = this._parseDeviceInfo(res.body)
    this.devices.set(id, { id, ip, port, username, password, baseUrl })
    return { success: true, deviceInfo: info }
  }

  async getDeviceInfo(deviceId) {
    const dev = this._getDevice(deviceId)
    const res = await digestRequest({ ...this._opts(dev), path: '/ISAPI/System/deviceInfo' })
    return this._parseDeviceInfo(res.body)
  }

  async getChannels(deviceId) {
    const dev = this._getDevice(deviceId)
    
    // Fetch custom IP channel names
    const ipChannelsMap = new Map()
    try {
      const ipRes = await digestRequest({ ...this._opts(dev), path: '/ISAPI/ContentMgmt/InputProxy/channels' })
      if (ipRes.status === 200) {
        const re = /<InputProxyChannel[\s>]([\s\S]*?)<\/InputProxyChannel>/g
        let m
        while ((m = re.exec(ipRes.body)) !== null) {
          const block = m[1]
          const get = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`)) || [])[1] || ''
          const id = get('id')
          if (id) {
            ipChannelsMap.set(id, get('name'))
          }
        }
      }
    } catch (e) {
      console.warn('[HikService] Failed to fetch custom IP channels list:', e.message)
    }

    const res = await digestRequest({ ...this._opts(dev), path: '/ISAPI/Streaming/channels' })
    const channels = this._parseChannels(res.body)
    
    // Map custom names to channels list
    return channels.map((ch) => {
      if (ipChannelsMap.has(ch.id)) {
        return { ...ch, channelName: ipChannelsMap.get(ch.id) || ch.channelName }
      }
      return ch
    })
  }

  async getIPChannels(deviceId) {
    const dev = this._getDevice(deviceId)
    try {
      const ipRes = await digestRequest({ ...this._opts(dev), path: '/ISAPI/ContentMgmt/InputProxy/channels' })
      let statusXml = ''
      try {
        const statusRes = await digestRequest({ ...this._opts(dev), path: '/ISAPI/ContentMgmt/InputProxy/channels/status' })
        if (statusRes.status === 200) statusXml = statusRes.body
      } catch (e) {
        console.warn('[HikService] Failed to fetch proxy channels status:', e.message)
      }
      
      if (ipRes.status !== 200) throw new Error(`Fetch IP channels failed: HTTP ${ipRes.status}`)
      return this._parseIPChannels(ipRes.body, statusXml)
    } catch (err) {
      console.error('[HikService] getIPChannels error:', err.message)
      throw err
    }
  }

  async snapshot(deviceId, channelId) {
    const dev = this._getDevice(deviceId)
    const res = await digestRequest({
      ...this._opts(dev),
      path: `/ISAPI/Streaming/channels/${channelId}/picture`,
      binary: true
    })
    if (res.status !== 200) throw new Error(`Snapshot thất bại: HTTP ${res.status}`)
    return `data:image/jpeg;base64,${res.bodyBuffer.toString('base64')}`
  }

  async snapshotToFile(deviceId, channelId, filePath) {
    const dev = this._getDevice(deviceId)
    const res = await digestRequest({
      ...this._opts(dev),
      path: `/ISAPI/Streaming/channels/${channelId}/picture`,
      binary: true
    })
    if (res.status !== 200) throw new Error(`Snapshot thất bại: HTTP ${res.status}`)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, res.bodyBuffer)
    return { success: true, filePath, filename: path.basename(filePath) }
  }

  async ptzControl(deviceId, channelId, pan, tilt, zoom) {
    const dev = this._getDevice(deviceId)
    const clip = (val) => Math.max(-100, Math.min(100, Math.round(val || 0)))
    const p = clip(pan)
    const t = clip(tilt)
    const z = clip(zoom)
    const body = `<PTZData version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
      <pan>${p}</pan><tilt>${t}</tilt><zoom>${z}</zoom>
    </PTZData>`
    await digestRequest({
      ...this._opts(dev),
      path: `/ISAPI/PTZCtrl/channels/${channelId}/continuous`,
      method: 'PUT',
      extraHeaders: { 'Content-Type': 'application/xml' }
    }, body)
    return { success: true }
  }

  async ptzStop(deviceId, channelId) {
    return this.ptzControl(deviceId, channelId, 0, 0, 0)
  }

  async searchRecordings(deviceId, trackId, startTime, endTime) {
    const dev = this._getDevice(deviceId)
    const body = `<CMSearchDescription>
      <searchID>${Date.now()}</searchID>
      <trackList><trackID>${trackId}</trackID></trackList>
      <timeSpanList>
        <timeSpan>
          <startTime>${startTime}</startTime>
          <endTime>${endTime}</endTime>
        </timeSpan>
      </timeSpanList>
      <maxResults>100</maxResults>
      <searchResultPosition>0</searchResultPosition>
      <metadataList>
        <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
      </metadataList>
    </CMSearchDescription>`

    const res = await digestRequest({
      ...this._opts(dev),
      path: '/ISAPI/ContentMgmt/search',
      method: 'POST',
      extraHeaders: { 'Content-Type': 'application/xml' }
    }, body)
    return this._parseRecordings(res.body)
  }

  startAlertStream(deviceId, onAlert) {
    const dev = this._getDevice(deviceId)
    const parsed = new URL(dev.baseUrl)
    const lib = parsed.protocol === 'https:' ? https : http

    let active = true
    let activeReq = null
    let activeRes = null
    this.alertControllers.set(deviceId, {
      abort: () => {
        active = false
        if (activeReq) { try { activeReq.destroy() } catch {} }
        if (activeRes) { try { activeRes.destroy() } catch {} }
      }
    })

    const listen = () => {
      if (!active) return

      // Step 1: get nonce
      const opts1 = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: '/ISAPI/Event/notification/alertStream',
        method: 'GET',
        rejectUnauthorized: false
      }

      const req1 = lib.request(opts1, (res1) => {
        activeReq = req1
        res1.resume()
        res1.on('end', () => {
          if (!active) return
          if (res1.statusCode !== 401) {
            setTimeout(() => listen(), 5000)
            return
          }

          const wwwAuth = res1.headers['www-authenticate'] || ''
          const { realm, nonce, qop, opaque } = parseWWWAuth(wwwAuth)
          const cnonce = crypto.randomBytes(8).toString('hex')
          const authHeader = buildDigestAuth({
            username: dev.username, password: dev.password,
            method: 'GET', url: '/ISAPI/Event/notification/alertStream',
            realm, nonce, qop, opaque, nc: 1, cnonce
          })

          const req2 = lib.request({
            ...opts1,
            headers: { Authorization: authHeader }
          }, (res2) => {
            activeRes = res2
            let buffer = ''
            res2.on('data', (chunk) => {
              if (!active) return
              buffer += chunk.toString()
              const result = this._parseAlertStream(buffer)
              buffer = result.remaining
              result.alerts.forEach(onAlert)
            })
            res2.on('end', () => {
              activeRes = null
              if (active) setTimeout(() => listen(), 3000)
            })
            res2.on('error', () => {
              activeRes = null
              if (active) setTimeout(() => listen(), 5000)
            })
          })

          req2.on('error', () => { if (active) setTimeout(() => listen(), 5000) })
          req2.end()
        })
      })

      req1.on('error', () => { if (active) setTimeout(() => listen(), 5000) })
      req1.end()
    }

    listen()
  }

  stopAlertStream(deviceId) {
    const ctrl = this.alertControllers.get(deviceId)
    if (ctrl) {
      ctrl.abort()
      this.alertControllers.delete(deviceId)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _getDevice(deviceId) {
    const dev = this.devices.get(deviceId)
    if (!dev) throw new Error(`Device ${deviceId} chưa được kết nối`)
    return dev
  }

  _opts(dev) {
    return { baseUrl: dev.baseUrl, username: dev.username, password: dev.password }
  }

  _parseDeviceInfo(xml) {
    const get = (tag) => (xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`)) || [])[1] || ''
    return {
      deviceName:          get('deviceName'),
      model:               get('model'),
      serialNumber:        get('serialNumber'),
      macAddress:          get('macAddress'),
      firmwareVersion:     get('firmwareVersion'),
      firmwareReleasedDate:get('firmwareReleasedDate'),
      deviceType:          get('deviceType')
    }
  }

  _parseChannels(xml) {
    const channels = []
    // Match StreamingChannel with any attributes (version, xmlns, etc.)
    const re = /<StreamingChannel[\s>]([\s\S]*?)<\/StreamingChannel>/g
    let m
    while ((m = re.exec(xml)) !== null) {
      const block = m[1]
      const get = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`)) || [])[1] || ''
      const id = get('id')
      const enabled = get('enabled') !== 'false'
      // Only include main streams (IDs ending in 01, e.g. 101, 201, 301...)
      // Sub-streams end in 02, 03 etc.
      if (enabled && id && id.endsWith('01')) {
        const chNum = id.replace(/01$/, '')
        channels.push({
          id: chNum,
          channelName: get('channelName') || `Camera ${chNum}`,
          enabled,
          codec: get('videoCodecType')
        })
      }
    }
    console.log('[HikService] Parsed', channels.length, 'channels')
    return channels
  }

  _parseRecordings(xml) {
    const recs = []
    const re = /<searchMatchItem>([\s\S]*?)<\/searchMatchItem>/g
    let m
    while ((m = re.exec(xml)) !== null) {
      const block = m[1]
      const get = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`)) || [])[1] || ''
      recs.push({
        trackID:    get('trackID'),
        startTime:  get('startTime'),
        endTime:    get('endTime'),
        recordType: get('recordType'),
        fileSize:   get('fileSize')
      })
    }
    return recs
  }

  _parseAlertStream(buffer) {
    const alerts = []
    const parts = buffer.split(/--[\w\-]+/)
    let remaining = parts[parts.length - 1]

    for (let i = 0; i < parts.length - 1; i++) {
      const xmlMatch = parts[i].match(/<EventNotificationAlert[\s\S]*?<\/EventNotificationAlert>/)
      if (xmlMatch) {
        const xml = xmlMatch[0]
        const get = (tag) => (xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`)) || [])[1] || ''
        alerts.push({
          ipAddress:        get('ipAddress'),
          channelID:        get('channelID'),
          dateTime:         get('dateTime'),
          eventType:        get('eventType'),
          eventDescription: get('eventDescription'),
          activePostCount:  get('activePostCount')
        })
      }
    }

    return { alerts, remaining }
  }

  _parseIPChannels(xml, statusXml = '') {
    const ipChannels = []
    
    // Parse status XML into a map of id -> online
    const statusMap = new Map()
    if (statusXml) {
      const statusRe = /<InputProxyChannelStatus[\s>]([\s\S]*?)<\/InputProxyChannelStatus>/g
      let mStatus
      while ((mStatus = statusRe.exec(statusXml)) !== null) {
        const block = mStatus[1]
        const get = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`)) || [])[1] || ''
        const id = get('id')
        if (id) {
          statusMap.set(id, get('online') === 'true')
        }
      }
    }

    const re = /<InputProxyChannel[\s>]([\s\S]*?)<\/InputProxyChannel>/g
    let m
    while ((m = re.exec(xml)) !== null) {
      const block = m[1]
      const get = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`)) || [])[1] || ''
      const id = get('id')
      if (id) {
        ipChannels.push({
          id,
          name: get('name') || `IP Camera ${id}`,
          protocol: get('proxyProtocol') || 'HIKVISION',
          ipAddress: get('ipAddress'),
          port: parseInt(get('managePortNo')) || 8000,
          online: statusMap.has(id) ? statusMap.get(id) : true,
          model: get('model') || '',
          serialNumber: get('serialNumber') || '',
          firmwareVersion: get('firmwareVersion') || ''
        })
      }
    }
    return ipChannels
  }
}

module.exports = { HikService }
