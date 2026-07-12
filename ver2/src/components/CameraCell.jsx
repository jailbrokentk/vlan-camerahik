import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { getAPI } from '../lib/electron'
import ReactDOM from 'react-dom'
import { useLanguage } from '../i18n/useLanguage'



export default function CameraCell({
  index,
  gridSize,
  panelId,
  fullscreenKey = null,
  fullscreenPhase = 'grid',
  fullscreenGeneration = 0,
  desiredQuality = 'SD',
  style,
  onSetExplicitQuality,
  onToggleFullscreen,
  onCloseFullscreen,
  onTransitionComplete,
  onAppFullscreen
}) {
  const { t, language } = useLanguage()
  const api = getAPI()
  const devices = useStore(s => s.devices)
  const activePanelId = useStore(s => s.activePanelId)
  const targetPanelId = panelId || activePanelId
  const panel = useStore(s => s.panels.find(p => p.id === targetPanelId))
  const setPanelSlot = useStore(s => s.setPanelSlot)
  const isModalOpen = useStore(s => s.isModalOpen)
  const swapPanelSlots = useStore(s => s.swapPanelSlots)
  const movingCellIndex = useStore(s => s.movingCellIndex)
  const movingPanelId = useStore(s => s.movingPanelId)
  const setMovingCell = useStore(s => s.setMovingCell)
  const clearMovingCell = useStore(s => s.clearMovingCell)
  const isFocused = useStore(s => s.focusedCellIndex === index)
  const setFocusedCellIndex = useStore(s => s.setFocusedCellIndex)

  const slot = panel?.cameraSlots[index] || null
  const transitionTimeoutRef = useRef(null)

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
    }
  }, [])

  // Derived move mode state
  const isMoveModeActive = movingCellIndex !== null
  const isSourceCell = isMoveModeActive && movingCellIndex === index && movingPanelId === targetPanelId

  const device = slot ? devices.find((d) => d.id === slot.deviceId) : null
  const channel = device?.channels.find((c) => c.id === slot?.channelId)

  const myKey = slot ? `${targetPanelId}:${index}:${slot.deviceId}:${slot.channelId}` : `${targetPanelId}:${index}:empty`
  const isSelected = fullscreenKey === myKey
  const isAnyFullscreenActive = fullscreenKey !== null
  const isFullscreen = isSelected && (fullscreenPhase === 'entering' || fullscreenPhase === 'camera')
  const isAppFullscreen = useStore(s => s.isAppFullscreen)

  const [isMuted, setIsMuted] = useState(() => slot?.muted ?? true)
  const [enableSmartLocal, setEnableSmartLocal] = useState(() => slot?.enableSmart ?? false)
  const [isDragActive, setIsDragActive] = useState(false)
  const [isPlaybackActive, setIsPlaybackActive] = useState(false)
  const [isVisible, setIsVisible] = useState(true)

  useEffect(() => {
    const handler = (e) => {
      setIsPlaybackActive(!!e.detail?.active)
    }
    window.addEventListener('playback-modal-active', handler)
    return () => window.removeEventListener('playback-modal-active', handler)
  }, [])

  useEffect(() => {
    const handleGlobalDragStart = () => {
      // Defer state update to next event tick to prevent Chromium drag abort
      setTimeout(() => {
        setIsDragActive(true)
      }, 0)
    }
    const handleGlobalDragEnd = () => {
      setIsDragActive(false)
    }
    document.addEventListener('dragstart', handleGlobalDragStart)
    document.addEventListener('dragend', handleGlobalDragEnd)
    window.addEventListener('global-drag-end', handleGlobalDragEnd)
    return () => {
      document.removeEventListener('dragstart', handleGlobalDragStart)
      document.removeEventListener('dragend', handleGlobalDragEnd)
      window.removeEventListener('global-drag-end', handleGlobalDragEnd)
    }
  }, [])

  // Escape key cancels cell move mode
  useEffect(() => {
    if (!isMoveModeActive) return
    const handleEsc = (e) => {
      if (e.key === 'Escape') clearMovingCell()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [isMoveModeActive, clearMovingCell])

  const cellRef = useRef(null)
  const isDraggingRef = useRef(false)
  const nativeContainerRef = useRef(null)

  // Quality display states
  const [playingQuality, setPlayingQuality] = useState('SD')
  const [switchingQuality, setSwitchingQuality] = useState(null)
  const [hdFailed, setHdFailed] = useState(false)
  const [connectionError, setConnectionError] = useState(null)
  const [tempQualityOverride, setTempQualityOverride] = useState(desiredQuality === 'HD' ? 'SD' : null)
  const resolvedQuality = tempQualityOverride || ((desiredQuality === 'HD' && !hdFailed) ? 'HD' : 'SD')

  // Stage SD first and upgrade to HD after a delay
  useEffect(() => {
    if (desiredQuality === 'HD') {
      setTempQualityOverride('SD')
      const timer = setTimeout(() => {
        setTempQualityOverride(null)
      }, 3000 + index * 150)
      return () => clearTimeout(timer)
    } else {
      setTempQualityOverride(null)
    }
  }, [desiredQuality, slot?.deviceId, slot?.channelId])

  // State to track the active HWND.
  const [activeHwnd, setActiveHwnd] = useState(null)

  // Stream Refs for Atomic SD/HD Switch
  const activeStreamRef = useRef(null)
  const pendingStreamRef = useRef(null)
  const staggerTimeoutRef = useRef(null)
  const retryTimeoutRef = useRef(null)
  const [reloadCounter, setReloadCounter] = useState(0)

  const latestGenerationRef = useRef(0)
  const isTransitioningRef = useRef(false)
  const lastBoundsRef = useRef(null)

  const [toast, setToast] = useState(null)
  const showToast = (message, filePath) => {
    setToast({ message, filePath })
    setTimeout(() => setToast(null), 5000)
  }

  // Sync state when slot changes (e.g. camera dragged/swapped/removed)
  useEffect(() => {
    setIsMuted(slot?.muted ?? true)
    setEnableSmartLocal(slot?.enableSmart ?? false)
    setHdFailed(false)
  }, [slot?.deviceId, slot?.channelId, slot?.muted, slot?.enableSmart])

  // Track generation
  useEffect(() => {
    latestGenerationRef.current = fullscreenGeneration
  }, [fullscreenGeneration])

  const cleanupAllStreams = async () => {
    // Hide the windows instantly in the renderer process to prevent overlay/flicker
    if (pendingStreamRef.current?.childHwnd) {
      api.hcnetSetWindowVisible(pendingStreamRef.current.childHwnd, false)
    }
    if (activeStreamRef.current?.childHwnd) {
      api.hcnetSetWindowVisible(activeStreamRef.current.childHwnd, false)
    }

    if (staggerTimeoutRef.current) {
      clearTimeout(staggerTimeoutRef.current)
      staggerTimeoutRef.current = null
    }

    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }

    if (pendingStreamRef.current) {
      clearTimeout(pendingStreamRef.current.timeoutId)
      console.log(`[STREAM] stop pending quality=${pendingStreamRef.current.quality} reason=cleanup`)
      await api.hcnetStopPlay(pendingStreamRef.current.streamKey)
      pendingStreamRef.current = null
    }
    if (activeStreamRef.current) {
      console.log(`[STREAM] stop active quality=${activeStreamRef.current.quality} reason=cleanup`)
      await api.hcnetStopPlay(activeStreamRef.current.streamKey)
      activeStreamRef.current = null
    }
    setPlayingQuality('SD')
    setSwitchingQuality(null)
    setActiveHwnd(null)
    setConnectionError(null)
  }

  // Reload stream: clean stop then restart
  const reloadStream = useCallback(async () => {
    if (!slot) return
    await cleanupAllStreams()
    setReloadCounter(prev => prev + 1)
  }, [slot?.deviceId, slot?.channelId, resolvedQuality])

  // Listen for topbar "Tải lại" button event
  useEffect(() => {
    const handler = () => reloadStream()
    window.dispatchEvent(new CustomEvent('player-reconnect-init')) // Let app know we are listening
    window.addEventListener('player-reconnect-all', handler)
    return () => window.removeEventListener('player-reconnect-all', handler)
  }, [reloadStream])

  // Listen for reload event from grid context menu
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.index === index) {
        reloadStream()
      }
    }
    window.addEventListener('player-reload-cell', handler)
    return () => window.removeEventListener('player-reload-cell', handler)
  }, [index, reloadStream])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAllStreams()
    }
  }, [])

  // shouldBePlaying: stream lifecycle cares about viewport visibility and active fullscreen state
  // When fullscreen is active, we keep other background streams alive to prevent re-connecting when collapsing.
  const shouldBePlaying = isVisible || isAnyFullscreenActive

  const startQualitySwitch = async (quality) => {
    if (!slot) return

    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }

    // Cancel any previous pending switch
    if (pendingStreamRef.current) {
      clearTimeout(pendingStreamRef.current.timeoutId)
      console.log(`[STREAM] stop pending quality=${pendingStreamRef.current.quality} reason=superseded`)
      await api.hcnetStopPlay(pendingStreamRef.current.streamKey)
      pendingStreamRef.current = null
    }

    if (staggerTimeoutRef.current) {
      clearTimeout(staggerTimeoutRef.current)
      staggerTimeoutRef.current = null
    }

    const currentGeneration = ++latestGenerationRef.current
    const staggerDelay = reloadCounter > 0 ? 0 : index * 120

    console.log(`[STREAM] queue switching to quality=${quality} generation=${currentGeneration} delay=${staggerDelay}`)
    setSwitchingQuality(quality)

    staggerTimeoutRef.current = setTimeout(async () => {
      staggerTimeoutRef.current = null
      if (currentGeneration !== latestGenerationRef.current) return
      if (!slot) return

      if (!nativeContainerRef.current) {
        console.warn(`[STREAM] nativeContainerRef.current is null, scheduling retry of startQualitySwitch(${quality}) in 50ms`)
        retryTimeoutRef.current = setTimeout(() => startQualitySwitch(quality), 50)
        return
      }

      const rect = nativeContainerRef.current.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        console.warn(`[STREAM] bounding rect dimensions are 0, scheduling retry of startQualitySwitch(${quality}) in 50ms`)
        retryTimeoutRef.current = setTimeout(() => startQualitySwitch(quality), 50)
        return
      }

      const scale = window.devicePixelRatio || 1
      const x = Math.round(rect.left * scale)
      const y = Math.round(rect.top * scale)
      const w = Math.round(rect.width * scale)
      const h = Math.round(rect.height * scale)

      const streamType = quality === 'HD' ? 0 : 1
      const channelNum = parseInt(slot.channelId, 10) || 1

      console.log(`[STREAM] start switching to quality=${quality} generation=${currentGeneration}`)

      try {
        // Start the new stream
        let result
        let usedQuality = quality
        try {
          result = await api.hcnetStartPlay(slot.deviceId, channelNum, streamType, x, y, w, h, enableSmartLocal)
        } catch (err) {
          if (quality === 'HD') {
            console.warn(`[STREAM] HD play failed with error: ${err.message}. Falling back to SD.`)
            // Automatically fall back to SD streamType = 1
            result = await api.hcnetStartPlay(slot.deviceId, channelNum, 1, x, y, w, h, enableSmartLocal)
            usedQuality = 'SD'
            setHdFailed(true)
            showToast(t('camera.hdFailFallback'), null)
          } else {
            throw err
          }
        }
        
        if (currentGeneration !== latestGenerationRef.current) {
          // Stale callback, clean up immediately
          if (result && result.streamKey) {
            console.log(`[STREAM] stop quality=${quality} reason=stale-callback`)
            await api.hcnetStopPlay(result.streamKey)
          }
          return
        }

        if (result && result.childHwnd) {
          // Hide the new window initially so the old active stream remains visible during connection
          await api.hcnetSetWindowVisible(result.childHwnd, false)
          await api.hcnetMoveWindow(result.childHwnd, x, y, w, h)

          // Wait for first frame / connection (800ms grace period)
          const timeoutId = setTimeout(async () => {
            if (currentGeneration !== latestGenerationRef.current) {
              console.log(`[STREAM] stop quality=${quality} reason=stale-timeout`)
              await api.hcnetStopPlay(result.streamKey)
              return
            }

            console.log(`[STREAM] first-frame quality=${usedQuality} swapping visible windows`)
            
            // Swap windows: position new window and show it
            if (nativeContainerRef.current) {
              const currentRect = nativeContainerRef.current.getBoundingClientRect()
              const scale = window.devicePixelRatio || 1
              const curX = Math.round(currentRect.left * scale)
              const curY = Math.round(currentRect.top * scale)
              const curW = Math.round(currentRect.width * scale)
              const curH = Math.round(currentRect.height * scale)
              
              await api.hcnetMoveWindow(result.childHwnd, curX, curY, curW, curH)
              await api.hcnetSetWindowVisible(result.childHwnd, true)
            }

            // Stop the old active stream
            if (activeStreamRef.current) {
              console.log(`[STREAM] stop quality=${activeStreamRef.current.quality} reason=swapped`)
              await api.hcnetStopPlay(activeStreamRef.current.streamKey)
            }

            // Promote pending stream to active
            activeStreamRef.current = {
              streamKey: result.streamKey,
              childHwnd: result.childHwnd,
              previewHandle: result.previewHandle,
              quality: usedQuality,
              deviceId: slot.deviceId,
              channelId: slot.channelId
            }
            pendingStreamRef.current = null
            
            setPlayingQuality(usedQuality)
            setSwitchingQuality(null)
            setActiveHwnd(result.childHwnd)
            setConnectionError(null)
          }, 800)

          pendingStreamRef.current = {
            streamKey: result.streamKey,
            childHwnd: result.childHwnd,
            previewHandle: result.previewHandle,
            quality: usedQuality,
            deviceId: slot.deviceId,
            channelId: slot.channelId,
            timeoutId
          }
        }
      } catch (err) {
        console.error(`[STREAM] Quality switch failed:`, err.message)
        setConnectionError(err.message)
        setSwitchingQuality(null)
      }
    }, staggerDelay)
  }

  useEffect(() => {
    if (!slot || !shouldBePlaying) {
      cleanupAllStreams()
      return
    }

    // If slot camera changes, instantly cleanup old stream first
    if (activeStreamRef.current && 
        (activeStreamRef.current.deviceId !== slot.deviceId || activeStreamRef.current.channelId !== slot.channelId)) {
      cleanupAllStreams()
    }

    // Do nothing if active stream matches current camera slot and desired quality
    if (activeStreamRef.current && 
        activeStreamRef.current.quality === resolvedQuality &&
        activeStreamRef.current.deviceId === slot.deviceId &&
        activeStreamRef.current.channelId === slot.channelId) {
      return
    }

    // Do nothing if pending stream matches current camera slot and desired quality
    if (pendingStreamRef.current && 
        pendingStreamRef.current.quality === resolvedQuality &&
        pendingStreamRef.current.deviceId === slot.deviceId &&
        pendingStreamRef.current.channelId === slot.channelId) {
      return
    }

    startQualitySwitch(resolvedQuality)
  }, [slot?.deviceId, slot?.channelId, shouldBePlaying, resolvedQuality, reloadCounter])

  useEffect(() => {
    const desiredVisibility = (isAnyFullscreenActive ? isSelected : isVisible) && !isModalOpen && !isDragActive && !isMoveModeActive && !isPlaybackActive
    if (activeHwnd) {
      console.log(`[FULLSCREEN] sync visibility myKey=${myKey} activeHwnd=${activeHwnd} visible=${desiredVisibility}`)
      
      if (desiredVisibility) {
        // Measure and position the native window immediately before making it visible
        if (nativeContainerRef.current) {
          const rect = nativeContainerRef.current.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            const scale = window.devicePixelRatio || 1
            const x = Math.round(rect.left * scale)
            const y = Math.round(rect.top * scale)
            const w = Math.round(rect.width * scale)
            const h = Math.round(rect.height * scale)
            
            console.log(`[FULLSCREEN] pre-visible move myKey=${myKey} bounds x=${x} y=${y} w=${w} h=${h}`)
            api.hcnetMoveWindow(activeHwnd, x, y, w, h)
            lastBoundsRef.current = { x, y, width: w, height: h }
          }
        }
      }
      
      api.hcnetSetWindowVisible(activeHwnd, desiredVisibility)
    }
    // Also sync pending stream's HWND to prevent orphan visible windows
    if (pendingStreamRef.current?.childHwnd && pendingStreamRef.current.childHwnd !== activeHwnd) {
      if (desiredVisibility && nativeContainerRef.current) {
        const rect = nativeContainerRef.current.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          const scale = window.devicePixelRatio || 1
          const x = Math.round(rect.left * scale)
          const y = Math.round(rect.top * scale)
          const w = Math.round(rect.width * scale)
          const h = Math.round(rect.height * scale)
          api.hcnetMoveWindow(pendingStreamRef.current.childHwnd, x, y, w, h)
        }
      }
      api.hcnetSetWindowVisible(pendingStreamRef.current.childHwnd, desiredVisibility)
    }
  }, [activeHwnd, isAnyFullscreenActive, isSelected, isVisible, isModalOpen, isDragActive, isMoveModeActive, isPlaybackActive])

  // Dynamic Smart Overlay toggle (VCA rules rendering) without stream restart!
  useEffect(() => {
    const previewHandle = activeStreamRef.current?.previewHandle
    if (previewHandle === undefined || previewHandle < 0) return
    const enable = enableSmartLocal
    console.log(`[QUALITY] setRenderPrivateData handle=${previewHandle} enable=${enable}`)
    api.hcnetSetRenderPrivateData(previewHandle, enable)
    if (activeHwnd) {
      api.hcnetRedrawWindow(activeHwnd)
    }
  }, [enableSmartLocal, activeHwnd])

  // Native audio control (OpenSound/CloseSound) dynamically!
  useEffect(() => {
    const previewHandle = activeStreamRef.current?.previewHandle
    if (previewHandle === undefined || previewHandle < 0) return
    const enable = !isMuted
    console.log(`[AUDIO] setAudioEnabled handle=${previewHandle} enable=${enable}`)
    api.hcnetSetAudioEnabled(previewHandle, enable)
  }, [isMuted, activeHwnd])

  // Native SDK Fullscreen Transition Pipeline
  useEffect(() => {
    if (!activeHwnd || !nativeContainerRef.current) return
    if (!fullscreenPhase || !onTransitionComplete) return

    if (isSelected) {
      if (fullscreenPhase === 'entering') {
        isTransitioningRef.current = true
        if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
        transitionTimeoutRef.current = setTimeout(() => {
          if (isTransitioningRef.current) {
            console.warn('[FULLSCREEN] Safety timeout fired on entering')
            isTransitioningRef.current = false
          }
        }, 600)

        console.log(`[FULLSCREEN] transition entering generation=${fullscreenGeneration} myKey=${myKey}`)
        
        if (nativeContainerRef.current && activeHwnd) {
          const rect = nativeContainerRef.current.getBoundingClientRect()
          const scale = window.devicePixelRatio || 1
          const x = Math.round(rect.left * scale)
          const y = Math.round(rect.top * scale)
          const w = Math.round(rect.width * scale)
          const h = Math.round(rect.height * scale)
          
          console.log(`[FULLSCREEN] apply target bounds x=${x} y=${y} w=${w} h=${h}`)
          lastBoundsRef.current = { x, y, width: w, height: h }
          
          api.hcnetMoveWindow(activeHwnd, x, y, w, h)
            .then(() => api.hcnetSetWindowVisible(activeHwnd, true))
            .then(() => {
              if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
              isTransitioningRef.current = false
              onTransitionComplete('camera')
            })
            .catch((err) => {
              console.error('[FULLSCREEN] entering transition error:', err)
              if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
              isTransitioningRef.current = false
              onTransitionComplete('camera')
            })
        } else {
          if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
          isTransitioningRef.current = false
          onTransitionComplete('camera')
        }
      } else if (fullscreenPhase === 'exiting') {
        isTransitioningRef.current = true
        if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
        transitionTimeoutRef.current = setTimeout(() => {
          if (isTransitioningRef.current) {
            console.warn('[FULLSCREEN] Safety timeout fired on exiting')
            isTransitioningRef.current = false
          }
        }, 600)

        console.log(`[FULLSCREEN] transition exiting generation=${fullscreenGeneration} myKey=${myKey}`)
        
        if (nativeContainerRef.current && activeHwnd) {
          const rect = nativeContainerRef.current.getBoundingClientRect()
          const scale = window.devicePixelRatio || 1
          const x = Math.round(rect.left * scale)
          const y = Math.round(rect.top * scale)
          const w = Math.round(rect.width * scale)
          const h = Math.round(rect.height * scale)
          
          console.log(`[FULLSCREEN] restore grid bounds x=${x} y=${y} w=${w} h=${h}`)
          lastBoundsRef.current = { x, y, width: w, height: h }
          
          api.hcnetMoveWindow(activeHwnd, x, y, w, h)
            .then(() => api.hcnetSetWindowVisible(activeHwnd, true))
            .then(() => {
              if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
              isTransitioningRef.current = false
              onTransitionComplete('grid')
            })
            .catch((err) => {
              console.error('[FULLSCREEN] exiting transition error:', err)
              if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
              isTransitioningRef.current = false
              onTransitionComplete('grid')
            })
        } else {
          if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current)
          isTransitioningRef.current = false
          onTransitionComplete('grid')
        }
      }
    }
  }, [activeHwnd, fullscreenPhase, fullscreenKey, fullscreenGeneration])

  // Position listener via ResizeObserver
  useEffect(() => {
    if (!nativeContainerRef.current) return

    const updatePosition = () => {
      if (!nativeContainerRef.current || !activeHwnd) return
      
      // Pause standard ResizeObserver bounds updates while transitioning
      if (isTransitioningRef.current) {
        console.log('[FULLSCREEN] ResizeObserver ignored during transition')
        return
      }

      const rect = nativeContainerRef.current.getBoundingClientRect()
      // Guard against zero-size bounds updates during display: none transitions
      if (rect.width === 0 || rect.height === 0) return

      const scale = window.devicePixelRatio || 1
      const x = Math.round(rect.left * scale)
      const y = Math.round(rect.top * scale)
      const w = Math.round(rect.width * scale)
      const h = Math.round(rect.height * scale)

      const changed = !lastBoundsRef.current || 
        lastBoundsRef.current.x !== x ||
        lastBoundsRef.current.y !== y ||
        lastBoundsRef.current.width !== w ||
        lastBoundsRef.current.height !== h

      if (changed) {
        lastBoundsRef.current = { x, y, width: w, height: h }
        api.hcnetMoveWindow(activeHwnd, x, y, w, h)
      }
    }

    const observer = new ResizeObserver(() => {
      updatePosition()
    })
    observer.observe(nativeContainerRef.current)

    window.addEventListener('resize', updatePosition)
    
    updatePosition()
    
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
    }
  }, [activeHwnd, fullscreenPhase])

  const visibleTimeoutRef = useRef(null)

  // Track active fullscreen state in a ref to avoid recreating IntersectionObserver
  const isAnyFullscreenActiveRef = useRef(isAnyFullscreenActive)
  useEffect(() => {
    isAnyFullscreenActiveRef.current = isAnyFullscreenActive
  }, [isAnyFullscreenActive])

  // ── Grid Virtualization: detect visible state using IntersectionObserver (Debounced) ──
  useEffect(() => {
    const el = cellRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (visibleTimeoutRef.current) {
            clearTimeout(visibleTimeoutRef.current)
            visibleTimeoutRef.current = null
          }
          setIsVisible(true)
        } else {
          // If fullscreen mode is active, do not mark background streams as invisible
          if (isAnyFullscreenActiveRef.current) {
            return
          }
          if (!visibleTimeoutRef.current) {
            visibleTimeoutRef.current = setTimeout(() => {
              setIsVisible(false)
              visibleTimeoutRef.current = null
            }, 1500)
          }
        }
      },
      { threshold: 0.05 }
    )
    observer.observe(el)

    return () => {
      observer.disconnect()
      if (visibleTimeoutRef.current) {
        clearTimeout(visibleTimeoutRef.current)
      }
    }
  }, [])

  // ── Click = Fullscreen + HD, exit = revert resolution ────────────────
  // Double-click = panel-local fullscreen (within the grid)
  const handlePanelFullscreen = (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (connectionError) return // Prevent fullscreen on disconnected camera
    if (useStore.getState().isAppFullscreen) {
      useStore.getState().setAppFullscreen(false)
    }
    if (slot && onToggleFullscreen) {
      onToggleFullscreen(myKey)
    }
  }

  // Click-to-move: toggle move mode for this cell
  const handleMoveClick = useCallback((e) => {
    e.stopPropagation()
    const state = useStore.getState()
    if (state.movingCellIndex === index && state.movingPanelId === targetPanelId) {
      state.clearMovingCell()
    } else if (state.movingCellIndex === null && slot) {
      state.setMovingCell(targetPanelId, index)
    }
  }, [slot, targetPanelId, index])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('global-drag-end'))
    try {
      const dataStr = e.dataTransfer.getData('application/json')
      if (!dataStr) return
      const data = JSON.parse(dataStr)

      // Handle dragging from sidebar
      if (data.type === 'sidebar-camera') {
        // Prevent duplicate camera insertion in the same panel
        const isDuplicate = Object.values(panel?.cameraSlots || {}).some(
          s => s && s.deviceId === data.deviceId && s.channelId === data.channelId
        )
        if (isDuplicate) {
          console.warn('[DROP] Camera already exists in this panel, ignoring drop.')
          return
        }

        const newSlot = {
          deviceId: data.deviceId,
          channelId: data.channelId,
          streamName: data.name,
          resolution: 'SD'
        }
        setPanelSlot(targetPanelId, index, newSlot)
        return
      }

      // Handle swapping slots
      const { sourcePanelId, sourceIndex, slot: dragSlot } = data
      if (sourcePanelId === targetPanelId) {
        swapPanelSlots(targetPanelId, sourceIndex, index)
      }
    } catch (err) {
      console.error('Failed to swap slots:', err)
    }
  }, [panel?.cameraSlots, targetPanelId, index, setPanelSlot, swapPanelSlots])

  const handleToggleMute = (e) => {
    e.stopPropagation()
    const nextMute = !isMuted
    setIsMuted(nextMute)
    if (slot) {
      setPanelSlot(targetPanelId, index, { ...slot, muted: nextMute })
    }
  }

  const handleDoubleClick = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    if (connectionError) return // Prevent zoom on disconnected camera
    if (slot && !isDraggingRef.current && onToggleFullscreen) {
      onToggleFullscreen(myKey)
    }
  }, [connectionError, slot, onToggleFullscreen, myKey])

  const cols = Math.ceil(Math.sqrt(gridSize))
  const colIndex = (index % cols) + 1
  const rowIndex = Math.floor(index / cols) + 1

  const innerContent = useMemo(() => {
    if (!slot) {
      return (
        <div className="camera-cell-empty">
          <div className="camera-cell-empty-icon">📷</div>
          <div>{t('camera.dragHere')}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t('camera.orClickSidebar')}</div>
        </div>
      )
    }

    return (
      <>
        {/* Video viewport area */}
        <div
          className="camera-video-viewport"
          style={{
            flex: 1,
            position: 'relative',
            backgroundColor: '#000',
            overflow: 'hidden',
            contain: 'layout paint size'
          }}
        >
          {/* Native HWND container — always mounted to preserve ref for ResizeObserver/positioning */}
          <div
            ref={nativeContainerRef}
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: '#000',
              contain: 'strict',
              willChange: 'transform',
              display: connectionError ? 'none' : 'block'
            }}
          />
          {/* Click overlay to capture select, double click, and block SDK window pointer blocking */}
          {!connectionError && (
            <div
              onClick={(e) => {
                e.stopPropagation()
                setFocusedCellIndex(index)
              }}
              onDoubleClick={handleDoubleClick}
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 5,
                background: 'transparent',
                cursor: 'pointer'
              }}
            />
          )}
          {/* Disconnect / Error Overlay */}
          {connectionError && (
            <div
              className="camera-cell-error-overlay"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#16161a',
                padding: 16,
                zIndex: 2,
                textAlign: 'center',
                gap: 8,
                userSelect: 'none'
              }}
            >
              <div style={{ fontSize: 28, opacity: 0.7 }}>⚠️</div>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: 'var(--danger)' }}>
                {t('camera.cannotConnect')}
              </div>
              <div style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                maxWidth: '90%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical'
              }}>
                {connectionError.includes('Code: 11')
                  ? t('camera.channelOffline')
                  : connectionError.includes('Code: 47')
                  ? t('camera.connectionLimit')
                  : connectionError}
              </div>
              <button
                className="camera-cell-btn"
                style={{ marginTop: 4, width: 'auto', padding: '4px 12px', fontSize: 11 }}
                onClick={(e) => {
                  e.stopPropagation()
                  reloadStream()
                }}
                title={t('camera.retryTooltip')}
              >
                {t('camera.retry')}
              </button>
            </div>
          )}
        </div>

        {/* Reserved Control Strip (Chromium DOM, outside/below the native rendering HWND) */}
        <div
          className="camera-control-strip"
          style={{
            height: '32px',
            display: (isFullscreen || isAppFullscreen) ? 'none' : 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 8px',
            background: '#16161a',
            borderTop: '1px solid var(--border)',
            zIndex: 9,
            opacity: 1
          }}
          onPointerDown={(e) => {
            if (e.target.closest('[draggable]')) return
            e.stopPropagation()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {/* Left: Grab Handle + Camera Name + Offline Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            <span
              onClick={handleMoveClick}
              style={{
                opacity: 0.8,
                fontSize: 12,
                cursor: 'pointer',
                userSelect: 'none',
                padding: '2px 6px',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '4px',
                marginRight: '2px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '16px',
                height: '16px',
                lineHeight: '16px'
              }}
              title={t('camera.dragToSwap')}
            >
              ⋮⋮
            </span>
            <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {channel?.channelName || `${t('camera.ch')} ${slot.channelId}`}
            </span>
            {connectionError && (
              <span 
                style={{ 
                  fontSize: '9px', 
                  color: 'var(--danger)', 
                  background: 'rgba(255,60,60,0.15)', 
                  padding: '1px 5px', 
                  borderRadius: '3px',
                  fontWeight: 'bold'
                }}
                title={connectionError}
              >
                {connectionError.includes('Code: 11') ? t('common.offline') : t('common.error')}
              </span>
            )}
          </div>

          {/* Right: Static State Badges (No interactive buttons to avoid pointer lock) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            {enableSmartLocal && (
              <span style={{ fontSize: '9px', padding: '1px 4px', background: 'rgba(246,130,31,0.2)', color: 'var(--accent)', borderRadius: '3px', fontWeight: 'bold' }}>🧠 {t('camera.vca')}</span>
            )}
            {!isMuted && (
              <span style={{ fontSize: '9px', padding: '1px 4px', background: 'rgba(52,199,89,0.2)', color: '#34c759', borderRadius: '3px', fontWeight: 'bold' }}>🔊 {t('camera.audioOn')}</span>
            )}
            <span style={{ 
              fontSize: '9px', 
              fontWeight: 'bold', 
              color: resolvedQuality === 'HD' ? 'var(--accent)' : 'rgba(255,255,255,0.4)',
              border: `1px solid ${resolvedQuality === 'HD' ? 'var(--accent)' : 'rgba(255,255,255,0.15)'}`,
              padding: '1px 4px',
              borderRadius: '3px',
              background: resolvedQuality === 'HD' ? 'rgba(246,130,31,0.08)' : 'transparent'
            }}>
              {switchingQuality ? `🔄 ${switchingQuality}` : resolvedQuality}
            </span>
          </div>
        </div>
      </>
    )
  }, [
    slot,
    connectionError,
    enableSmartLocal,
    isMuted,
    resolvedQuality,
    switchingQuality,
    channel?.channelName,
    t,
    index,
    handleDoubleClick,
    handleMoveClick,
    reloadStream,
    setFocusedCellIndex
  ])

  return (
    <>
    <div
      ref={cellRef}
      className={`camera-cell ${isFullscreen ? 'fullscreen' : ''} ${isFocused ? 'selected' : ''} ${isSourceCell ? 'moving-source' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onDoubleClick={handleDoubleClick}
      onClick={() => {
        if (isMoveModeActive) {
          if (isSourceCell) {
            clearMovingCell()
          } else if (movingPanelId === targetPanelId) {
            swapPanelSlots(targetPanelId, movingCellIndex, index)
            clearMovingCell()
          }
          return
        }
        setFocusedCellIndex(index)
      }}
      data-index={index}
      style={{
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        ...style
      }}
    >
      {/* Sidebar drag drop zone (HTML5 drag from sidebar still works) */}
      {isDragActive && (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDrop={handleDrop}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 999999,
            background: 'rgba(246, 130, 31, 0.12)',
            border: '2px dashed var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent)',
            fontWeight: 'bold',
            fontSize: '14px',
            pointerEvents: 'auto'
          }}
        >
          {t('camera.dropToPlay')}
        </div>
      )}
      {/* Cell-to-cell click-to-move overlay */}
      {isMoveModeActive && !isSourceCell && !isDragActive && (
        <div
          onClick={(e) => {
            e.stopPropagation()
            if (movingPanelId === targetPanelId) {
              swapPanelSlots(targetPanelId, movingCellIndex, index)
            }
            clearMovingCell()
          }}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 999999,
            background: 'rgba(246, 130, 31, 0.15)',
            border: '2px dashed var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent)',
            fontWeight: 'bold',
            fontSize: '14px',
            cursor: 'pointer',
            pointerEvents: 'auto'
          }}
        >
          {t('camera.dropToPlay')}
        </div>
      )}
      {innerContent}
    </div>



    {/* Fullscreen close button - rendered outside camera-cell */}
    {isFullscreen && (
      <button
        style={{
          position: 'fixed', top: 12, right: 12,
          background: 'rgba(0,0,0,0.6)',
          border: 'none', borderRadius: 8,
          color: '#fff', padding: '6px 12px',
          cursor: 'pointer', fontSize: 13, zIndex: 1100
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={handlePanelFullscreen}
      >
        {t('common.exitFullscreen')}
      </button>
    )}



    {/* Toast Notification - rendered outside via Portal to isolate painting */}
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
        animation: 'fadeIn 0.3s ease',
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
    </>
  )
}
