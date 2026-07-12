console.log('[Preload] Loading...')
const { ipcRenderer } = require('electron')

// Assign directly to window (works with contextIsolation: false)
window.electronAPI = {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  openPopout: (panelId) => ipcRenderer.send('window:open-popout', panelId),
  setFullscreen: (flag) => ipcRenderer.send('window:set-fullscreen', flag),
  showCameraContextMenu: (options) => ipcRenderer.invoke('show-camera-context-menu', options),

  // ISAPI / Hikvision
  hikConnect: (device) => ipcRenderer.invoke('hik:connect', device),
  hikGetDeviceInfo: (deviceId) => ipcRenderer.invoke('hik:getDeviceInfo', deviceId),
  hikGetChannels: (deviceId) => ipcRenderer.invoke('hik:getChannels', deviceId),
  hikGetIPChannels: (deviceId) => ipcRenderer.invoke('hik:getIPChannels', deviceId),
  hikSnapshot: (deviceId, channelId) => ipcRenderer.invoke('hik:snapshot', deviceId, channelId),
  hikPtzControl: (deviceId, channelId, pan, tilt, zoom) =>
    ipcRenderer.invoke('hik:ptzControl', deviceId, channelId, pan, tilt, zoom),
  hikPtzStop: (deviceId, channelId) => ipcRenderer.invoke('hik:ptzStop', deviceId, channelId),
  hikSearchRecordings: (deviceId, trackId, startTime, endTime) =>
    ipcRenderer.invoke('hik:searchRecordings', deviceId, trackId, startTime, endTime),
  hikStartAlertStream: (deviceId) => ipcRenderer.invoke('hik:startAlertStream', deviceId),
  hikStopAlertStream: (deviceId) => ipcRenderer.invoke('hik:stopAlertStream', deviceId),
  hikDisconnect: (deviceId) => ipcRenderer.invoke('hik:disconnect', deviceId),
  onAlert: (callback) => ipcRenderer.on('hik:alert', (_e, alert) => callback(alert)),
  offAlert: () => ipcRenderer.removeAllListeners('hik:alert'),

  // System / Performance
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getProcessMemory: () => process.memoryUsage(),

  // File operations
  snapshotSave: (deviceId, channelId) => ipcRenderer.invoke('snapshot:save', deviceId, channelId),
  recordingDownload: (deviceId, channelId, startTime, endTime) => ipcRenderer.invoke('recording:download', deviceId, channelId, startTime, endTime),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  openFolder: (folderPath) => ipcRenderer.invoke('shell:openPath', folderPath),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),
  getDefaultPaths: () => ipcRenderer.invoke('app:getDefaultPaths'),

  // Config store
  storeGet: (key) => ipcRenderer.invoke('store:get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),
  storeDelete: (key) => ipcRenderer.invoke('store:delete', key),

  // Auth API
  authRegister: (username, password, fingerprint) => ipcRenderer.invoke('auth:register', username, password, fingerprint),
  authLogin: (username, password, fingerprint) => ipcRenderer.invoke('auth:login', username, password, fingerprint),
  authValidate: (token, fingerprint) => ipcRenderer.invoke('auth:validate', token, fingerprint),
  authLogout: (fingerprint) => ipcRenderer.invoke('auth:logout', fingerprint),
  authIsConfigured: () => ipcRenderer.invoke('auth:isConfigured'),

  // Playback & Clip Download
  searchNvrRecordings: (nvrIp, channel, startTime, endTime) =>
    ipcRenderer.invoke('search-nvr-recordings', nvrIp, channel, startTime, endTime),
  downloadFile: (options) =>
    ipcRenderer.invoke('download-file', options),
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', callback);
    return () => {
      ipcRenderer.removeListener('download-progress', callback);
    };
  },

  // HCNetSDK Native Engine
  hcnetIsAvailable: () => ipcRenderer.invoke('hcnet:isAvailable'),
  hcnetGetAddonError: () => ipcRenderer.invoke('hcnet:getAddonError'),
  hcnetTestConnection: (ip, port, username, password) =>
    ipcRenderer.invoke('hcnet:testConnection', ip, port, username, password),
  hcnetStartPlay: (deviceId, channelId, streamType, x, y, w, h, enableSmart, linkMode, bufNum, bitrateLimitKBps, initialDecodeFrameType) =>
    ipcRenderer.invoke('hcnet:startPlay', deviceId, channelId, streamType, x, y, w, h, enableSmart, linkMode, bufNum, bitrateLimitKBps, initialDecodeFrameType),
  hcnetStopPlay: (streamKey) => ipcRenderer.invoke('hcnet:stopPlay', streamKey),
  hcnetMoveWindow: (childHwnd, x, y, w, h) =>
    ipcRenderer.invoke('hcnet:moveWindow', childHwnd, x, y, w, h),
  hcnetSetWindowVisible: (childHwnd, visible) =>
    ipcRenderer.invoke('hcnet:setWindowVisible', childHwnd, visible),
  hcnetSetRenderPrivateData: (previewHandle, enable) =>
    ipcRenderer.invoke('hcnet:setRenderPrivateData', previewHandle, enable),
  hcnetSetAudioEnabled: (previewHandle, enabled) =>
    ipcRenderer.invoke('hcnet:setAudioEnabled', previewHandle, enabled),
  hcnetStartPlayback: (deviceId, channelId, startTimeStr, endTimeStr, x, y, w, h) =>
    ipcRenderer.invoke('hcnet:startPlayback', deviceId, channelId, startTimeStr, endTimeStr, x, y, w, h),
  hcnetStopPlayback: (playbackKey) => ipcRenderer.invoke('hcnet:stopPlayback', playbackKey),
  hcnetControlPlayback: (playbackKey, cmd, param) =>
    ipcRenderer.invoke('hcnet:controlPlayback', playbackKey, cmd, param),
  hcnetGetPlaybackTime: (playbackKey) => ipcRenderer.invoke('hcnet:getPlaybackTime', playbackKey),
  hcnetSeekPlaybackTime: (playbackKey, timeObj) => ipcRenderer.invoke('hcnet:seekPlaybackTime', playbackKey, timeObj),
  hcnetGetPlaybackProgress: (playbackKey) => ipcRenderer.invoke('hcnet:getPlaybackProgress', playbackKey),
  hcnetSetPlaybackAudio: (playbackKey, enable) => ipcRenderer.invoke('hcnet:setPlaybackAudio', playbackKey, enable),
  hcnetSetPlaybackRenderPrivateData: (playbackKey, enable) =>
    ipcRenderer.invoke('hcnet:setPlaybackRenderPrivateData', playbackKey, enable),
  hcnetSetWindowClip: (childHwnd, left, top, right, bottom) =>
    ipcRenderer.invoke('hcnet:setWindowClip', childHwnd, left, top, right, bottom),
  hcnetRedrawWindow: (childHwnd) => ipcRenderer.invoke('hcnet:redrawWindow', childHwnd),
  hcnetPlaybackSnapshot: (playbackKey, channelId) =>
    ipcRenderer.invoke('playback:snapshot', playbackKey, channelId),
  hcnetPtzControl: (deviceId, channelId, pan, tilt, zoom, stop) =>
    ipcRenderer.invoke('hcnet:ptzControl', deviceId, channelId, pan, tilt, zoom, stop),
  hcnetPtzStop: (deviceId, channelId) => ipcRenderer.invoke('hcnet:ptzStop', deviceId, channelId),
  hcnetGetStreamStats: (fullscreenUiKey, focusedUiKey) => ipcRenderer.invoke('hcnet:getStreamStats', fullscreenUiKey, focusedUiKey),
}

console.log('[Preload] electronAPI injected OK, keys:', Object.keys(window.electronAPI).length)
