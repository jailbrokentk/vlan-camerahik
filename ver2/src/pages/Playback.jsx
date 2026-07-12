import React, { useState, useEffect, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { useLanguage } from '../i18n/useLanguage'
import PlaybackView from '../components/PlaybackView'

function CameraSlot({ camera, snapshot, loadingState, onClick }) {
  const [isHovered, setIsHovered] = useState(false)
  const { t } = useLanguage()

  if (!camera) {
    return (
      <div style={{
        position: 'relative',
        aspectRatio: '16/9',
        background: 'rgba(30, 30, 46, 0.4)',
        border: '1px dashed rgba(255, 255, 255, 0.1)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontSize: 12,
        userSelect: 'none'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 18, opacity: 0.3 }}>📷</span>
          <span>{t('playbackPage.empty')}</span>
        </div>
      </div>
    )
  }

  let content
  if (loadingState === 'loading') {
    content = (
      <div 
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(90deg, #1e1e2e 25%, #2a2a3d 50%, #1e1e2e 75%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s infinite',
          borderRadius: 8
        }}
      >
        <span style={{ fontSize: 24, opacity: 0.5, animation: 'pulse 1.5s infinite' }}>⏳</span>
      </div>
    )
  } else if (loadingState === 'error' || !snapshot) {
    content = (
      <div style={{
        width: '100%',
        height: '100%',
        background: '#0f0f18',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: 'var(--text-muted)'
      }}>
        <span style={{ fontSize: 32, opacity: 0.5 }}>📷</span>
        <span style={{ fontSize: 11, opacity: 0.6 }}>{t('playbackPage.noImage')}</span>
      </div>
    )
  } else {
    content = (
      <img
        src={snapshot}
        alt={camera.name}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover'
        }}
      />
    )
  }

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        position: 'relative',
        aspectRatio: '16/9',
        background: '#1e1e2e',
        border: `1px solid ${isHovered ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8,
        overflow: 'hidden',
        cursor: 'pointer',
        transform: isHovered ? 'scale(1.03)' : 'scale(1)',
        boxShadow: isHovered ? '0 10px 20px rgba(0,0,0,0.5), 0 0 10px var(--accent-glow)' : 'none',
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        flexDirection: 'column',
        userSelect: 'none'
      }}
    >
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#000' }}>
        {content}
        
        {/* Play Button Overlay */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: isHovered ? 1 : 0,
          transition: 'opacity 0.2s ease',
          zIndex: 2
        }}>
          <div style={{
            background: 'var(--accent)',
            color: '#fff',
            padding: '10px 18px',
            borderRadius: 50,
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 4px 15px rgba(0, 0, 0, 0.4)',
            transform: isHovered ? 'scale(1)' : 'scale(0.8)',
            transition: 'transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
          }}>
            <span>▶</span>
            <span>{t('playbackPage.startPlayback')}</span>
          </div>
        </div>

        {/* Channel Overlay */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '6px 8px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%'
          }}>
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#fff',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '70%'
            }} title={camera.name}>
              {camera.channelName || `${t('playbackPage.channel')} ${camera.channel}`}
            </span>
            <span style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              background: 'rgba(255, 255, 255, 0.1)',
              padding: '2px 4px',
              borderRadius: 4
            }}>
              CH{camera.channel}
            </span>
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div style={{
        padding: '6px 8px',
        background: '#151522',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 11
      }}>
        <span style={{
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '60%'
        }} title={camera.name}>
          {camera.name.split(' - ')[0]}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          {camera.nvrIp}
        </span>
      </div>
    </div>
  )
}

export default function Playback() {
  const { devices } = useStore()
  const { t } = useLanguage()
  const [selectedCam, setSelectedCam] = useState(null)
  const [snapshots, setSnapshots] = useState({})
  const [loadingStates, setLoadingStates] = useState({})

  const cameras = useMemo(() => {
    const list = []
    const activeDevs = devices.filter((d) => d.status === 'connected' && d.channels.length > 0)
    activeDevs.forEach((dev) => {
      dev.channels.forEach((ch) => {
        list.push({
          id: `${dev.id}_${ch.id}`,
          name: `${dev.name} - ${ch.channelName}`,
          nvrIp: dev.ip,
          channel: parseInt(ch.id, 10) || 1,
          deviceId: dev.id,
          streamEngine: dev.streamEngine,
          channelName: ch.channelName
        })
      })
    })
    return list
  }, [devices])

  const camerasDependency = useMemo(() => {
    return cameras.map((c) => `${c.id}-${c.deviceId}-${c.channel}`).join(',')
  }, [cameras])

  useEffect(() => {
    let active = true

    setSnapshots({})
    setLoadingStates({})

    // Set initial loading states
    cameras.forEach((cam) => {
      setLoadingStates((prev) => ({ ...prev, [cam.id]: 'loading' }))
    })

    // Batch snapshot loader with concurrency limit of 3
    async function loadSnapshotsInBatches(camerasToLoad, batchSize = 3) {
      const queue = [...camerasToLoad]
      
      const runWorker = async () => {
        while (queue.length > 0) {
          if (!active) break
          const cam = queue.shift()
          if (!cam) continue

          try {
            if (window.electronAPI && typeof window.electronAPI.hikSnapshot === 'function') {
              // Add a small 50ms breather delay between pops
              await new Promise((resolve) => setTimeout(resolve, 50))
              const data = await window.electronAPI.hikSnapshot(cam.deviceId, cam.channel)
              if (!active) return
              if (data) {
                setSnapshots((prev) => ({ ...prev, [cam.id]: data }))
                setLoadingStates((prev) => ({ ...prev, [cam.id]: 'success' }))
              } else {
                throw new Error('Empty snapshot data')
              }
            } else {
              throw new Error('hikSnapshot function not found on window.electronAPI')
            }
          } catch (err) {
            console.error(`[Playback] Error loading snapshot for camera ${cam.name} (ID: ${cam.id}):`, err)
            if (active) {
              setLoadingStates((prev) => ({ ...prev, [cam.id]: 'error' }))
            }
          }
        }
      }

      const workers = Array.from({ length: Math.min(batchSize, queue.length) }, runWorker)
      await Promise.all(workers)
    }

    if (cameras.length > 0) {
      loadSnapshotsInBatches(cameras, 3)
    }

    return () => {
      active = false
    }
  }, [camerasDependency])

  if (selectedCam) {
    return (
      <PlaybackView
        camera={selectedCam}
        onClose={() => setSelectedCam(null)}
        onChangeCamera={(cam) => setSelectedCam(cam)}
      />
    )
  }

  const activeDevices = devices.filter((d) => d.status === 'connected' && d.channels.length > 0)
  const slots = Array.from({ length: 25 }, (_, idx) => cameras[idx] || null)

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20, height: '100%', overflowY: 'auto' }}>
      <style>{`
        @keyframes shimmer {
          0% {
            background-position: -200% 0;
          }
          100% {
            background-position: 200% 0;
          }
        }
        @keyframes pulse {
          0%, 100% {
            opacity: 0.4;
          }
          50% {
            opacity: 0.8;
          }
        }
      `}</style>

      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#fff', margin: '0 0 4px 0' }}>{t('playbackPage.title')}</h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>{t('playbackPage.subtitle')}</p>
      </div>

      {activeDevices.length === 0 ? (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 12, padding: '48px 0', border: '1px dashed var(--border)', borderRadius: 8, background: 'var(--bg-card)'
        }}>
          <span style={{ fontSize: 32 }}>📡</span>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('playbackPage.noDevices')}</div>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 16,
          width: '100%',
          maxWidth: 1600,
          margin: '0 auto',
          paddingBottom: 24
        }}>
          {slots.map((camera, index) => (
            <CameraSlot
              key={camera ? camera.id : `empty-${index}`}
              camera={camera}
              snapshot={camera ? snapshots[camera.id] : null}
              loadingState={camera ? loadingStates[camera.id] : null}
              onClick={() => camera && setSelectedCam(camera)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
