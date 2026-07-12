import React, { useEffect, useState, useCallback } from 'react'
import LiveView from './LiveView'
import { useStore } from '../store/useStore'
import { getAPI } from '../lib/electron'
import { useLanguage } from '../i18n/useLanguage'
import '../index.css'

export default function PopoutPanel({ panelId }) {
  const { t } = useLanguage()
  const { panels, isAppFullscreen, setAppFullscreen } = useStore()
  const panel = panels.find(p => p.id === panelId)
  const [loaded, setLoaded] = useState(false)
  const api = getAPI()

  // Function to toggle fullscreen state
  const toggleFullscreen = useCallback((flag) => {
    setAppFullscreen(flag)
  }, [setAppFullscreen])

  useEffect(() => {
    // Listen for Escape key to exit fullscreen
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        toggleFullscreen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    // Load panels from server if not already loaded
    const loadPanels = async () => {
      try {
        if (api) {
          const savedPanels = await api.storeGet('panels')
          if (savedPanels && savedPanels.length > 0) {
            useStore.setState({ panels: savedPanels })
          }
          const savedResolution = await api.storeGet('streamResolution') || 'SD'
          useStore.setState({ streamResolution: savedResolution })
          
          // Load and connect devices
          const saved = await api.storeGet('devices')
          if (saved && saved.length > 0) {
            for (const dev of saved) {
              try {
                await api.hikConnect(dev)
                const channels = await api.hikGetChannels(dev.id)
                useStore.getState().addDevice({ ...dev, status: 'connected', channels: channels || [] })
              } catch (e) {
                useStore.getState().addDevice({ ...dev, status: 'disconnected', channels: dev.channels || [] })
              }
            }
          }
        }
      } catch (e) {
        console.error('[PopoutPanel] Load error:', e)
      } finally {
        setLoaded(true)
      }
    }
    loadPanels()

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [panelId, toggleFullscreen])

  if (!loaded) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: 'system-ui' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32 }}>📹</div>
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>{t('popout.loading')}</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      
      {/* Custom Titlebar / Topbar - Hidden in Fullscreen mode */}
      {!isAppFullscreen && (
        <div style={{
          height: 32,
          background: '#16161a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          fontSize: 11,
          color: 'var(--text-secondary)',
          borderBottom: '1px solid var(--border)',
          userSelect: 'none',
          WebkitAppRegion: 'drag', // Allows dragging the window
          flexShrink: 0
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>📺</span>
            <span style={{ fontWeight: 600 }}>{panel?.name || panelId}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>({panel?.cellCount || '?'} {t('common.cameras')})</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, WebkitAppRegion: 'no-drag' }}>
            {/* Fullscreen Button */}
            <button 
              onClick={() => toggleFullscreen(true)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: '4px 8px',
                fontSize: 11,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 4
              }}
              title={t('popout.fullscreenTooltip')}
              className="hover-bright"
            >
              <span>🖵</span> {t('popout.fullscreenBtn')}
            </button>
            <div style={{ width: 1, height: 12, background: 'var(--border)' }} />
            
            {/* Window action buttons */}
            <button onClick={() => api.minimize()} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 6px' }} title={t('common.minimize')}>🗕</button>
            <button onClick={() => api.maximize()} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 6px' }} title={t('common.maximize')}>🗖</button>
            <button onClick={() => api.close()} style={{ background: 'transparent', border: 'none', color: '#ff4d4d', cursor: 'pointer', padding: '4px 6px' }} title={t('common.close')}>✕</button>
          </div>
        </div>
      )}



      {/* Cameras Grid Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <LiveView panelId={panelId} />
      </div>
    </div>
  )
}
