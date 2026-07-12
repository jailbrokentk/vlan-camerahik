/**
 * Browser-based API client — calls Express server instead of Electron IPC
 */

const API_BASE = `http://${window.location.hostname}:3001/api`

async function apiCall(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export function getAPI() {
  if (typeof window !== 'undefined' && window.electronAPI) {
    return window.electronAPI
  }
  return {
    // Window controls (no-op in browser)
    minimize: () => {},
    maximize: () => {},
    close: () => { window.close() },
    setFullscreen: (_flag) => {},

    // ISAPI / Hikvision
    hikConnect: (device) =>
      apiCall('/hik/connect', { method: 'POST', body: JSON.stringify(device) }),

    hikGetDeviceInfo: (deviceId) =>
      apiCall(`/hik/device-info/${deviceId}`),

    hikGetChannels: (deviceId) =>
      apiCall(`/hik/channels/${deviceId}`),

    hikGetIPChannels: (deviceId) =>
      apiCall(`/hik/ip-channels/${deviceId}`),

    hikSnapshot: (deviceId, channelId) =>
      apiCall(`/hik/snapshot/${deviceId}/${channelId}`).then(r => r.data),

    hikPtzControl: (deviceId, channelId, pan, tilt, zoom) =>
      apiCall(`/hik/ptz/${deviceId}/${channelId}`, {
        method: 'POST', body: JSON.stringify({ pan, tilt, zoom })
      }),

    hikPtzStop: (deviceId, channelId) =>
      apiCall(`/hik/ptz-stop/${deviceId}/${channelId}`, { method: 'POST' }),

    hikSearchRecordings: (deviceId, trackId, startTime, endTime) =>
      apiCall('/hik/search-recordings', {
        method: 'POST', body: JSON.stringify({ deviceId, trackId, startTime, endTime })
      }),

    hikStartAlertStream: (deviceId) =>
      apiCall(`/hik/start-alert/${deviceId}`, { method: 'POST' }),

    hikStopAlertStream: (deviceId) =>
      apiCall(`/hik/stop-alert/${deviceId}`, { method: 'POST' }),

    onAlert: (callback) => {
      let lastFetchedIds = new Set()
      const interval = setInterval(async () => {
        try {
          const alerts = await apiCall('/hik/alerts')
          if (Array.isArray(alerts)) {
            alerts.forEach((alert) => {
              if (!lastFetchedIds.has(alert.id)) {
                lastFetchedIds.add(alert.id)
                callback(alert)
              }
            })
            if (lastFetchedIds.size > 1000) {
              const arr = Array.from(lastFetchedIds)
              lastFetchedIds = new Set(arr.slice(-500))
            }
          }
        } catch (e) {
          console.error('[Alert Polling] Failed to fetch alerts:', e)
        }
      }, 3000)
      window.__alertInterval = interval
    },
    offAlert: () => {
      if (window.__alertInterval) {
        clearInterval(window.__alertInterval)
        delete window.__alertInterval
      }
    },
    alertsClear: () =>
      apiCall('/hik/alerts', { method: 'DELETE' }),

    // Store
    storeGet: (key) =>
      apiCall(`/store/${key}`),

    storeSet: (key, value) =>
      apiCall(`/store/${key}`, { method: 'POST', body: JSON.stringify({ value }) }),

    storeDelete: (key) =>
      apiCall(`/store/${key}`, { method: 'DELETE' }),

    // Auth API
    authRegister: (username, password, fingerprint) =>
      apiCall('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, fingerprint }) }),

    authLogin: (username, password, fingerprint) =>
      apiCall('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, fingerprint }) }),

    authValidate: (token, fingerprint) =>
      apiCall('/auth/validate', { method: 'POST', body: JSON.stringify({ token, fingerprint }) }),

    authLogout: (fingerprint) =>
      apiCall('/auth/logout', { method: 'POST', body: JSON.stringify({ fingerprint }) }),

    authIsConfigured: () =>
      apiCall('/auth/is-configured'),

    openPopout: (panelId) => {
      if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.openPopout === 'function') {
        window.electronAPI.openPopout(panelId)
      } else {
        window.open(`/?popout=${panelId}`, `panel-${panelId}`, 'width=1280,height=720,menubar=no,toolbar=no')
      }
    },

    // File operations
    snapshotSave: (deviceId, channelId) =>
      apiCall('/snapshot/save', { method: 'POST', body: JSON.stringify({ deviceId, channelId }) }),

    recordingDownload: (deviceId, channelId, startTime, endTime) =>
      apiCall('/recording/download', { method: 'POST', body: JSON.stringify({ deviceId, channelId, startTime, endTime }) }),

    selectFolder: () => Promise.resolve(null),
    openFolder: (_path) => {},
    showInFolder: (_path) => {},
    getDefaultPaths: () => Promise.resolve({
      snapshotPath: '',
      recordingPath: ''
    }),

    // HCNetSDK Native Engine Fallbacks
    hcnetIsAvailable: () => Promise.resolve(false),
    hcnetGetAddonError: () => Promise.resolve('Fallback in browser mode'),
    hcnetTestConnection: () => Promise.resolve({ success: false, error: 'Not running in Electron' }),
    hcnetStartPlay: (deviceId, channelId, streamType, x, y, w, h, enableSmart) => Promise.resolve({ previewHandle: -1, childHwnd: null }),
    hcnetStopPlay: (streamKey) => Promise.resolve(true),
    hcnetMoveWindow: (childHwnd, x, y, w, h) => Promise.resolve(true),
    hcnetSetWindowVisible: (childHwnd, visible) => Promise.resolve(true),
    hcnetSetRenderPrivateData: (previewHandle, enable) => Promise.resolve(true),
    hcnetSetAudioEnabled: (previewHandle, enabled) => Promise.resolve(true),
    hcnetStartPlayback: (deviceId, channelId, startTimeStr, endTimeStr, x, y, w, h) => Promise.resolve({ playbackHandle: -1, childHwnd: null }),
    hcnetStopPlayback: () => Promise.resolve(true),
    hcnetControlPlayback: () => Promise.resolve(true),
    hcnetPtzControl: () => Promise.resolve(true),
    hcnetPtzStop: () => Promise.resolve(true),
    hcnetGetStreamStats: (fullscreenUiKey) => Promise.resolve({}),
  }
}
