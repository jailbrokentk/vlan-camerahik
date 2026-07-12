import { useState, useEffect, Component } from 'react'
import { useStore } from './store/useStore'
import { getAPI } from './lib/electron'
import { useLanguage } from './i18n/useLanguage'
import Sidebar from './components/Sidebar'
import LiveView from './pages/LiveView'
import PopoutPanel from './pages/PopoutPanel'
import Playback from './pages/Playback'
import Settings from './pages/Settings'

// Functional wrapper to provide translated text to ErrorBoundary class component
function ErrorBoundaryContent({ error }) {
  const { t } = useLanguage()
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#1a1a2e',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 16, color: '#fff', fontFamily: 'system-ui'
    }}>
      <div style={{ fontSize: 48 }}>⚠️</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{t('errorBoundary.title')}</div>
      <div style={{ fontSize: 12, color: '#f87171', maxWidth: 400, textAlign: 'center' }}>{error}</div>
      <button onClick={() => window.location.reload()} style={{
        marginTop: 12, padding: '8px 24px', background: 'var(--accent)', color: '#fff',
        border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600
      }}>{t('errorBoundary.reload')}</button>
    </div>
  )
}

// Error Boundary to catch render crashes
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: '' }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error: error.message }
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info)
  }
  render() {
    if (this.state.hasError) {
      return <ErrorBoundaryContent error={this.state.error} />
    }
    return this.props.children
  }
}

function getDeviceFingerprint() {
  let fp = localStorage.getItem('deviceFingerprint')
  if (!fp) {
    fp = 'fp_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    localStorage.setItem('deviceFingerprint', fp)
  }
  return fp
}

