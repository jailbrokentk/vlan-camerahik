const path = require('path')
const fs = require('fs')
const { app } = require('electron')

let addon = null
let addonError = null
let loadedPath = null

// ─── Set up DLL Paths before require ──────────────────────────────────────────
try {
  const appDir = app ? app.getAppPath() : process.cwd();
  const isPackaged = app ? app.isPackaged : false;
  
  // In development: f:\ivms\resources\sdk
  // In production: extraFiles copies resources/sdk content directly to the executable directory (root)
  const sdkDir = isPackaged 
    ? path.dirname(process.execPath) // next to vLAN-CameraHIK.exe
    : path.join(appDir, 'resources', 'sdk');

  if (process.platform === 'win32' && fs.existsSync(sdkDir)) {
    // Append the SDK folder containing HCCore.dll / HCNetSDK.dll to process.env.PATH
    // so that the OS dynamic linker can resolve native addon dll dependencies.
    process.env.PATH = `${sdkDir};${process.env.PATH}`;
    console.log(`[HCNetService] Appended SDK path to system PATH: ${sdkDir}`);
  }
} catch (e) {
  console.error('[HCNetService] Failed to dynamically adjust DLL PATH:', e.message);
}

// ─── Dynamic Loader Candidates ───────────────────────────────────────────────
try {
  const isPackaged = app ? app.isPackaged : false;
  const appDir = app ? app.getAppPath() : process.cwd();
  
  const candidates = [];
  if (isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, 'native', 'hcnet-addon.node'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'hcnet-addon', 'build', 'Release', 'hcnet-addon.node')
    );
  } else {
    candidates.push(
      path.join(appDir, 'hcnet-addon', 'build', 'Release', 'hcnet-addon.node'),
      path.join(__dirname, '..', '..', 'hcnet-addon', 'build', 'Release', 'hcnet-addon.node')
    );
  }

  let lastErrorDetail = '';
  for (const p of candidates) {
    const exists = fs.existsSync(p);
    
    if (exists) {
      try {
        addon = require(p);
        loadedPath = p;
        addonError = null;
        console.log(`[HCNetService] Loaded native addon from: ${p}`);
        break;
      } catch (err) {
        console.error(`[HCNetService] Failed to load addon from ${p}:`, err.message);
        lastErrorDetail = `${p}: ${err.message}`;
      }
    }
  }

  if (!addon) {
    const electronVer = process.versions.electron || 'N/A';
    const nodeAbi = process.versions.modules || 'N/A';
    addonError = `Addon not loaded.\nPlatform: win32 (${process.arch})\nElectron Version: ${electronVer}\nNode Module ABI: ${nodeAbi}\nDetails: ${lastErrorDetail || 'No candidates found. Rebuild is required.'}`;
  }
} catch (e) {
  addonError = e.message;
  console.error('[HCNetService] Fatal loader error:', e);
}

class HCNetService {
  constructor() {
    // deviceId -> { userId: number, sdkChannels: number[] }
    this.sessions = new Map()
    this.activeStreams = new Map() // streamKey -> { previewHandle, childHwnd }
    this.activePlaybacks = new Map() // playbackKey -> { playbackHandle, childHwnd }
    this.isInitialized = false
  }

  isAvailable() {
    return addon !== null
  }

  getAddonError() {
    return addonError || 'Success'
  }

  init() {
    if (!this.isAvailable()) return false
    if (this.isInitialized) return true

    try {
      const ok = addon.init()
      if (ok) {
        this.isInitialized = true
        console.log('[HCNetService] Global HCNetSDK initialized successfully')
      } else {
        console.error('[HCNetService] Global HCNetSDK initialization failed')
      }
      return ok
    } catch (err) {
      console.error('[HCNetService] Init crash:', err.message)
      return false
    }
  }

  cleanup() {
    if (!this.isAvailable() || !this.isInitialized) return true

    // Stop all active streams
    for (const [key, stream] of this.activeStreams) {
      try {
        addon.stopRealPlay(stream.previewHandle, stream.childHwnd)
      } catch (e) {}
    }
    this.activeStreams.clear()

    // Stop all active playbacks
    for (const [key, pb] of this.activePlaybacks) {
      try {
        addon.stopPlayback(pb.playbackHandle, pb.childHwnd)
      } catch (e) {}
    }
    this.activePlaybacks.clear()

    // Logout all NVRs
    for (const [deviceId, session] of this.sessions) {
      try {
        addon.logout(session.userId)
      } catch (e) {}
    }
    this.sessions.clear()

    try {
      const ok = addon.cleanup()
      if (ok) this.isInitialized = false
      return ok
    } catch (err) {
      console.error('[HCNetService] Cleanup error:', err.message)
      return false
    }
  }

