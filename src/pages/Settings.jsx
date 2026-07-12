import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { getAPI } from '../lib/electron'
import { useLanguage } from '../i18n/useLanguage'
import AddDeviceModal from '../components/AddDeviceModal'

export default function Settings() {
  const api = getAPI()
  const { t } = useLanguage()
  const {
    devices,
    removeDevice,
    setLoggedIn,
    panels,
    updatePanel,
    liveLinkMode,
    setLiveLinkMode,
    liveBufferFrames,
    setLiveBufferFrames,
    streamResolution,
    setStreamResolution,
    sdBitrateLimit,
    setSdBitrateLimit,
    hdBitrateLimit,
    setHdBitrateLimit
  } = useStore()
  const language = useStore(s => s.language)
  const setLanguage = useStore(s => s.setLanguage)
  const [removing, setRemoving] = useState('')
  const [showAddDevice, setShowAddDevice] = useState(false)
  const [editingDevice, setEditingDevice] = useState(null)
  const setModalOpen = useStore(state => state.setModalOpen)

  useEffect(() => {
    setModalOpen(showAddDevice)
    return () => setModalOpen(false)
  }, [showAddDevice, setModalOpen])

  const [activeTab, setActiveTab] = useState('general')
  const [selectedDeviceId, setSelectedDeviceId] = useState(devices[0]?.id || '')
  const [ipChannels, setIpChannels] = useState([])
  const [loading, setLoading] = useState(false)

  // Security Form States
  const [newUsername, setNewUsername] = useState('admin')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [secError, setSecError] = useState('')
  const [secSuccess, setSecSuccess] = useState('')

  // Panel configuration states
  const [selectedPanelId, setSelectedPanelId] = useState(panels[0]?.id || 'panel-default')
  const activePanelToConfig = panels.find(p => p.id === selectedPanelId) || panels[0]

  const [tempCellCount, setTempCellCount] = useState(25)
  const [tempLinkMode, setTempLinkMode] = useState(0)
  const [tempBufferFrames, setTempBufferFrames] = useState(15)
  const [tempStreamResolution, setTempStreamResolution] = useState('SD')
  const [tempSdBitrate, setTempSdBitrate] = useState(32)
  const [tempHdBitrate, setTempHdBitrate] = useState(256)
  const [saveSuccessMsg, setSaveSuccessMsg] = useState('')

  useEffect(() => {
    if (activePanelToConfig) {
      setTempCellCount(activePanelToConfig.cellCount || 25)
      setTempLinkMode(activePanelToConfig.linkMode !== undefined ? activePanelToConfig.linkMode : liveLinkMode)
      setTempBufferFrames(activePanelToConfig.bufferFrames !== undefined ? activePanelToConfig.bufferFrames : liveBufferFrames)
      setTempStreamResolution(activePanelToConfig.streamResolution !== undefined ? activePanelToConfig.streamResolution : streamResolution)
      setTempSdBitrate(activePanelToConfig.sdBitrateLimit !== undefined ? activePanelToConfig.sdBitrateLimit : sdBitrateLimit)
      setTempHdBitrate(activePanelToConfig.hdBitrateLimit !== undefined ? activePanelToConfig.hdBitrateLimit : hdBitrateLimit)
    }
  }, [selectedPanelId, activePanelToConfig, liveLinkMode, liveBufferFrames, streamResolution, sdBitrateLimit, hdBitrateLimit])

  const handleSavePanelSettings = async () => {
    if (!activePanelToConfig) return
    
    updatePanel(activePanelToConfig.id, {
      cellCount: tempCellCount,
      linkMode: tempLinkMode,
      bufferFrames: tempBufferFrames,
      streamResolution: tempStreamResolution,
      sdBitrateLimit: tempSdBitrate,
      hdBitrateLimit: tempHdBitrate
    })

    const updatedPanels = panels.map(p => {
      if (p.id === activePanelToConfig.id) {
        return {
          ...p,
          cellCount: tempCellCount,
          linkMode: tempLinkMode,
          bufferFrames: tempBufferFrames,
          streamResolution: tempStreamResolution,
          sdBitrateLimit: tempSdBitrate,
          hdBitrateLimit: tempHdBitrate
        }
      }
      return p
    })
    
    setSdBitrateLimit(tempSdBitrate)
    setHdBitrateLimit(tempHdBitrate)
    
    if (api) {
      await api.storeSet('panels', updatedPanels)
      await api.storeSet('sdBitrateLimit', tempSdBitrate)
      await api.storeSet('hdBitrateLimit', tempHdBitrate)
    }

    setSaveSuccessMsg(t('settings.panelSaveSuccess'))
    setTimeout(() => setSaveSuccessMsg(''), 3000)
  }

  // Fetch IP channels when camera management tab is open or device changes
  useEffect(() => {
    if (activeTab === 'cameras' && selectedDeviceId) {
      fetchIpChannels(selectedDeviceId)
    }
  }, [activeTab, selectedDeviceId])

  const fetchIpChannels = async (deviceId) => {
    setLoading(true)
    try {
      const list = await api.hikGetIPChannels(deviceId)
      setIpChannels(list)
    } catch (err) {
      console.error('[Settings] Failed to fetch IP channels:', err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRemove = async (id) => {
    setRemoving(id)
    api.hikStopAlertStream(id)
    removeDevice(id)
    const saved = (await api.storeGet('devices') || []).filter((d) => d.id !== id)
    await api.storeSet('devices', saved)
    if (selectedDeviceId === id) {
      setSelectedDeviceId(saved.length > 0 ? saved[0].id : '')
    }
    setRemoving('')
  }

  const handleTestConnection = async (device) => {
    try {
      const result = await api.hcnetTestConnection(device.ip, device.sdkPort || 8000, device.username, device.password)
      if (result.success) {
        alert(t('settings.testSuccess'))
      } else {
        alert(`${t('settings.testFailed')} ${result.error}`)
      }
    } catch (err) {
      alert(`${t('settings.testError')} ${err.message}`)
    }
  }

  const handleUpdateSecurity = async (e) => {
    e.preventDefault()
    setSecError('')
    setSecSuccess('')

    if (!newUsername || !newPassword || !confirmPassword) {
      setSecError(t('settings.fillAllFields'))
      return
    }

    if (newPassword !== confirmPassword) {
      setSecError(t('settings.passwordMismatch'))
      return
    }

    try {
      const fingerprint = localStorage.getItem('deviceFingerprint') || ''
      const res = await api.authRegister(newUsername, newPassword, fingerprint)
      if (res.success && res.token) {
        localStorage.setItem('appToken', res.token)
        setSecSuccess(t('settings.updateSuccess'))
        setNewPassword('')
        setConfirmPassword('')
      } else {
        setSecError(res.error || t('settings.updateFailed'))
      }
    } catch (err) {
      setSecError(t('settings.updateError') + ' ' + err.message)
    }
  }

  return (
    <div className="settings-layout" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Sub tabs navigation */}
      <div className="settings-tabs">
        <button
          className={`settings-tab-btn ${activeTab === 'general' ? 'active' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          {t('settings.tabDevices')}
        </button>
        <button
          className={`settings-tab-btn ${activeTab === 'cameras' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('cameras')
            if (devices.length > 0 && !selectedDeviceId) {
              setSelectedDeviceId(devices[0].id)
            }
          }}
        >
          {t('settings.tabCameras')}
        </button>
        <button
          className={`settings-tab-btn ${activeTab === 'security' ? 'active' : ''}`}
          onClick={() => setActiveTab('security')}
        >
          {t('settings.tabSecurity')}
        </button>
      </div>

      {/* Tab content area */}
      <div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>
        {activeTab === 'general' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div className="settings-section">
              <div className="settings-section-title">{t('settings.appInfoTitle')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="device-card">
                  <div className="device-card-icon">🌐</div>
                  <div className="device-card-info">
                    <div className="device-card-name">vLAN-CameraHIK</div>
                    <div className="device-card-sub">{t('settings.appVersion')}</div>
                  </div>
                  <span className="badge badge-success">{t('common.running')}</span>
                </div>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">{t('settings.languageTitle')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 320 }}>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('settings.languageLabel')}</label>
                <select
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: 13,
                    background: '#1a1a2e',
                    border: '1px solid var(--border)',
                    color: '#fff',
                    borderRadius: 6,
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  <option value="en">{t('settings.langEn')}</option>
                  <option value="vi">{t('settings.langVi')}</option>
                </select>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">{t('settings.deviceTitle')}</div>
              <button
                className="btn btn-primary"
                style={{ marginBottom: 12, padding: '8px 16px', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={() => setShowAddDevice(true)}
              >
                {t('settings.addDevice')}
              </button>

              {devices.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32, fontSize: 13 }}>
                  {t('settings.noDevices')}
                </div>
              ) : (
                devices.map((dev) => (
                  <div key={dev.id} className="device-card">
                    <div className="device-card-icon">🎥</div>
                    <div className="device-card-info">
                      <div className="device-card-name">{dev.name}</div>
                      <div className="device-card-sub">
                        {dev.ip}:{dev.port} · {dev.username} · {dev.channels.length} {t('common.channels')}
                        {dev.deviceInfo && (
                          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                            {dev.deviceInfo.model}
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className={`badge ${dev.status === 'connected' ? 'badge-success' : 'badge-danger'}`}>
                        {dev.status === 'connected' ? t('common.online') : t('common.offline')}
                      </span>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleTestConnection(dev)}
                        id={`btn-test-${dev.id}`}
                      >
                        {t('common.test')}
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setEditingDevice(dev)
                          setShowAddDevice(true)
                        }}
                        id={`btn-edit-${dev.id}`}
                        title="Edit Device"
                      >
                        ✏️
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleRemove(dev.id)}
                        disabled={removing === dev.id}
                        id={`btn-remove-${dev.id}`}
                      >
                        {removing === dev.id ? '...' : '🗑️'}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="settings-section">
              <div className="settings-section-title">{t('settings.panelConfigTitle')}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                {t('settings.panelConfigDesc')}
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Chọn Panel */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 320 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('settings.selectPanelToConfig')}</label>
                  <select
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      fontSize: 13,
                      background: '#1a1a2e',
                      border: '1px solid var(--border)',
                      color: '#fff',
                      borderRadius: 6,
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                    value={selectedPanelId}
                    onChange={(e) => setSelectedPanelId(e.target.value)}
                  >
                    {panels.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.id === 'panel-default' ? t('common.default') || 'Default' : p.name}
                      </option>
                    ))}
                  </select>
                </div>
                
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', maxWidth: 640 }}>
                  {/* Bố cục lưới */}
                  <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('settings.panelLayoutLabel')}</label>
                    <select
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        fontSize: 13,
                        background: '#1a1a2e',
                        border: '1px solid var(--border)',
                        color: '#fff',
                        borderRadius: 6,
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                      value={tempCellCount}
                      onChange={(e) => setTempCellCount(parseInt(e.target.value, 10))}
                    >
                      <option value={1}>{t('settings.layout1x1')}</option>
                      <option value={4}>{t('settings.layout2x2')}</option>
                      <option value={9}>{t('settings.layout3x3')}</option>
                      <option value={16}>{t('settings.layout4x4')}</option>
                      <option value={25}>{t('settings.layout5x5')}</option>
                    </select>
                  </div>

                  {/* Chế độ kết nối TCP vs UDP */}
                  <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('settings.liveLinkModeLabel')}</label>
                    <select
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        fontSize: 13,
                        background: '#1a1a2e',
                        border: '1px solid var(--border)',
                        color: '#fff',
                        borderRadius: 6,
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                      value={tempLinkMode}
                      onChange={(e) => setTempLinkMode(parseInt(e.target.value, 10))}
                    >
                      <option value={0}>{t('settings.linkModeTCP')}</option>
                      <option value={1}>{t('settings.linkModeUDP')}</option>
                    </select>
                  </div>

                  {/* Hiệu năng & Bộ đệm */}
                  <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('settings.liveBufferLabel')}</label>
                    <select
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        fontSize: 13,
                        background: '#1a1a2e',
                        border: '1px solid var(--border)',
                        color: '#fff',
                        borderRadius: 6,
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                      value={tempBufferFrames}
                      onChange={(e) => setTempBufferFrames(parseInt(e.target.value, 10))}
                    >
                      <option value={1}>{t('settings.bufferRealtime')}</option>
                      <option value={3}>{t('settings.bufferBalanced')}</option>
                      <option value={10}>{t('settings.bufferSmooth')}</option>
                      <option value={15}>{t('settings.bufferFluent')}</option>
                    </select>
                  </div>

                  {/* Chất lượng luồng */}
                  <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('settings.liveQualityLabel')}</label>
                    <select
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        fontSize: 13,
                        background: '#1a1a2e',
                        border: '1px solid var(--border)',
                        color: '#fff',
                        borderRadius: 6,
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                      value={tempStreamResolution}
                      onChange={(e) => setTempStreamResolution(e.target.value)}
                    >
                      <option value="SD">{t('settings.qualitySD')}</option>
                      <option value="HD">{t('settings.qualityHD')}</option>
                    </select>
                  </div>

                  {/* Giới hạn Bitrate luồng SD (Sub Stream) */}
                  <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('settings.sdBitrateLabel')}</label>
                    <select
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        fontSize: 13,
                        background: '#1a1a2e',
                        border: '1px solid var(--border)',
                        color: '#fff',
                        borderRadius: 6,
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                      value={tempSdBitrate}
                      onChange={(e) => setTempSdBitrate(parseInt(e.target.value, 10))}
                    >
                      <option value={16}>16 KB/s (128 Kbps) - {t('common.offline') /* or low quality fallback */}</option>
                      <option value={32}>32 KB/s (256 Kbps) - {t('settings.bufferBalanced')}</option>
                      <option value={64}>64 KB/s (512 Kbps) - {t('settings.bufferSmooth')}</option>
                      <option value={0}>{t('settings.bitrateUnlimited')}</option>
                    </select>
                  </div>

                  {/* Giới hạn Bitrate luồng HD (Main Stream) */}
                  <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('settings.hdBitrateLabel')}</label>
                    <select
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        fontSize: 13,
                        background: '#1a1a2e',
                        border: '1px solid var(--border)',
                        color: '#fff',
                        borderRadius: 6,
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                      value={tempHdBitrate}
                      onChange={(e) => setTempHdBitrate(parseInt(e.target.value, 10))}
                    >
                      <option value={128}>128 KB/s (1.0 Mbps)</option>
                      <option value={192}>192 KB/s (1.5 Mbps)</option>
                      <option value={256}>256 KB/s (2.0 Mbps) - {t('settings.bufferBalanced')}</option>
                      <option value={384}>384 KB/s (3.0 Mbps) - {t('settings.bufferSmooth')}</option>
                      <option value={0}>{t('settings.bitrateUnlimited')}</option>
                    </select>
                  </div>
                </div>

                {/* Dòng thông tin hướng dẫn bóp giải mã I-Frame tại Client */}
                {(tempSdBitrate > 0 || tempHdBitrate > 0) && (
                  <div style={{
                    fontSize: 11,
                    color: '#00bcd4',
                    background: 'rgba(0,188,212,0.08)',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid rgba(0,188,212,0.15)',
                    maxWidth: 640,
                    lineHeight: '1.4',
                    marginBottom: 12
                  }}>
                    {t('settings.bitrateWarning')}
                  </div>
                )}
                {/* Nút lưu cài đặt panel */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleSavePanelSettings}
                    style={{
                      padding: '10px 24px',
                      fontSize: 13,
                      fontWeight: 600,
                      background: 'var(--accent)',
                      border: 'none',
                      borderRadius: 6,
                      color: '#fff',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      boxShadow: '0 4px 12px rgba(255, 117, 24, 0.2)'
                    }}
                  >
                    {t('settings.btnSavePanel')}
                  </button>
                  {saveSuccessMsg && (
                    <span style={{ fontSize: 13, color: '#4caf50', fontWeight: 500, animation: 'fadeIn 0.3s ease' }}>
                      ✅ {saveSuccessMsg}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">{t('settings.storageTitle')}</div>
              <StoragePathSettings />
            </div>

          </div>
        )}

        {activeTab === 'cameras' && (
          <div className="settings-section" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
              <span className="toolbar-label">{t('settings.selectDevice')}</span>
              <select
                className="input"
                style={{ width: 220, padding: '6px 12px', fontSize: 13 }}
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} ({d.ip})</option>
                ))}
              </select>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => fetchIpChannels(selectedDeviceId)}
                disabled={loading || !selectedDeviceId}
              >
                {loading ? t('settings.refreshLoading') : t('settings.refreshBtn')}
              </button>
            </div>

            {loading ? (
              <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)', fontSize: 13 }}>
                {t('settings.loadingChannels')}
              </div>
            ) : ipChannels.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)', fontSize: 13 }}>
                {t('settings.noChannels')}
              </div>
            ) : (
              <div className="camera-mgmt-table-container">
                <table className="camera-mgmt-table">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}><input type="checkbox" defaultChecked /></th>
                      <th style={{ width: 80 }}>{t('settings.thChannel')}</th>
                      <th>{t('settings.thCameraName')}</th>
                      <th>{t('settings.thIP')}</th>
                      <th style={{ width: 90 }}>{t('settings.thPort')}</th>
                      <th style={{ width: 120 }}>{t('settings.thStatus')}</th>
                      <th style={{ width: 120 }}>{t('settings.thProtocol')}</th>
                      <th>{t('settings.thModel')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ipChannels.map((ch) => (
                      <tr key={ch.id}>
                        <td><input type="checkbox" defaultChecked /></td>
                        <td style={{ fontWeight: 'bold', color: 'var(--text-muted)' }}>D{ch.id}</td>
                        <td style={{ fontWeight: 600, color: 'var(--accent)' }}>{ch.name}</td>
                        <td>{ch.ipAddress || '---'}</td>
                        <td>{ch.port}</td>
                        <td>
                          <span className={`badge ${ch.online ? 'badge-success' : 'badge-danger'}`}>
                            {ch.online ? t('settings.statusOnline') : t('settings.statusOffline')}
                          </span>
                        </td>
                        <td>
                          <span className="tag">{ch.protocol}</span>
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontSize: 11, fontWeight: 'bold' }}>{ch.model || t('settings.genericModel')}</span>
                            {ch.serialNumber && (
                              <span style={{ fontSize: 9, opacity: 0.6 }}>S/N: {ch.serialNumber}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'security' && (
          <div className="settings-section" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 450 }}>
            <div className="settings-section-title">{t('settings.securityTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 8 }}>
              {t('settings.securityDesc')}
            </div>

            {secError && (
              <div style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', padding: 10, borderRadius: 6, fontSize: 12 }}>
                ⚠️ {secError}
              </div>
            )}

            {secSuccess && (
              <div style={{ background: 'rgba(0,230,118,0.1)', border: '1px solid rgba(0,230,118,0.2)', color: 'var(--success)', padding: 10, borderRadius: 6, fontSize: 12 }}>
                ✅ {secSuccess}
              </div>
            )}

            <form onSubmit={handleUpdateSecurity} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="input-group">
                <label className="input-label">{t('settings.newUsername')}</label>
                <input
                  type="text"
                  className="input"
                  placeholder={t('settings.newUsernamePlaceholder')}
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">{t('settings.newPasswordLabel')}</label>
                <input
                  type="password"
                  className="input"
                  placeholder={t('settings.newPasswordPlaceholder')}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>

              <div className="input-group">
                <label className="input-label">{t('settings.confirmPasswordLabel')}</label>
                <input
                  type="password"
                  className="input"
                  placeholder={t('settings.confirmPasswordPlaceholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>

              <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-start', marginTop: 8, padding: '8px 16px', fontWeight: 600 }}>
                {t('settings.saveChanges')}
              </button>
            </form>

            <div style={{ margin: '24px 0', borderTop: '1px solid var(--border)' }} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('auth.logoutSection')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('auth.logoutDesc')}
              </div>
              <button
                type="button"
                className="btn btn-danger"
                style={{
                  alignSelf: 'flex-start',
                  marginTop: 6,
                  padding: '8px 16px',
                  fontWeight: 600,
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
                onClick={() => setLoggedIn(false)}
              >
                {t('auth.logoutButton')}
              </button>
            </div>
          </div>
        )}
      </div>
      {showAddDevice && <AddDeviceModal onClose={() => { setShowAddDevice(false); setEditingDevice(null); }} deviceToEdit={editingDevice} />}
    </div>
  )
}

function StoragePathSettings() {
  const api = getAPI()
  const { t } = useLanguage()
  const [snapshotPath, setSnapshotPath] = useState('')
  const [recordingPath, setRecordingPath] = useState('')

  useEffect(() => {
    api.getDefaultPaths().then((paths) => {
      setSnapshotPath(paths?.snapshotPath || '')
      setRecordingPath(paths?.recordingPath || '')
    })
  }, [])

  const selectPath = async (type) => {
    const folder = await api.selectFolder()
    if (!folder) return
    if (type === 'snapshot') {
      setSnapshotPath(folder)
      await api.storeSet('snapshotPath', folder)
    } else {
      setRecordingPath(folder)
      await api.storeSet('recordingPath', folder)
    }
  }

  const inputStyle = {
    flex: 1,
    padding: '8px 12px',
    fontSize: 12,
    background: '#1a1a2e',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    borderRadius: 6,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  }

  const btnStyle = {
    padding: '8px 12px',
    fontSize: 11,
    background: '#1a1a2e',
    border: '1px solid var(--border)',
    color: '#fff',
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>{t('settings.snapshotPath')}</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={inputStyle} title={snapshotPath}>{snapshotPath || t('common.notConfigured')}</div>
          <button style={btnStyle} onClick={() => selectPath('snapshot')}>{t('common.select')}</button>
          <button style={btnStyle} onClick={() => snapshotPath && api.openFolder(snapshotPath)}>{t('common.openFolder')}</button>
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>{t('settings.recordingPath')}</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={inputStyle} title={recordingPath}>{recordingPath || t('common.notConfigured')}</div>
          <button style={btnStyle} onClick={() => selectPath('recording')}>{t('common.select')}</button>
          <button style={btnStyle} onClick={() => recordingPath && api.openFolder(recordingPath)}>{t('common.openFolder')}</button>
        </div>
      </div>
    </div>
  )
}
