import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import CreatePanelModal from './CreatePanelModal'
import { getAPI } from '../lib/electron'
import { useLanguage } from '../i18n/useLanguage'




export default function Sidebar({ collapsed, onToggle }) {
  const { t } = useLanguage()
  const api = getAPI()

  const VIEWS = [
    { id: 'live',     icon: '📹', label: t('sidebar.liveView') },
    { id: 'playback', icon: '⏮️',  label: t('sidebar.playback') },
    { id: 'settings', icon: '⚙️', label: t('sidebar.settings') },
  ]
  const { activeView, setActiveView, devices, cameraSlots, panels, activePanelId, setActivePanel, removePanel } = useStore()
  const [showCreatePanel, setShowCreatePanel] = useState(false)
  const [contextMenu, setContextMenu] = useState(null)

  const setModalOpen = useStore(state => state.setModalOpen)

  useEffect(() => {
    setModalOpen(showCreatePanel)
    return () => setModalOpen(false)
  }, [showCreatePanel, setModalOpen])

  useEffect(() => {
    const closeMenu = () => setContextMenu(null)
    window.addEventListener('click', closeMenu)
    return () => window.removeEventListener('click', closeMenu)
  }, [])

  const handleContextMenu = (e, panelId) => {
    e.preventDefault()
    if (panels[0]?.id === panelId) return // Default panel cannot be deleted
    const menuW = 130, menuH = 50
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - menuW),
      y: Math.min(e.clientY, window.innerHeight - menuH),
      panelId
    })
  }

  return (
    <>
    <aside
      className="sidebar"
      style={{
        width: collapsed ? 0 : 180,
        minWidth: collapsed ? 0 : 180,
        borderRight: collapsed ? 'none' : '',
        overflow: 'hidden',
        transition: 'width 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-right 0.2s ease'
      }}
    >
      {/* ── Navigation ─────────────────────────────────────── */}
      <div className="sidebar-section-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{t('sidebar.navigation')}</span>
        <button
          onClick={onToggle}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'color 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.color = 'var(--accent)'}
          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
          title={t('common.collapseMenu')}
        >
          ◀
        </button>
      </div>

      {VIEWS.map((v) => (
        <div
          key={v.id}
          id={`nav-${v.id}`}
          className={`sidebar-item ${activeView === v.id ? 'active' : ''}`}
          onClick={() => setActiveView(v.id)}
          role="button"
        >
          <span className="sidebar-item-icon">{v.icon}</span>
          <span>{v.label}</span>
        </div>
      ))}

      <div className="sidebar-divider" />

      {/* ── Panel Manager ─────────────────────────────────── */}
      <div className="sidebar-section-label">{t('sidebar.panels')}</div>

      <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {panels.map((panel) => (
          <div
            key={panel.id}
            className={activePanelId === panel.id ? 'sidebar-item active' : 'sidebar-item'}
            onClick={() => { setActivePanel(panel.id); setActiveView('live') }}
            onContextMenu={(e) => handleContextMenu(e, panel.id)}
            style={{ userSelect: 'none' }}
          >
            <span>📺</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{panel.name}</span>
            <span className="badge badge-info" style={{ fontSize: 9 }}>{panel.cellCount}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 4, padding: '4px 0' }}>
          <button
            className="btn btn-secondary btn-sm"
            style={{ flex: 1, fontSize: 10 }}
            onClick={() => setShowCreatePanel(true)}
          >{t('sidebar.createPanel')}</button>
          <button
            className="btn btn-secondary btn-sm"
            style={{ fontSize: 10 }}
            onClick={() => api.openPopout(activePanelId)}
            title={t('sidebar.openPopout')}
          >⧉</button>
        </div>
      </div>

      <div className="sidebar-divider" />

      {/* ── Camera list (scrollable) ──────────────────────── */}
      <div className="sidebar-section-label">{t('sidebar.cameraList')}</div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {devices.length === 0 ? (
          <div style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            {t('sidebar.noDevices')}<br />
            {t('sidebar.goToSettings')}
          </div>
        ) : (
          devices.map((device) => (
            <div key={device.id}>
              {/* Device header */}
              <div style={{
                padding: '7px 12px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                borderBottom: '1px solid var(--border)',
                background: 'rgba(255,255,255,0.02)'
              }}>
                <div className="status-dot" style={{
                  background: device.status === 'connected' ? 'var(--success)' : 'var(--text-muted)'
                }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {device.name}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {device.channels.length}ch
                </span>
              </div>

              {/* Channel list */}
              {device.channels.map((ch) => {
                const isOnGrid = Object.values(cameraSlots).some(
                  (s) => s && s.deviceId === device.id && s.channelId === ch.id
                )
                return (
                  <div
                    key={ch.id}
                    draggable={true}

                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/json', JSON.stringify({
                        type: 'sidebar-camera',
                        deviceId: device.id,
                        channelId: ch.id,
                        name: ch.channelName
                      }))
                    }}
                    onDoubleClick={() => {
                      const { setPanelSlot, activePanelId, focusedCellIndex, activeView, onChangeCamera } = useStore.getState();
                      
                      const newSlot = {
                        deviceId: device.id,
                        channelId: ch.id,
                        streamName: ch.channelName,
                        resolution: 'SD'
                      };

                      if (activeView === 'live') {
                        setPanelSlot(activePanelId, focusedCellIndex, newSlot);
                      }
                    }}
                    style={{
                      padding: '6px 10px 6px 18px',
                      fontSize: 11,
                      color: isOnGrid ? 'var(--text-muted)' : 'var(--text-secondary)',
                      cursor: 'grab',
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      transition: 'var(--transition)',
                      background: isOnGrid ? 'rgba(255, 255, 255, 0.02)' : '',
                      opacity: isOnGrid ? 0.5 : 1
                    }}
                    onMouseEnter={(e) => {
                      if (!isOnGrid) e.currentTarget.style.background = 'var(--bg-hover)'
                    }}
                    onMouseLeave={(e) => {
                      if (!isOnGrid) e.currentTarget.style.background = ''
                    }}
                  >
                    {isOnGrid ? (
                      <span style={{ color: '#4caf50', fontSize: 12, flexShrink: 0 }}>✔</span>
                    ) : (
                      <span style={{ opacity: 0.4, fontSize: 10 }}>⋮⋮</span>
                    )}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ch.channelName}
                    </span>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>

    </aside>

    {showCreatePanel && <CreatePanelModal onClose={() => setShowCreatePanel(false)} />}

    {contextMenu && (
      <div
        style={{
          position: 'fixed',
          top: contextMenu.y,
          left: contextMenu.x,
          background: 'rgba(20, 27, 48, 0.95)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 6,
          padding: '4px 0',
          zIndex: 99999,
          minWidth: 110,
          boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '8px 12px',
            fontSize: 11,
            color: '#ff4444',
            cursor: 'pointer',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            transition: 'background 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,68,68,0.1)'}
          onMouseLeave={(e) => e.currentTarget.style.background = ''}
          onClick={() => {
            removePanel(contextMenu.panelId)
            setContextMenu(null)
          }}
        >
          {t('sidebar.deletePanel')}
        </div>
      </div>
    )}
    </>
  )
}