  // Session login wrapper (reuses session if logged in)
  // Returns { userId, sdkChannels }
  login(deviceId, ip, port, username, password) {
    if (!this.isAvailable()) throw new Error('Native HCNetSDK addon not available')
    this.init()

    if (this.sessions.has(deviceId)) {
      return this.sessions.get(deviceId)
    }

    try {
      console.log(`[HCNetService] Logging in to ${ip}:${port} (Device ID: ${deviceId})...`)
      const result = addon.login(ip, port, username, password)
      
      // addon.login now returns { userId, sdkChannels }
      const userId = result.userId
      const sdkChannels = []
      
      // Convert Napi array to JS array
      if (result.sdkChannels) {
        for (let i = 0; i < result.sdkChannels.length; i++) {
          sdkChannels.push(result.sdkChannels[i])
        }
      }

      if (userId < 0) {
        const errCode = addon.getLastError()
        throw new Error(`HCNetSDK Login Failed. Error Code: ${errCode}`)
      }

      const session = { userId, sdkChannels }
      this.sessions.set(deviceId, session)
      console.log(`[HCNetService] Login success. UserID: ${userId}, sdkChannels: [${sdkChannels.join(', ')}]`)
      return session
    } catch (err) {
      console.error(`[HCNetService] Login error for ${ip}:`, err.message)
      throw err;
    }
  }

  logout(deviceId) {
    const session = this.sessions.get(deviceId)
    if (!session) return true

    try {
      const ok = addon.logout(session.userId)
      this.sessions.delete(deviceId)
      return ok
    } catch (err) {
      return false
    }
  }

  // ─── Channel Resolution ────────────────────────────────────────────────────
  // Resolve UI channelId (e.g. "1", "2") to actual HCNetSDK channel number
  // using the sdkChannels map obtained at login time.
  
  _resolveSDKChannel(session, channelId, deviceChannels) {
    // deviceChannels is the device.channels[] array from the store
    // channelId is the UI-facing channel ID string (e.g. "1", "2", ...)
    
    if (!deviceChannels || deviceChannels.length === 0) {
      // No channel list — try using channelId as a direct index
      const directIndex = parseInt(channelId, 10) - 1
      if (directIndex >= 0 && directIndex < session.sdkChannels.length) {
        const sdkCh = session.sdkChannels[directIndex]
        console.log(`[HCNetService] Channel resolve (no device channels): UI "${channelId}" → index ${directIndex} → sdkChannel ${sdkCh}`)
        return sdkCh
      }
      throw new Error(`Cannot resolve channel "${channelId}" — no device channels and index ${directIndex} out of range (${session.sdkChannels.length} SDK channels)`)
    }

    // Find the index of this channelId in the device's channel list
    const uiIndex = deviceChannels.findIndex(c => String(c.id) === String(channelId))
    if (uiIndex < 0) {
      throw new Error(`Unknown UI channel: ${channelId}`)
    }

    if (uiIndex >= session.sdkChannels.length) {
      throw new Error(`UI channel index ${uiIndex} exceeds SDK channel map length (${session.sdkChannels.length})`)
    }

    const sdkChannel = session.sdkChannels[uiIndex]
    if (!Number.isInteger(sdkChannel) || sdkChannel <= 0) {
      throw new Error(`Invalid SDK channel mapping for UI index ${uiIndex}: ${sdkChannel}`)
    }

    console.log(`[HCNetService] Channel resolve: UI "${channelId}" → index ${uiIndex} → sdkChannel ${sdkChannel}`)
    return sdkChannel
  }

  // ─── Real Play (Live View) ──────────────────────────────────────────────────

