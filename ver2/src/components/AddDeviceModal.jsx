import React, { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { getAPI } from '../lib/electron'
import { useLanguage } from '../i18n/useLanguage'

export default function AddDeviceModal({ onClose, deviceToEdit }) {
  const { t } = useLanguage()
  const { devices, addDevice, updateDevice } = useStore()
  const [form, setForm] = useState({
    name: 'DVR Hikvision',
    ip: '',
    vendor: 'hikvision',
    streamEngine: 'hcnet',
    port: 80,
    sdkPort: 8000,
    username: 'admin',
    password: '',
    linkMode: 0
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isAddonAvailable, setIsAddonAvailable] = useState(true)
  const [addonDiagnosticError, setAddonDiagnosticError] = useState('')
  const [showDiagnostics, setShowDiagnostics] = useState(false)

  useEffect(() => {
    if (deviceToEdit) {
      setForm({
        name: deviceToEdit.name || 'DVR Hikvision',
        ip: deviceToEdit.ip || '',
        vendor: deviceToEdit.vendor || 'hikvision',
        streamEngine: deviceToEdit.streamEngine || 'hcnet',
        port: deviceToEdit.port || 80,
        sdkPort: deviceToEdit.sdkPort || 8000,
        username: deviceToEdit.username || 'admin',
        password: deviceToEdit.password || '',
        linkMode: deviceToEdit.linkMode ?? 0
      })
    }
  }, [deviceToEdit])

  useEffect(() => {
    const checkAddon = async () => {
      const api = getAPI()
      if (api) {
        try {
          const available = await api.hcnetIsAvailable()
          setIsAddonAvailable(available)
          if (!available) {
            const errMsg = await api.hcnetGetAddonError()
            setAddonDiagnosticError(errMsg)
          }
        } catch (e) {
          console.error('[AddDeviceModal] Failed to query addon status:', e)
        }
      }
    }
    checkAddon()
  }, [])

  const handleChange = (e) => {
     const { name, value } = e.target
     const nextValue = name === 'port' || name === 'sdkPort' || name === 'linkMode' ? +value : value
     setForm((f) => ({ ...f, [name]: nextValue }))
   }

  const handleConnect = async () => {
    setLoading(true)
    setError('')
    const api = getAPI()
    if (!api) {
      setError(t('addDevice.apiNotReady'))
      setLoading(false)
      return
    }
    try {
      const id = deviceToEdit ? deviceToEdit.id : (devices.find((d) => d.ip === form.ip)?.id || `device-${Date.now()}`)
      const isExisting = devices.some((d) => d.id === id)

      if (isExisting) {
        try {
          await api.hikStopAlertStream(id)
        } catch (e) {}
      }

      let channels = []
      let deviceInfo = undefined

      // Test connection using native SDK
      const testResult = await api.hcnetTestConnection(form.ip, form.sdkPort, form.username, form.password)
      if (!testResult.success) {
        throw new Error(testResult.error || 'HCNetSDK Login failed')
      }
      
      // Try getting channel configuration via HTTP ISAPI, fallback to 16 channels if HTTP port is blocked
      try {
        const result = await api.hikConnect({
          id,
          ip: form.ip,
          port: form.port,
          username: form.username,
          password: form.password
        })
        channels = await api.hikGetChannels(id)
        deviceInfo = result.deviceInfo
      } catch (e) {
        console.warn('[AddDeviceModal] HTTP ISAPI failed, generating default 16 channels:', e)
        channels = Array.from({ length: 16 }, (_, idx) => ({
          id: String(idx + 1),
          channelName: `Camera ${idx + 1}`,
          enabled: true
        }))
      }

      const device = {
        id,
        name: form.name || deviceInfo?.deviceName || 'DVR',
        ip: form.ip,
        port: form.port,
        sdkPort: form.sdkPort,
        vendor: form.vendor,
        streamEngine: form.streamEngine,
        username: form.username,
        password: form.password,
        status: 'connected',
        channels: channels || [],
        deviceInfo,
        linkMode: form.linkMode
      }

      if (isExisting) {
        updateDevice(id, device)
      } else {
        addDevice(device)
      }

      // Save to store
      const saved = await api.storeGet('devices') || []
      const deviceToSave = { ...device, status: 'disconnected' }
      let newSaved
      if (saved.some((d) => d.id === id)) {
        newSaved = saved.map((d) => d.id === id ? deviceToSave : d)
      } else {
        newSaved = [...saved, deviceToSave]
      }
      await api.storeSet('devices', newSaved)

      // Start alert stream if it's Hikvision HTTP connected
      if (deviceInfo) {
        api.hikStartAlertStream(id)
      }

      onClose()
    } catch (err) {
      setError(err.message || t('addDevice.connectFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 440 }}>
        <div className="modal-title">
          {deviceToEdit ? t('addDevice.titleEdit') : t('addDevice.title')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="login-row">
            <div className="input-group">
              <label className="input-label">{t('addDevice.deviceName')}</label>
              <input className="input" name="name" value={form.name} onChange={handleChange} placeholder={t('addDevice.deviceNamePlaceholder')} />
            </div>
            <div className="input-group" style={{ maxWidth: 140 }}>
              <label className="input-label">{t('addDevice.manufacturer')}</label>
              <select className="input" name="vendor" value={form.vendor} disabled style={{ height: 34, padding: '0 8px' }}>
                <option value="hikvision">Hikvision</option>
              </select>
            </div>
          </div>

          <div className="input-group">
            <label className="input-label">{t('addDevice.streamEngine')}</label>
            <select className="input" name="streamEngine" value={form.streamEngine} disabled style={{ height: 34, padding: '0 8px' }}>
              <option value="hcnet">{t('addDevice.nativeSDK')}</option>
            </select>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>{t('addDevice.sdkHelp')}</span>
              {!isAddonAvailable && (
                <div style={{ color: '#ff6b6b', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{t('addDevice.addonUnavailable')}</span>
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ padding: '2px 6px', fontSize: 9, height: 'auto', border: '1px solid rgba(255,255,255,0.1)' }}
                    onClick={(e) => { e.preventDefault(); setShowDiagnostics(!showDiagnostics); }}
                  >
                    {showDiagnostics ? t('addDevice.hideDiag') : t('addDevice.showDiag')}
                  </button>
                </div>
              )}
              {!isAddonAvailable && showDiagnostics && (
                <div
                  style={{
                    background: 'rgba(255, 107, 107, 0.1)',
                    border: '1px solid rgba(255, 107, 107, 0.3)',
                    color: '#ff8787',
                    padding: '6px 8px',
                    borderRadius: 4,
                    fontSize: 9,
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    marginTop: 4,
                    lineHeight: '1.3'
                  }}
                >
                  {addonDiagnosticError || t('addDevice.noDiagnostics')}
                </div>
              )}
            </span>
          </div>

          <div className="input-group">
            <label className="input-label">{t('settings.liveLinkModeLabel')}</label>
            <select className="input" name="linkMode" value={form.linkMode} onChange={handleChange} style={{ height: 34, padding: '0 8px' }}>
              <option value={0}>{t('settings.linkModeTCP')}</option>
              <option value={1}>{t('settings.linkModeUDP')}</option>
            </select>
          </div>

          <div className="login-row">
            <div className="input-group" style={{ flex: 2 }}>
              <label className="input-label">{t('addDevice.ipAddress')}</label>
              <input className="input" name="ip" value={form.ip} onChange={handleChange} placeholder="192.168.1.64" />
            </div>
            
            <div className="input-group" style={{ flex: 1 }}>
              <label className="input-label" title={t('addDevice.sdkPortTooltip')}>{t('addDevice.sdkPort')}</label>
              <input className="input" name="sdkPort" type="number" value={form.sdkPort} onChange={handleChange} />
            </div>

            <div className="input-group" style={{ flex: 1 }}>
              <label className="input-label" title={t('addDevice.httpPortTooltip')}>{t('addDevice.httpPort')}</label>
              <input className="input" name="port" type="number" value={form.port} onChange={handleChange} />
            </div>
          </div>

          <div className="login-row">
            <div className="input-group">
              <label className="input-label">{t('addDevice.username')}</label>
              <input className="input" name="username" value={form.username} onChange={handleChange} autoComplete="off" />
            </div>
            <div className="input-group">
              <label className="input-label">{t('addDevice.password')}</label>
              <input className="input" name="password" type="password" value={form.password} onChange={handleChange} />
            </div>
          </div>

          {error && <div className="login-error">⚠️ {error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleConnect} disabled={loading} id="btn-connect-device">
            {loading ? (
              <><span className="loading-spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> {t('addDevice.connecting')}</>
            ) : (deviceToEdit ? t('addDevice.saveBtn') : t('addDevice.connectBtn'))}
          </button>
        </div>
      </div>
    </div>
  )
}
