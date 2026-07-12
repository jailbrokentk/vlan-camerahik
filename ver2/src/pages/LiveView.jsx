import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom'
import { useStore } from '../store/useStore'
import CameraCell from '../components/CameraCell'
import { getAPI } from '../lib/electron'
import { useLanguage } from '../i18n/useLanguage'
import PlaybackView from '../components/PlaybackView'

// Custom PTZPanel component copy to isolate logic within LiveView
function LocalPTZPanel({ deviceId, channelId, onClose }) {
  const api = getAPI()
  const { t } = useLanguage()
  const sendPTZ = (pan, tilt, zoom) => {
    api.hcnetPtzControl(deviceId, channelId, pan, tilt, zoom, false)
  }
  const stop = () => api.hcnetPtzStop(deviceId, channelId)

  const btnProps = (pan, tilt, zoom = 0) => ({
    onMouseDown: () => sendPTZ(pan, tilt, zoom),
    onMouseUp: stop,
    onMouseLeave: stop,
    onTouchStart: () => sendPTZ(pan, tilt, zoom),
    onTouchEnd: stop,
  })

  return (
    <div className="ptz-panel" style={{
      background: 'rgba(20, 20, 30, 0.95)',
      border: '1px solid var(--border-accent)',
      borderRadius: 12,
      padding: 16,
      width: 200,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12,
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      color: '#fff',
      backdropFilter: 'blur(10px)'
    }}>
      <div className="ptz-title" style={{ fontSize: 13, fontWeight: 'bold' }}>{t('camera.ptzControl')}</div>
      <div className="ptz-joystick" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 40px)',
        gridTemplateRows: 'repeat(3, 40px)',
        gap: 6,
        justifyContent: 'center'
      }}>
        <div />
        <button className="ptz-btn" {...btnProps(0, 30)} style={{ cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-hover)', color: '#fff' }}>↑</button>
        <div />
        <button className="ptz-btn" {...btnProps(-30, 0)} style={{ cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-hover)', color: '#fff' }}>←</button>
        <button className="ptz-btn center" onMouseDown={stop} style={{ cursor: 'pointer', borderRadius: '50%', border: 'none', background: 'var(--accent)', color: '#000', fontWeight: 'bold' }}>⬤</button>
        <button className="ptz-btn" {...btnProps(30, 0)} style={{ cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-hover)', color: '#fff' }}>→</button>
        <div />
        <button className="ptz-btn" {...btnProps(0, -30)} style={{ cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-hover)', color: '#fff' }}>↓</button>
        <div />
      </div>
      <div className="ptz-zoom" style={{ display: 'flex', width: '100%', gap: 8 }}>
        <button className="ptz-btn btn-sm" {...btnProps(0, 0, 10)} style={{ flex: 1, padding: 6, cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-hover)', color: '#fff' }}>🔍+</button>
        <button className="ptz-btn btn-sm" {...btnProps(0, 0, -10)} style={{ flex: 1, padding: 6, cursor: 'pointer', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-hover)', color: '#fff' }}>🔍-</button>
      </div>
      <button
        className="btn btn-secondary btn-sm"
        style={{ width: '100%', marginTop: 8 }}
        onClick={onClose}
      >
        {t('common.close')}
      </button>
    </div>
  )
}

export default function LiveView({ panelId }) {
  const panels = useStore(s => s.panels)
  const activePanelId = useStore(s => s.activePanelId)
  const setPanelSlot = useStore(s => s.setPanelSlot)
  const devices = useStore(s => s.devices)
  const language = useStore(s => s.language)
  const { t } = useLanguage()
  const targetPanelId = panelId || activePanelId
  const panel = panels.find(p => p.id === targetPanelId)
  const api = getAPI()
  
  const [fsState, setFsState] = useState({
    phase: 'grid',
    cameraKey: null,
    previousFocusCameraKey: null,
    generation: 0
  })

  // Explicit quality selections keyed by stable cameraKey
  const [explicitQualities, setExplicitQualities] = useState({})

  // Sync quality SD/HD with fullscreen transition states (Double-click or Exit)
  const prevCameraKeyRef = useRef(null)
  useEffect(() => {
    const currentKey = fsState.cameraKey
    const isEnteringOrActive = fsState.phase === 'entering' || fsState.phase === 'camera' || fsState.phase === 'fullscreen'
    
    if (currentKey && isEnteringOrActive) {
      // Enter Fullscreen: upgrade SD -> HD (keep HD if already HD)
      setExplicitQualities(eq => {
        const currentQuality = eq[currentKey] || 'SD'
        if (currentQuality === 'SD') {
          return { ...eq, [currentKey]: 'HD' }
        }
        return eq
      })
    } else if (!currentKey || fsState.phase === 'exiting') {
      // Exit Fullscreen: downgrade HD -> SD
      const prevKey = prevCameraKeyRef.current
      if (prevKey) {
        setExplicitQualities(eq => {
          const currentQuality = eq[prevKey] || 'SD'
          if (currentQuality === 'HD') {
            return { ...eq, [prevKey]: 'SD' }
          }
          return eq
        })
      }
    }
    prevCameraKeyRef.current = currentKey
  }, [fsState.cameraKey, fsState.phase])

  // Panel-level context menu overlays
  const [ptzCamera, setPtzCamera] = useState(null)
  const [playbackCamera, setPlaybackCamera] = useState(null)
  const [toast, setToast] = useState(null)

  // Dispatch global event when playback modal opens/closes to hide live video cells
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('playback-modal-active', { detail: { active: !!playbackCamera } }))
  }, [playbackCamera])

  const showToast = (message, filePath) => {
    setToast({ message, filePath })
    setTimeout(() => setToast(null), 5000)
  }

  // Handle global escape key to close fullscreen
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && fsState.cameraKey && fsState.phase === 'camera') {
        e.preventDefault()
        e.stopPropagation()
        closeCameraFullscreen()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [fsState.cameraKey, fsState.phase])

  // Reset fullscreen state on active panel change
  useEffect(() => {
    setFsState({
      phase: 'grid',
      cameraKey: null,
      previousFocusCameraKey: null,
      generation: 0
    })
  }, [targetPanelId])

  if (!panel) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        {t('liveview.panelNotFound')}
      </div>
    )
  }
  
  const cellCount = panel.cellCount
  const cols = Math.ceil(Math.sqrt(cellCount))
  const rows = Math.ceil(cellCount / cols)

  const toggleCameraFullscreen = (key) => {
    setFsState(prev => {
      const isCurrent = prev.cameraKey === key
      if (isCurrent) {
        return {
          phase: 'exiting',
          cameraKey: prev.cameraKey,
          previousFocusCameraKey: null,
          generation: prev.generation + 1
        }
      } else {
        return {
          phase: 'entering',
          cameraKey: key,
          previousFocusCameraKey: prev.cameraKey,
          generation: prev.generation + 1
        }
      }
    })
  }

  const closeCameraFullscreen = () => {
    setFsState(prev => {
      if (!prev.cameraKey) return prev
      return {
        phase: 'exiting',
        cameraKey: prev.cameraKey,
        previousFocusCameraKey: null,
        generation: prev.generation + 1
      }
    })
  }

  const handleTransitionComplete = (newPhase) => {
    setFsState(prev => {
      return {
        ...prev,
        phase: newPhase,
        cameraKey: newPhase === 'grid' ? null : prev.cameraKey
      }
    })
  }

  // Panel-level right-click menu handler (delegated from cells)
  const handleGridContextMenu = async (e) => {
    e.preventDefault()
    e.stopPropagation()

    const cellEl = e.target.closest('.camera-cell')
    if (!cellEl) return

    const indexAttr = cellEl.getAttribute('data-index')
    if (indexAttr === null) return
    const clickedIndex = parseInt(indexAttr, 10)

    const slot = panel.cameraSlots[clickedIndex]
    if (!slot) return

    const device = devices.find(d => d.id === slot.deviceId)
    const channel = device?.channels.find(c => c.id === slot.channelId)
    const cameraKey = `${targetPanelId}:${clickedIndex}:${slot.deviceId}:${slot.channelId}`
    
    const isMuted = slot.muted !== undefined ? slot.muted : true
    const enableSmart = slot.enableSmart !== undefined ? slot.enableSmart : false
    const resolvedQuality = explicitQualities[cameraKey] || 'SD'

    try {
      const action = await api.showCameraContextMenu({
        isMuted,
        enableSmart,
        resolvedQuality,
        language
      })
      if (!action) return

      if (action === 'snapshot') {
        const snapChannelId = `${slot.channelId}01`
        const result = await api.snapshotSave(slot.deviceId, snapChannelId)
        if (result?.filePath) {
          showToast(`${t('liveview.snapshotSaved')} ${result.filename || result.filePath.split('\\').pop()}`, result.filePath)
        }
      } else if (action === 'ptz') {
        setPtzCamera({ deviceId: slot.deviceId, channelId: slot.channelId })
      } else if (action === 'playback') {
        if (device) {
          setPlaybackCamera({
            id: slot.deviceId + '_' + slot.channelId,
            name: slot.streamName || channel?.channelName || `${t('camera.ch')} ${slot.channelId}`,
            nvrIp: device.ip,
            channel: parseInt(slot.channelId) || 1,
            deviceId: slot.deviceId,
            streamEngine: device.streamEngine
          })
        }
      } else if (action === 'reload') {
        window.dispatchEvent(new CustomEvent('player-reload-cell', { detail: { index: clickedIndex } }))
      } else if (action === 'toggleFullscreen') {
        toggleCameraFullscreen(cameraKey)
      } else if (action === 'unmute' || action === 'mute') {
        setPanelSlot(targetPanelId, clickedIndex, { ...slot, muted: action === 'mute' })
      } else if (action === 'enableSmart' || action === 'disableSmart') {
        setPanelSlot(targetPanelId, clickedIndex, { ...slot, enableSmart: action === 'enableSmart' })
      } else if (action === 'switchToHD' || action === 'switchToSD') {
        const nextQuality = action === 'switchToHD' ? 'HD' : 'SD'
        setExplicitQualities(prev => ({
          ...prev,
          [cameraKey]: nextQuality
        }))
      } else if (action === 'remove') {
        setPanelSlot(targetPanelId, clickedIndex, null)
      }
    } catch (err) {
      console.error('[PANEL CONTEXT MENU] error:', err.message)
    }
  }

  const isAnyFsActive = fsState.cameraKey !== null && (fsState.phase === 'entering' || fsState.phase === 'camera')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      <div style={{ display: 'flex', flex: 1, flexDirection: 'row', overflow: 'hidden' }}>
        <div
          className={`camera-grid ${isAnyFsActive ? 'fullscreen-active' : ''}`}
          onContextMenu={handleGridContextMenu}
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: isAnyFsActive ? '1fr' : `repeat(${cols}, 1fr)`,
            gridTemplateRows: isAnyFsActive ? '1fr' : `repeat(${rows}, 1fr)`,
            gap: isAnyFsActive ? 0 : 2,
            padding: isAnyFsActive ? 0 : 2,
            background: '#000'
          }}
        >
          {Array.from({ length: cellCount }).map((_, i) => {
            const slot = panel.cameraSlots[i]
            const cameraKey = slot ? `${targetPanelId}:${i}:${slot.deviceId}:${slot.channelId}` : `${targetPanelId}:${i}:empty`
            
            // Resolve quality: explicit user selection or default SD
            const explicit = explicitQualities[cameraKey]
            const desiredQuality = explicit || 'SD'
  
            const isAnyFullscreen = fsState.cameraKey !== null && (fsState.phase === 'entering' || fsState.phase === 'camera')
            const isSelected = fsState.cameraKey === cameraKey
            let cellStyle = {}
            if (isAnyFullscreen) {
              if (isSelected) {
                cellStyle = {
                  gridColumn: '1 / -1',
                  gridRow: '1 / -1'
                }
              } else {
                cellStyle = {
                  display: 'none'
                }
              }
            }
  
            return (
              <CameraCell
                key={`${targetPanelId}-${i}`}
                index={i}
                gridSize={cellCount}
                panelId={targetPanelId}
                fullscreenKey={fsState.cameraKey}
                fullscreenPhase={fsState.phase}
                fullscreenGeneration={fsState.generation}
                desiredQuality={desiredQuality}
                style={cellStyle}
                onSetExplicitQuality={(quality) => {
                  setExplicitQualities(prev => ({
                    ...prev,
                    [cameraKey]: quality
                  }))
                }}
                onToggleFullscreen={toggleCameraFullscreen}
                onCloseFullscreen={closeCameraFullscreen}
                onTransitionComplete={handleTransitionComplete}
                onAppFullscreen={(key) => {
                  // 1. Force panel-local fullscreen for this camera cell
                  setFsState({
                    phase: 'camera',
                    cameraKey: key,
                    previousFocusCameraKey: null,
                    generation: fsState.generation + 1
                  })
                  // 2. Set global app-fullscreen to true
                  useStore.getState().setAppFullscreen(true)
                }}
              />
            )
          })}
        </div>
  
        {/* PTZ Panel Drawer bên phải - Nằm cạnh grid video, không bị che bởi native window */}
        {ptzCamera && (
          <div style={{
            width: '240px',
            background: '#16161a',
            borderLeft: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 10,
            boxShadow: '-4px 0 16px rgba(0,0,0,0.35)',
            pointerEvents: 'auto'
          }}>
            <LocalPTZPanel
              deviceId={ptzCamera.deviceId}
              channelId={ptzCamera.channelId}
              onClose={() => setPtzCamera(null)}
            />
          </div>
        )}
      </div>

      {/* Playback View Portal */}
      {playbackCamera && ReactDOM.createPortal(
        <PlaybackView
          camera={playbackCamera}
          onClose={() => setPlaybackCamera(null)}
        />,
        document.body
      )}

      {/* Toast Notification Portal */}
      {toast && ReactDOM.createPortal(
        <div style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          background: 'rgba(26, 26, 46, 0.95)',
          border: '1px solid var(--border-accent)',
          borderRadius: 8,
          padding: '12px 16px',
          fontSize: 12,
          color: '#fff',
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          backdropFilter: 'blur(12px)',
          maxWidth: 400
        }}>
          <span style={{ flex: 1 }}>{toast.message}</span>
          {toast.filePath && (
            <button
              style={{
                background: 'var(--accent)',
                border: 'none',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 11,
                color: '#fff',
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
              onClick={(e) => {
                e.stopPropagation()
                api.showInFolder(toast.filePath)
              }}
            >
              {t('common.openFolder')}
            </button>
          )}
          <button
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}
            onClick={(e) => { e.stopPropagation(); setToast(null) }}
          >✕</button>
        </div>,
        document.body
      )}

    </div>
  )
}
