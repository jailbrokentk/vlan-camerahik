import { create } from 'zustand'
import { getAPI } from '../lib/electron'

const DEFAULT_PANEL_ID = 'panel-default'

function _savePanels(panels) {
  const api = getAPI()
  if (api) {
    api.storeSet('panels', panels).catch((e) => console.error('Failed to save panels:', e))
  }
}

export const useStore = create((set, get) => ({
  devices: [],
  addDevice: (device) => set((s) => {
    const existing = s.devices.find((d) => d.id === device.id)
    if (existing) {
      // Update existing device instead of silently ignoring
      return { devices: s.devices.map((d) => (d.id === device.id ? { ...d, ...device } : d)) }
    }
    return { devices: [...s.devices, device] }
  }),
  updateDevice: (id, updates) =>
    set((s) => ({
      devices: s.devices.map((d) => (d.id === id ? { ...d, ...updates } : d))
    })),
  removeDevice: (id) => set((s) => {
    const api = getAPI()
    if (api && typeof api.hikDisconnect === 'function') {
      api.hikDisconnect(id).catch((e) => console.error('Failed to disconnect device:', e))
    }
    // Clean up camera slots that reference this device across all panels
    const newPanels = s.panels.map((p) => {
      const hasStaleSlot = Object.values(p.cameraSlots).some((slot) => slot?.deviceId === id)
      if (!hasStaleSlot) return p
      const cleanedSlots = {}
      for (const [key, slot] of Object.entries(p.cameraSlots)) {
        cleanedSlots[Number(key)] = slot?.deviceId === id ? null : slot
      }
      return { ...p, cameraSlots: cleanedSlots }
    })
    const panelsChanged = newPanels.some((p, i) => p !== s.panels[i])
    if (panelsChanged) _savePanels(newPanels)
    const activePanel = newPanels.find((p) => p.id === s.activePanelId)
    return {
      devices: s.devices.filter((d) => d.id !== id),
      panels: newPanels,
      cameraSlots: activePanel?.cameraSlots || s.cameraSlots
    }
  }),

  activeView: 'live',
  setActiveView: (view) => set({ activeView: view }),

  // ── Multi-Panel System ────────────────────────────────────────────────────
  panels: [{
    id: DEFAULT_PANEL_ID,
    name: 'Default',
    cellCount: 25,
    cameraSlots: {}
  }],
  activePanelId: DEFAULT_PANEL_ID,

  addPanel: (panel) => set((s) => {
    const newPanels = [...s.panels, panel]
    _savePanels(newPanels)
    return { panels: newPanels }
  }),

  updatePanel: (id, updates) => set((s) => {
    const newPanels = s.panels.map((p) => (p.id === id ? { ...p, ...updates } : p))
    _savePanels(newPanels)
    if (id === s.activePanelId) {
      return {
        panels: newPanels,
        cameraSlots: updates.cameraSlots !== undefined ? updates.cameraSlots : s.cameraSlots
      }
    }
    return { panels: newPanels }
  }),

  removePanel: (id) => set((s) => {
    if (s.panels.length <= 1) return s
    if (s.panels[0].id === id) return s // Prevent deleting the first (default) panel
    const newPanels = s.panels.filter((p) => p.id !== id)
    const newActiveId = s.activePanelId === id ? newPanels[0].id : s.activePanelId
    _savePanels(newPanels)
    const activePanel = newPanels.find((p) => p.id === newActiveId)
    return { panels: newPanels, activePanelId: newActiveId, cameraSlots: activePanel?.cameraSlots || {}, focusedCellIndex: 0 }
  }),

  setActivePanel: (id) => set((s) => {
    const panel = s.panels.find(p => p.id === id)
    return { activePanelId: id, cameraSlots: panel?.cameraSlots || {}, focusedCellIndex: 0 }
  }),

  setPanelSlot: (panelId, index, slot) => set((s) => {
    const newPanels = s.panels.map((p) => {
      if (p.id !== panelId) return p
      return { ...p, cameraSlots: { ...p.cameraSlots, [index]: slot } }
    })
    _savePanels(newPanels)
    const activePanel = newPanels.find(p => p.id === s.activePanelId)
    return { panels: newPanels, cameraSlots: activePanel?.cameraSlots || {} }
  }),

  swapPanelSlots: (panelId, indexA, indexB) => set((s) => {
    const newPanels = s.panels.map((p) => {
      if (p.id !== panelId) return p
      const slotA = p.cameraSlots[indexA]
      const slotB = p.cameraSlots[indexB]
      const newSlots = { ...p.cameraSlots }
      if (slotB === undefined) {
        delete newSlots[indexA]
      } else {
        newSlots[indexA] = slotB
      }
      if (slotA === undefined) {
        delete newSlots[indexB]
      } else {
        newSlots[indexB] = slotA
      }
      return { ...p, cameraSlots: newSlots }
    })
    _savePanels(newPanels)
    const activePanel = newPanels.find(p => p.id === s.activePanelId)
    return { panels: newPanels, cameraSlots: activePanel?.cameraSlots || {} }
  }),

  // Click-to-move cell state (replaces HTML5 drag for cell-to-cell swaps)
  movingCellIndex: null,
  movingPanelId: null,
  setMovingCell: (panelId, index) => set({ movingCellIndex: index, movingPanelId: panelId }),
  clearMovingCell: () => set({ movingCellIndex: null, movingPanelId: null }),

  streamResolution: 'SD',
  setStreamResolution: (streamResolution) => set(() => {
    const api = getAPI()
    if (api) {
      api.storeSet('streamResolution', streamResolution).catch((e) => console.error('Failed to save resolution:', e))
    }
    return { streamResolution }
  }),

  liveLinkMode: 0,
  setLiveLinkMode: (liveLinkMode) => set(() => {
    const api = getAPI()
    if (api) {
      api.storeSet('liveLinkMode', liveLinkMode).catch((e) => console.error('Failed to save linkMode:', e))
    }
    return { liveLinkMode }
  }),

  liveBufferFrames: 3,
  setLiveBufferFrames: (liveBufferFrames) => set(() => {
    const api = getAPI()
    if (api) {
      api.storeSet('liveBufferFrames', liveBufferFrames).catch((e) => console.error('Failed to save buffer frames:', e))
    }
    return { liveBufferFrames }
  }),

  cameraSlots: {},
  setCameraSlot: (index, slot) => set((s) => {
    const panelId = s.activePanelId
    const newPanels = s.panels.map((p) => {
      if (p.id !== panelId) return p
      return { ...p, cameraSlots: { ...p.cameraSlots, [index]: slot } }
    })
    _savePanels(newPanels)
    const activePanel = newPanels.find(p => p.id === panelId)
    return { panels: newPanels, cameraSlots: activePanel?.cameraSlots || {} }
  }),

  isLoggedIn: false,
  setLoggedIn: (isLoggedIn) => set(() => {
    if (!isLoggedIn) {
      localStorage.removeItem('appToken')
      const api = getAPI()
      if (api) {
        const fingerprint = localStorage.getItem('deviceFingerprint') || ''
        api.authLogout(fingerprint).catch((e) => console.error('Failed to logout:', e))
      }
    }
    return { isLoggedIn }
  }),

  alerts: [],
  unreadAlertCount: 0,
  addAlert: (alert) =>
    set((s) => {
      const alertTime = new Date(alert.dateTime).getTime()
      const isDuplicate = s.alerts.some(existing =>
        existing.eventType === alert.eventType &&
        existing.deviceId === alert.deviceId &&
        existing.channelID === alert.channelID &&
        Math.abs(new Date(existing.dateTime).getTime() - alertTime) < 30000
      )
      if (isDuplicate) return s
      return {
        alerts: [alert, ...s.alerts].slice(0, 200),
        unreadAlertCount: s.unreadAlertCount + 1
      }
    }),
  clearAlerts: () => set(() => {
    const api = getAPI()
    if (api && typeof api.alertsClear === 'function') {
      api.alertsClear().catch((e) => console.error('Failed to clear alerts on server:', e))
    }
    return { alerts: [], unreadAlertCount: 0 }
  }),
  markAlertsRead: () => set({ unreadAlertCount: 0 }),
  isModalOpen: false,
  setModalOpen: (isModalOpen) => set({ isModalOpen }),
  isAppFullscreen: false,
  setAppFullscreen: (isAppFullscreen) => set(() => {
    const api = getAPI()
    if (api && typeof api.setFullscreen === 'function') {
      api.setFullscreen(isAppFullscreen)
    }
    return { isAppFullscreen }
  }),
  focusedCellIndex: 0,
  setFocusedCellIndex: (focusedCellIndex) => set({ focusedCellIndex }),

  // ── Language / i18n ────────────────────────────────────────────────────────
  language: 'en',
  setLanguage: (language) => {
    const api = getAPI()
    if (api) api.storeSet('language', language).catch((e) => console.error('Failed to save language:', e))
    set({ language })
  },
}))