function AppMain() {
  const api = getAPI()
  const { t } = useLanguage()
  const {
    activeView,
    addAlert,
    devices,
    addDevice,
    updateDevice,
    panels,
    activePanelId,
    updatePanel,
    isLoggedIn,
    setLoggedIn,
    isAppFullscreen,
    setAppFullscreen
  } = useStore()
  const [time, setTime] = useState(new Date())
  const [isConnected, setIsConnected] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // Auth States
  const [isCheckingAuth, setIsCheckingAuth] = useState(true)
  const [isConfigured, setIsConfigured] = useState(false)
  const [loginUser, setLoginUser] = useState('')
  const [loginPass, setLoginPass] = useState('')
  const [regUser, setRegUser] = useState('')
  const [regPass, setRegPass] = useState('')
  const [regConfirmPass, setRegConfirmPass] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  // Clock
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Escape key global listener to exit app-fullscreen
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isAppFullscreen) {
        setAppFullscreen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isAppFullscreen, setAppFullscreen])

  // Alert listener (only run while logged in)
  useEffect(() => {
    if (!api || !isLoggedIn) return
    api.onAlert((alert) => {
      addAlert({
        id: `alert-${Date.now()}`,
        deviceId: alert.ipAddress || 'unknown',
        channelID: alert.channelID,
        dateTime: alert.dateTime || new Date().toISOString(),
        eventType: alert.eventType,
        eventDescription: alert.eventDescription,
        isNew: true
      })
    })
    return () => api.offAlert()
  }, [isLoggedIn])

  // Load saved devices and layout on startup
  useEffect(() => {
    let cancelled = false

    const loadDevicesAndLayout = async () => {
      if (!api) {
        setIsCheckingAuth(false)
        return
      }
      try {
        // Check configuration status & Validate saved token
        const configured = await api.authIsConfigured()
        if (cancelled) return
        setIsConfigured(configured)

        if (configured) {
          const token = localStorage.getItem('appToken')
          if (token) {
            const isValid = await api.authValidate(token, getDeviceFingerprint())
            if (cancelled) return
            if (isValid) {
              setLoggedIn(true)
            } else {
              localStorage.removeItem('appToken')
            }
          }
        }
      } catch (err) {
        console.error('[App] Auth check failed:', err.message)
      } finally {
        if (!cancelled) setIsCheckingAuth(false)
      }

      if (cancelled) return

      try {
        console.log('[App] Fetching saved devices...')
        const saved = await api.storeGet('devices')
        if (cancelled) return
        console.log('[App] Saved devices from store:', saved)
        
        // Load saved panels (or migrate from legacy cameraSlots)
        const savedPanels = await api.storeGet('panels')
        const savedSlots = await api.storeGet('cameraSlots') || {}
        
        const savedResolution = await api.storeGet('streamResolution') || 'SD'
        if (cancelled) return
        useStore.setState({ streamResolution: savedResolution })

        // Load link mode, buffer size and bitrate limit settings
        const savedLinkMode = await api.storeGet('liveLinkMode') ?? 0
        const savedBufferFrames = await api.storeGet('liveBufferFrames') ?? 15
        const savedSdBitrate = await api.storeGet('sdBitrateLimit') ?? 32
        const savedHdBitrate = await api.storeGet('hdBitrateLimit') ?? 256
        
        useStore.setState({ 
          liveLinkMode: savedLinkMode, 
          liveBufferFrames: savedBufferFrames,
          sdBitrateLimit: savedSdBitrate,
          hdBitrateLimit: savedHdBitrate
        })

        // Load saved language preference
        const savedLang = await api.storeGet('language')
        if (savedLang) useStore.getState().setLanguage(savedLang)

        // Restore panels from saved data or migrate legacy slots
        if (savedPanels && savedPanels.length > 0) {
          useStore.setState({ panels: savedPanels, activePanelId: savedPanels[0].id })
        } else if (Object.keys(savedSlots).length > 0) {
          // Migrate legacy cameraSlots into default panel
          const defaultPanel = { id: 'panel-default', name: t('common.default'), cellCount: 25, cameraSlots: savedSlots }
          useStore.setState({ panels: [defaultPanel], activePanelId: 'panel-default' })
          await api.storeSet('panels', [defaultPanel])
        }

        if (saved && saved.length > 0) {
          for (const dev of saved) {
            if (cancelled) return
            try {
              console.log('[App] Auto-connecting to:', dev.ip)
              addDevice({ ...dev, status: 'connecting', channels: dev.channels || [] })
              const result = await api.hikConnect(dev)
              if (cancelled) return
              const channels = await api.hikGetChannels(dev.id)
              if (cancelled) return
              
              updateDevice(dev.id, { status: 'connected', channels: channels || [], deviceInfo: result.deviceInfo })
              
              const currentSaved = await api.storeGet('devices') || []
              const updatedDev = { ...dev, status: 'disconnected', channels: channels || [], deviceInfo: result.deviceInfo }
              const newSaved = currentSaved.map((d) => d.id === dev.id ? updatedDev : d)
              await api.storeSet('devices', newSaved)

              api.hikStartAlertStream(dev.id).catch((e) => console.error('Alert stream failed:', e.message))
            } catch (err) {
              console.error(`[App] Failed to auto-connect to ${dev.ip}:`, err.message)
              if (!cancelled) updateDevice(dev.id, { status: 'disconnected' })
            }
          }
        }

        if (cancelled) return

        // Sync legacy cameraSlots from active panel
        const currentPanels = useStore.getState().panels
        const activeP = currentPanels.find(p => p.id === useStore.getState().activePanelId)
        if (!cancelled && activeP) useStore.setState({ cameraSlots: activeP.cameraSlots })
      } catch (err) {
        console.error('[App] Failed to load saved devices/layout:', err.message)
      }
    }
    loadDevicesAndLayout()

    return () => { cancelled = true }
  }, [])

  // Update connection status
  useEffect(() => {
    setIsConnected(devices.some((d) => d.status === 'connected'))
  }, [devices])

  // Global actions via DOM events
  const handleSnapshotAll = () => {
    window.dispatchEvent(new CustomEvent('player-snapshot-all'))
  }

  const handleRefreshAll = () => {
    window.dispatchEvent(new CustomEvent('player-reconnect-all'))
  }

  // Auth Handlers
  const handleRegister = async (e) => {
    e.preventDefault()
    setErrorMsg('')
    if (!regUser || !regPass || !regConfirmPass) {
      setErrorMsg(t('auth.fillAllFields'))
      return
    }
    if (regPass !== regConfirmPass) {
      setErrorMsg(t('auth.passwordMismatch'))
      return
    }
    try {
      const res = await api.authRegister(regUser, regPass, getDeviceFingerprint())
      if (res.success && res.token) {
        localStorage.setItem('appToken', res.token)
        setIsConfigured(true)
        setLoggedIn(true)
      } else {
        setErrorMsg(res.error || t('auth.registerFailed'))
      }
    } catch (err) {
      setErrorMsg(t('auth.registerError') + ' ' + err.message)
    }
  }

  const handleLogin = async (e) => {
    e.preventDefault()
    setErrorMsg('')
    if (!loginUser || !loginPass) {
      setErrorMsg(t('auth.fillAllFields'))
      return
    }
    try {
      const res = await api.authLogin(loginUser, loginPass, getDeviceFingerprint())
      if (res.success && res.token) {
        localStorage.setItem('appToken', res.token)
        setLoggedIn(true)
      } else {
        setErrorMsg(res.error || t('auth.loginFailed'))
      }
    } catch (err) {
      setErrorMsg(t('auth.loginError') + ' ' + err.message)
    }
  }

  // Beautiful Splash Screen with Cloudflare styling
  if (isCheckingAuth) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        background: '#1a1a2e',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        zIndex: 9999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#fff'
      }}>
        <div style={{
          width: 48,
          height: 48,
          background: 'linear-gradient(135deg, var(--accent), #e2620a)',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 24,
          boxShadow: '0 0 16px rgba(246, 130, 31, 0.3)',
          animation: 'pulse 1s infinite alternate'
        }}>
          📹
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>
          {t('auth.initSecurity')}
        </div>
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes pulse {
            from { transform: scale(1); opacity: 0.8; }
            to { transform: scale(1.08); opacity: 1; }
          }
        `}} />
      </div>
    )
  }

  // Render Login / Register Screen if not logged in
  if (!isLoggedIn) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16161a 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        fontFamily: 'system-ui, -apple-system, sans-serif'
      }}>
        <div style={{
          background: '#1e1e2e',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '40px 32px',
          width: 380,
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 24
        }}>
          {/* Logo Header */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 48,
              height: 48,
              background: 'linear-gradient(135deg, var(--accent), #e2620a)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 24,
              color: '#fff',
              boxShadow: '0 0 16px rgba(246, 130, 31, 0.3)'
            }}>🌐</div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, background: 'linear-gradient(90deg, var(--accent), #fff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              vLAN-CameraHIK
            </h2>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {isConfigured ? t('auth.loginSubtitle') : t('auth.registerSubtitle')}
            </span>
          </div>

          {errorMsg && (
            <div style={{
              background: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.2)',
              color: '#f87171',
              padding: '10px 14px',
              borderRadius: 6,
              fontSize: 12,
              textAlign: 'center',
              fontWeight: 500
            }}>
              ⚠️ {errorMsg}
            </div>
          )}

          {isConfigured ? (
            /* Login Form */
            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('auth.username')}</label>
                <input
                  type="text"
                  className="input"
                  style={{ background: 'var(--bg-base)' }}
                  placeholder={t('auth.usernamePlaceholder')}
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('auth.password')}</label>
                <input
                  type="password"
                  className="input"
                  style={{ background: 'var(--bg-base)' }}
                  placeholder={t('auth.passwordPlaceholder')}
                  value={loginPass}
                  onChange={(e) => setLoginPass(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 8, padding: '10px 16px', fontWeight: 600 }}>
                {t('auth.loginButton')}
              </button>
            </form>
          ) : (
            /* First-time Setup Form */
            <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('auth.adminAccount')}</label>
                <input
                  type="text"
                  className="input"
                  style={{ background: 'var(--bg-base)' }}
                  placeholder={t('auth.adminPlaceholder')}
                  value={regUser}
                  onChange={(e) => setRegUser(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('auth.newPassword')}</label>
                <input
                  type="password"
                  className="input"
                  style={{ background: 'var(--bg-base)' }}
                  placeholder={t('auth.minCharsPlaceholder')}
                  value={regPass}
                  onChange={(e) => setRegPass(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('auth.confirmPassword')}</label>
                <input
                  type="password"
                  className="input"
                  style={{ background: 'var(--bg-base)' }}
                  placeholder={t('auth.confirmPasswordPlaceholder')}
                  value={regConfirmPass}
                  onChange={(e) => setRegConfirmPass(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 10, padding: '10px 16px', fontWeight: 600 }}>
                {t('auth.registerButton')}
              </button>
            </form>
          )}
        </div>
      </div>
    )
  }

  // Main application view after successful login
  return (
    <div className="app-shell">
      {/* Title Bar */}
      {!isAppFullscreen && (
      <div className="titlebar">
        <div className="titlebar-logo">
          <div className="titlebar-logo-icon">🌐</div>
          <span className="titlebar-logo-text">vLAN-CameraHIK</span>
        </div>

        {/* Global Toolbar inside Titlebar (no-drag zone) */}
        {activeView === 'live' && (() => {
          const activePanel = panels.find(p => p.id === activePanelId)
          const cellCount = activePanel?.cellCount || 25
          const currentGrid = cellCount === 1 ? '1x1' :
                              cellCount === 4 ? '2x2' :
                              cellCount === 9 ? '3x3' :
                              cellCount === 16 ? '4x4' :
                              cellCount === 25 ? '5x5' : 'custom'

          const handleSetGrid = (grid) => {
            const counts = {
              '1x1': 1,
              '2x2': 4,
              '3x3': 9,
              '4x4': 16,
              '5x5': 25
            }
            const count = counts[grid]
            if (count) {
              updatePanel(activePanelId, { cellCount: count })
            }
          }

          const handleAddAllCameras = async () => {
            if (!activePanel) return
            const allChannels = []
            for (const dev of devices) {
              // Bỏ qua kiểm tra status connected để đảm bảo add đầy đủ camera hiện có ở menulist
              for (const ch of dev.channels) {
                allChannels.push({
                  deviceId: dev.id,
                  channelId: ch.id,
                  channelName: ch.channelName,
                  device: dev
                })
              }
            }

            if (allChannels.length === 0) return

            const emptySlots = []
            for (let i = 0; i < activePanel.cellCount; i++) {
              if (!activePanel.cameraSlots[i]) {
                emptySlots.push(i)
              }
            }

            if (emptySlots.length === 0) return

            const currentDisplay = new Set(
              Object.values(activePanel.cameraSlots)
                .filter(Boolean)
                .map(s => `${s.deviceId}_${s.channelId}`)
            )
            
            let camerasToAdd = allChannels.filter(
              c => !currentDisplay.has(`${c.deviceId}_${c.channelId}`)
            )

            if (camerasToAdd.length === 0) {
              return
            }

            // Sắp xếp tuần tự và lấy đầy đủ theo thứ tự ô trống thay vì random
            if (camerasToAdd.length > emptySlots.length) {
              camerasToAdd = camerasToAdd.slice(0, emptySlots.length)
            }

            const updatedSlots = { ...activePanel.cameraSlots }

            for (let i = 0; i < camerasToAdd.length; i++) {
              const slotIndex = emptySlots[i]
              const cam = camerasToAdd[i]
              const streamName = cam.channelName || `Camera ${cam.channelId}`

              updatedSlots[slotIndex] = {
                deviceId: cam.deviceId,
                channelId: cam.channelId,
                streamName
              }
            }

            updatePanel(activePanelId, { cameraSlots: updatedSlots })
            useStore.setState({ cameraSlots: updatedSlots })
          }

          const activeSlotsCount = activePanel ? Object.values(activePanel.cameraSlots).filter(s => s && s.deviceId).length : 0

          return (
            <div className="titlebar-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 16, WebkitAppRegion: 'no-drag' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{t('common.panel')}</span>
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, marginRight: 4 }}>
                {activePanel?.name === 'Default' ? t('common.default') : (activePanel?.name || t('common.default'))} ({activeSlotsCount} {t('common.cameras')})
              </span>
              
              <button
                className="btn btn-secondary btn-sm"
                style={{
                  fontSize: 10,
                  padding: '3px 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  height: 22,
                  marginRight: 8,
                  fontWeight: 600
                }}
                onClick={handleAddAllCameras}
                title={t('liveview.quickAddTooltip')}
              >
                {t('liveview.quickAdd')}
              </button>
              
              <div style={{ display: 'flex', background: 'var(--bg-hover)', borderRadius: 4, padding: 2, border: '1px solid var(--border)' }}>
                {['1x1', '2x2', '3x3', '4x4', '5x5'].map((g) => (
                  <button
                    key={g}
                    className={`grid-btn ${currentGrid === g ? 'active' : ''}`}
                    onClick={() => handleSetGrid(g)}
                    style={{
                      padding: '2px 8px',
                      fontSize: 11,
                      border: 'none',
                      background: currentGrid === g ? 'var(--accent)' : 'transparent',
                      color: currentGrid === g ? '#fff' : 'var(--text-secondary)',
                      borderRadius: 3,
                      cursor: 'pointer',
                      fontWeight: 600,
                      transition: 'var(--transition)'
                    }}
                  >
                    {g}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={handleSnapshotAll}
                  className="titlebar-btn"
                  title={t('liveview.snapshotAll')}
                  style={{ fontSize: 12, height: 24, width: 28, background: 'var(--bg-hover)', border: '1px solid var(--border)' }}
                >
                  📸
                </button>
                <button
                  onClick={handleRefreshAll}
                  className="titlebar-btn"
                  title={t('liveview.reloadAll')}
                  style={{ fontSize: 11, height: 24, width: 64, background: 'var(--bg-hover)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, fontWeight: 500 }}
                >
                  {t('liveview.reloadAllBtn')}
                </button>
              </div>
            </div>
          )
        })()}

        <div className="titlebar-drag" />

        <div className="titlebar-status">
          <div className={`status-dot ${isConnected ? 'online' : 'offline'}`} />
          <span>{isConnected ? t('common.connected') : t('common.disconnected')}</span>
          <span style={{ marginLeft: 12, color: 'var(--text-muted)' }}>
            {time.toLocaleTimeString('vi-VN')}
          </span>
        </div>

        <div className="titlebar-controls">
          <button className="titlebar-btn" id="btn-minimize" onClick={() => api?.minimize()} title={t('common.minimize')}>─</button>
          <button className="titlebar-btn" id="btn-maximize" onClick={() => api?.maximize()} title={t('common.maximize')}>□</button>
          <button className="titlebar-btn close" id="btn-close" onClick={() => api?.close()} title={t('common.close')}>✕</button>
        </div>
      </div>
      )}

      {/* Body */}
      <div className="app-body">
        {!isAppFullscreen && (
          <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
        )}

        <main
          className="main-content"
          style={{
            position: 'relative',
            paddingLeft: (sidebarCollapsed && !isAppFullscreen) ? '16px' : '0px',
            transition: 'padding-left 0.2s ease'
          }}
        >
          {sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              style={{
                position: 'absolute',
                left: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 14,
                height: 50,
                background: '#1a1a2e',
                border: '1px solid rgba(255,255,255,0.08)',
                borderLeft: 'none',
                borderRadius: '0 6px 6px 0',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 9,
                boxShadow: '2px 0 8px rgba(0,0,0,0.5)',
                transition: 'background 0.2s, color 0.2s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = '#fff' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#1a1a2e'; e.currentTarget.style.color = 'var(--text-secondary)' }}
              title={t('common.showMenu')}
            >
              ▶
            </button>
          )}
          {activeView === 'live'     && <LiveView />}
          {activeView === 'playback' && <Playback />}
          {activeView === 'settings' && <Settings />}
        </main>
      </div>
    </div>
  )
}

export default function App() {
  const urlParams = new URLSearchParams(window.location.search)
  const popoutPanelId = urlParams.get('popout')

  if (popoutPanelId) {
    return (
      <ErrorBoundary>
        <PopoutPanel panelId={popoutPanelId} />
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <AppMain />
    </ErrorBoundary>
  )
}