  startPlay(deviceId, channelId, streamType, parentHwnd, x, y, w, h, ip, port, username, password, deviceChannels, enableSmart, linkMode = 0, bufNum = 3) {
    const session = this.login(deviceId, ip, port, username, password)
    const sdkChannel = this._resolveSDKChannel(session, channelId, deviceChannels)
    const streamKey = `${deviceId}_${sdkChannel}_${streamType}`

    // Stop if already playing on this slot
    if (this.activeStreams.has(streamKey)) {
      this.stopPlay(streamKey)
    }

    try {
      console.log(`[HCNetService] Starting real play. UI ch: ${channelId} → sdkChannel: ${sdkChannel}, dwStreamType: ${streamType}, enableSmart: ${enableSmart}, linkMode: ${linkMode}, bufNum: ${bufNum}`)
      const result = addon.startRealPlay(parentHwnd, session.userId, sdkChannel, streamType, x, y, w, h, !!enableSmart, linkMode, bufNum)

      if (typeof result === 'number' || result.previewHandle < 0) {
        const errCode = addon.getLastError()
        throw new Error(`RealPlay failed. SDK Error Code: ${errCode}`)
      }

      this.activeStreams.set(streamKey, {
        previewHandle: result.previewHandle,
        childHwnd: result.childHwnd
      })

      return {
        previewHandle: result.previewHandle,
        childHwnd: result.childHwnd,
        streamKey
      }
    } catch (err) {
      console.error('[HCNetService] RealPlay error:', err.message)
      throw err
    }
  }

  stopPlay(streamKey) {
    const stream = this.activeStreams.get(streamKey)
    if (!stream) return true

    try {
      addon.stopRealPlay(stream.previewHandle, stream.childHwnd)
      this.activeStreams.delete(streamKey)
      return true
    } catch (err) {
      console.error('[HCNetService] StopRealPlay error:', err.message)
      return false
    }
  }

  moveWindow(childHwnd, x, y, w, h) {
    if (!this.isAvailable()) return false
    try {
      return addon.moveRealPlayWindow(childHwnd, x, y, w, h)
    } catch (err) {
      return false
    }
  }

  // ─── Playback ───────────────────────────────────────────────────────────────

  startPlayback(deviceId, channelId, startTimeStr, endTimeStr, parentHwnd, x, y, w, h, ip, port, username, password, deviceChannels) {
    const session = this.login(deviceId, ip, port, username, password)
    const sdkChannel = this._resolveSDKChannel(session, channelId, deviceChannels)
    const playbackKey = `${deviceId}_${sdkChannel}_${Date.now()}`

    const start = new Date(startTimeStr)
    const end = new Date(endTimeStr)

    const startTimeObj = {
      year: start.getFullYear(),
      month: start.getMonth() + 1,
      day: start.getDate(),
      hour: start.getHours(),
      minute: start.getMinutes(),
      second: start.getSeconds()
    }

    const endTimeObj = {
      year: end.getFullYear(),
      month: end.getMonth() + 1,
      day: end.getDate(),
      hour: end.getHours(),
      minute: end.getMinutes(),
      second: end.getSeconds()
    }

    try {
      console.log(`[HCNetService] Starting native playback. UI ch: ${channelId} → sdkChannel: ${sdkChannel}`)

      const result = addon.startPlaybackByTime(parentHwnd, session.userId, sdkChannel, startTimeObj, endTimeObj, x, y, w, h, 0)

      if (typeof result === 'number' || result.playbackHandle < 0) {
        const errCode = addon.getLastError()
        throw new Error(`Playback failed. SDK Error Code: ${errCode}`)
      }

      this.activePlaybacks.set(playbackKey, {
        playbackHandle: result.playbackHandle,
        childHwnd: result.childHwnd
      })

      return {
        playbackHandle: result.playbackHandle,
        childHwnd: result.childHwnd,
        playbackKey
      }
    } catch (err) {
      console.error('[HCNetService] StartPlayback error:', err.message)
      throw err
    }
  }

  stopPlayback(playbackKey) {
    const pb = this.activePlaybacks.get(playbackKey)
    if (!pb) return true

    try {
      addon.stopPlayback(pb.playbackHandle, pb.childHwnd)
      this.activePlaybacks.delete(playbackKey)
      return true
    } catch (err) {
      console.error('[HCNetService] StopPlayback error:', err.message)
      return false
    }
  }

  controlPlayback(playbackKey, cmd, param) {
    const pb = this.activePlaybacks.get(playbackKey)
    if (!pb) return false

    try {
      // Hikvision PlaybackControl values:
      // NET_DVR_PLAYPAUSE = 3, NET_DVR_PLAYRESTART = 4, NET_DVR_PLAYFAST = 5, NET_DVR_PLAYSLOW = 6, NET_DVR_PLAYNORMAL = 7
      return addon.controlPlayback(pb.playbackHandle, cmd, param)
    } catch (err) {
      return false
    }
  }

