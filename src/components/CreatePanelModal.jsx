import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import { useLanguage } from '../i18n/useLanguage'

export default function CreatePanelModal({ onClose }) {
  const { t } = useLanguage()
  const { panels, addPanel, setActivePanel, setActiveView } = useStore()
  const [panelName, setPanelName] = useState('')
  const [cellCount, setCellCount] = useState(4)

  const cols = Math.ceil(Math.sqrt(cellCount))
  const rows = Math.ceil(cellCount / cols)

  const handleSubmit = () => {
    const panel = {
      id: 'panel-' + Date.now(),
      name: panelName || 'Panel ' + (panels.length + 1),
      cellCount,
      cameraSlots: {}
    }
    addPanel(panel)
    setActivePanel(panel.id)
    setActiveView('live')
    onClose()
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="modal"
        style={{
          background: 'rgba(13, 20, 38, 0.95)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: 24,
          width: 380,
        }}
      >
        <div className="modal-title">
          {t('createPanel.title')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="input-group">
            <label className="input-label">{t('createPanel.panelName')}</label>
            <input
              className="input"
              value={panelName}
              onChange={(e) => setPanelName(e.target.value)}
              placeholder={t('createPanel.panelNamePlaceholder')}
            />
          </div>

          <div className="input-group">
            <label className="input-label">{t('createPanel.cameraSlots')}</label>
            <input
              className="input"
              type="number"
              min={1}
              max={25}
              value={cellCount}
              onChange={(e) => {
                const v = Math.max(1, Math.min(25, +e.target.value || 1))
                setCellCount(v)
              }}
            />
          </div>

          {/* Grid preview */}
          <div>
            <label className="input-label" style={{ marginBottom: 8, display: 'block' }}>
              {t('createPanel.previewLayout', { cols, rows })}
            </label>
            <div style={{ height: 120, width: '100%', display: 'flex', justifyContent: 'center' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, 1fr)`,
                  gridTemplateRows: `repeat(${rows}, 1fr)`,
                  gap: 3,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 8,
                  height: '100%',
                  aspectRatio: `${cols} / ${rows}`,
                  maxWidth: '100%',
                }}
              >
                {Array.from({ length: cols * rows }, (_, i) => (
                  <div
                    key={i}
                    style={{
                      borderRadius: 3,
                      background: i < cellCount
                        ? 'var(--accent)'
                        : 'transparent',
                      opacity: i < cellCount ? 0.35 : 0.06,
                      border: i < cellCount
                        ? '1px solid var(--accent)'
                        : '1px solid var(--border)',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {t('createPanel.createBtn')}
          </button>
        </div>
      </div>
    </div>
  )
}