  getPlaybackTime(playbackKey) {
    const pb = this.activePlaybacks.get(playbackKey)
    if (!pb) return null
    try {
      return addon.getPlaybackTime(pb.playbackHandle)
    } catch (err) {
      console.error('[HCNetService] GetPlaybackTime error:', err.message)
      return null
    }
  }

  seekPlaybackTime(playbackKey, timeObj) {
    const pb = this.activePlaybacks.get(playbackKey)
    if (!pb) return false
    try {
      return addon.seekPlaybackTime(pb.playbackHandle, timeObj)
    } catch (err) {
      console.error('[HCNetService] SeekPlaybackTime error:', err.message)
      return false
    }
  }

  getPlaybackProgress(playbackKey) {
    const pb = this.activePlaybacks.get(playbackKey)
    if (!pb) return -1
    try {
      return addon.getPlaybackProgress(pb.playbackHandle)
    } catch (err) {
      console.error('[HCNetService] GetPlaybackProgress error:', err.message)
      return -1
    }
  }

  setPlaybackAudio(playbackKey, enable) {
    const pb = this.activePlaybacks.get(playbackKey)
    if (!pb) return false
    try {
      return addon.setPlaybackAudio(pb.playbackHandle, enable)
    } catch (err) {
      console.error('[HCNetService] SetPlaybackAudio error:', err.message)
      return false
    }
  }

  setWindowVisible(childHwnd, visible) {
    if (!this.isAvailable()) return false
    try {
      return addon.setWindowVisible(childHwnd, visible)
    } catch (err) {
      console.error('[HCNetService] SetWindowVisible error:', err.message)
      return false
    }
  }

  setRenderPrivateData(previewHandle, enable) {
    if (!this.isAvailable()) return false
    try {
      return addon.setRenderPrivateData(previewHandle, enable)
    } catch (err) {
      console.error('[HCNetService] SetRenderPrivateData error:', err.message)
      return false
    }
  }

  setAudioEnabled(previewHandle, enabled) {
    if (!this.isAvailable()) return false
    try {
      return addon.setAudioEnabled(previewHandle, enabled)
    } catch (err) {
      console.error('[HCNetService] SetAudioEnabled error:', err.message)
      return false
    }
  }

  // ─── PTZ Control ─────────────────────────────────────────────────────────────

  ptzControl(deviceId, channelId, command, stop, ip, port, username, password, deviceChannels) {
    const session = this.login(deviceId, ip, port, username, password)
    const sdkChannel = this._resolveSDKChannel(session, channelId, deviceChannels)
    try {
      console.log(`[HCNetService] PTZ: UI ch ${channelId} → sdkChannel ${sdkChannel}, cmd=${command}, stop=${stop}`)
      // Hikvision PTZ command maps (e.g. TILT_UP = 21, TILT_DOWN = 22, PAN_LEFT = 23, PAN_RIGHT = 24)
      return addon.ptzControl(session.userId, sdkChannel, command, stop)
    } catch (err) {
      console.error('[HCNetService] PTZ error:', err.message)
      return false
    }
  }

  setPlaybackRenderPrivateData(playbackKey, enable) {
    const pb = this.activePlaybacks.get(playbackKey)
    if (!pb) return false
    try {
      // Pass isPlayback=true so the addon uses PlayBackControl VCA commands
      // instead of RenderPrivateData (which is LiveView-only)
      return addon.setRenderPrivateData(pb.playbackHandle, enable, true)
    } catch (err) {
      console.error('[HCNetService] SetPlaybackRenderPrivateData error:', err.message)
      return false
    }
  }

  setWindowClip(childHwnd, left, top, right, bottom) {
    if (!this.isAvailable()) return false
    try {
      return addon.setPlaybackWindowClip(childHwnd, left, top, right, bottom)
    } catch (err) {
      console.error('[HCNetService] SetWindowClip error:', err.message)
      return false
    }
  }

  redrawWindow(childHwnd) {
    if (!this.isAvailable()) return false
    try {
      return addon.redrawWindow(childHwnd)
    } catch (err) {
      console.error('[HCNetService] RedrawWindow error:', err.message)
      return false
    }
  }

  capturePlaybackPicture(playbackKey, filePath) {
    const pb = this.activePlaybacks.get(playbackKey)
    if (!pb) return false
    try {
      return addon.capturePlaybackPicture(pb.playbackHandle, filePath)
    } catch (err) {
      console.error('[HCNetService] CapturePlaybackPicture error:', err.message)
      return false
    }
  }
}

const hcnetService = new HCNetService()
module.exports = hcnetService
