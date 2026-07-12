/**
 * PlaybackView - Full native SDK playback UI matching iVMS-4200 design.
 * Features: Month calendar indicators, Zoomable & Panning timeline, Reverse playback, Full Speed controls, Audio, and Custom Download range.
 * Extended: Volume control (0-100), Smart rules toggle, and Interactive Electronic Zoom (clipping native windows).
 */

import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import PlaybackCalendar from './PlaybackCalendar';
import PlaybackToolbar from './PlaybackToolbar';
import PlaybackTimeline from './PlaybackTimeline';
import { playbackManager } from '../lib/playback-manager';
import { useStore } from '../store/useStore';
import { useLanguage } from '../i18n/useLanguage';

export function PlaybackView({ camera, onClose, onChangeCamera }) {
  const { t } = useLanguage();
  const { devices, isModalOpen } = useStore();
  const [isDragActive, setIsDragActive] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [recordings, setRecordings] = useState([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isReverse, setIsReverse] = useState(false);
  const [currentTime, setCurrentTime] = useState(null);
  const [speed, setSpeed] = useState(1);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [timelineScale, setTimelineScale] = useState(24); // 24 = 24h, 2 = 2h, etc.
  
  // Custom download state
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadStart, setDownloadStart] = useState('');
  const [downloadEnd, setDownloadEnd] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Keyboard shortcut modal state
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Time Window for Timeline
  const [winStart, setWinStart] = useState(new Date());
  const [winEnd, setWinEnd] = useState(new Date());

  // Extended features states
  const [enableSmart, setEnableSmart] = useState(true);
  const [zoomActive, setZoomActive] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 });
  const [volume, setVolume] = useState(50);
  const [toast, setToast] = useState(null);
  const downloadStartInputRef = useRef(null);
  const autoPlayTimerRef = useRef(null);

  const formatDatetimeLocal = (date) => {
    if (!date) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d}T${h}:${min}:${s}`;
  };

  const handleOpenDownloadModal = () => {
    // Keep the date of selectedDate, and use currentTime for hours/mins/secs if available
    const start = new Date(selectedDate);
    if (currentTime) {
      start.setHours(currentTime.getHours(), currentTime.getMinutes(), currentTime.getSeconds(), 0);
    } else {
      start.setHours(0, 0, 0, 0);
    }
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    
    setDownloadStart(formatDatetimeLocal(start));
    setDownloadEnd(formatDatetimeLocal(end));
    setShowDownloadModal(true);
  };
  const isSeekingRef = useRef(false);
  const seekLockTimeoutRef = useRef(null);

  function triggerSeekLock(duration = 3000) {
    if (seekLockTimeoutRef.current) {
      clearTimeout(seekLockTimeoutRef.current);
    }
    isSeekingRef.current = true;
    seekLockTimeoutRef.current = setTimeout(() => {
      isSeekingRef.current = false;
      seekLockTimeoutRef.current = null;
      // Clear seek target after lock expires so polling resumes normal validation
      seekTargetRef.current = null;
    }, duration);
  }

  // Track last valid time and seek target for robust jumpback prevention
  const lastValidTimeRef = useRef(null);
  const seekTargetRef = useRef(null);

  const showToast = (message, filePath) => {
    setToast({ message, filePath });
    setTimeout(() => setToast(null), 5000);
  };

  const videoRef = useRef(null);
  const nativePlaybackRef = useRef(null);
  const activeKeyRef = useRef(null);
  const api = window.electronAPI;

  const dragStartRef = useRef(null);
  const isDraggingRef = useRef(false);
  const clickStartRef = useRef(null);

  const dayStart = new Date(selectedDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(selectedDate);
  dayEnd.setHours(23, 59, 59, 999);

  // Synchronize Timeline window when selectedDate or timelineScale changes
  useEffect(() => {
    updateTimelineWindow(currentTime || new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 12, 0, 0));
  }, [selectedDate, timelineScale]);

  function updateTimelineWindow(centerTime) {
    if (timelineScale === 24) {
      setWinStart(dayStart);
      setWinEnd(dayEnd);
      return;
    }

    const centerMs = centerTime.getTime();
    const halfWinMs = (timelineScale / 2) * 60 * 60 * 1000;
    let startMs = centerMs - halfWinMs;
    let endMs = centerMs + halfWinMs;

    if (startMs < dayStart.getTime()) {
      startMs = dayStart.getTime();
      endMs = Math.min(dayEnd.getTime(), startMs + halfWinMs * 2);
    }
    if (endMs > dayEnd.getTime()) {
      endMs = dayEnd.getTime();
      startMs = Math.max(dayStart.getTime(), endMs - halfWinMs * 2);
    }
    setWinStart(new Date(startMs));
    setWinEnd(new Date(endMs));
  }
  // Handle global drag start and end
  useEffect(() => {
    const handleDragStart = () => setIsDragActive(true);
    const handleDragEnd = () => setIsDragActive(false);

    document.addEventListener('dragstart', handleDragStart);
    document.addEventListener('dragend', handleDragEnd);

    return () => {
      document.removeEventListener('dragstart', handleDragStart);
      document.removeEventListener('dragend', handleDragEnd);
    };
  }, []);

  const handlePlaybackDrop = (e) => {
    e.preventDefault();
    setIsDragActive(false);
    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const dragData = JSON.parse(dataStr);
      if (dragData.type !== 'sidebar-camera') return;

      const device = devices.find((d) => d.id === dragData.deviceId);
      if (!device) return;

      const newCamera = {
        id: `${device.id}_${dragData.channelId}`,
        name: `${device.name} - ${dragData.name}`,
        ip: device.ip,
        username: device.username,
        password: device.password,
        channel: parseInt(dragData.channelId, 10) || 1,
        nvrIp: device.ip,
        deviceId: device.id,
        streamEngine: device.streamEngine,
        channelName: dragData.name
      };

      if (onChangeCamera) {
        onChangeCamera(newCamera);
      }
    } catch (err) {
      console.error('[PlaybackView] Drop error:', err);
    }
  };

  // Load recordings when camera or selectedDate changes
  useEffect(() => {
    loadRecordings();
  }, [selectedDate, camera]);

  async function loadRecordings() {
    setIsLoading(true);
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }
    // Cleanup active playback
    if (nativePlaybackRef.current) {
      try {
        await api.hcnetStopPlayback(nativePlaybackRef.current.playbackKey);
      } catch (e) {}
      nativePlaybackRef.current = null;
      activeKeyRef.current = null;
      setIsPlaying(false);
      setCurrentTime(null);
    }

    // Trigger startPlaybackAt(dayStart) immediately without waiting for searchRecordings
    startPlaybackAt(dayStart);

    playbackManager.searchRecordings(
      camera.nvrIp,
      camera.channel,
      dayStart,
      dayEnd
    )
      .then(results => {
        setRecordings(results);
      })
      .catch(err => {
        console.error('Failed to load recordings:', err);
        setRecordings([]);
      });
  }

  async function handleSnapshot() {
    if (!nativePlaybackRef.current) return;
    try {
      const playbackKey = nativePlaybackRef.current.playbackKey;
      const channel = camera.channel;
      const result = await api.hcnetPlaybackSnapshot(playbackKey, channel);
      if (result && result.filePath) {
        showToast(`${t('playback.snapshotSaved')} ${result.filename || result.filePath.split('\\').pop()}`, result.filePath);
      } else {
        alert(t('playback.snapshotFailed'));
      }
    } catch (err) {
      console.error('[PlaybackView Snapshot] error:', err);
      alert(`${t('playback.snapshotError')} ${err.message}`);
    }
  }

  // Start native playback
  async function startPlaybackAt(time) {
    triggerSeekLock(3000);
    const endOfDay = new Date(selectedDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Reset zoom state on new playback stream
    setZoomLevel(1.0);
    setZoomOffset({ x: 0, y: 0 });

    // Record seek target for polling validation
    seekTargetRef.current = new Date(time);

    // Smooth seek if playback is active
    if (nativePlaybackRef.current) {
      try {
        const timeObj = {
          year: time.getFullYear(),
          month: time.getMonth() + 1,
          day: time.getDate(),
          hour: time.getHours(),
          minute: time.getMinutes(),
          second: time.getSeconds()
        };
        const seekSuccess = await api.hcnetSeekPlaybackTime(nativePlaybackRef.current.playbackKey, timeObj);
        if (seekSuccess) {
          setCurrentTime(time);
          setIsPlaying(true);
          updateTimelineWindow(time);
          return;
        }
      } catch (e) {
        console.error('[PlaybackView] Seek error:', e);
      }
    }

    // Full restart
    if (nativePlaybackRef.current) {
      try {
        await api.hcnetStopPlayback(nativePlaybackRef.current.playbackKey);
      } catch (e) {}
      nativePlaybackRef.current = null;
      activeKeyRef.current = null;
    }

    setIsLoading(true);
    if (!videoRef.current) {
      setIsLoading(false);
      return;
    }

    const rect = videoRef.current.getBoundingClientRect();
    const scaleFactor = window.devicePixelRatio || 1;
    const x = Math.round(rect.left * scaleFactor);
    const y = Math.round(rect.top * scaleFactor);
    const w = Math.round(rect.width * scaleFactor);
    const h = Math.round(rect.height * scaleFactor);

    try {
      const result = await api.hcnetStartPlayback(
        camera.deviceId,
        camera.channel,
        time.toISOString(),
        endOfDay.toISOString(),
        x, y, w, h
      );

      if (result && result.playbackHandle >= 0) {
        nativePlaybackRef.current = result;
        activeKeyRef.current = result.playbackKey;
        setIsPlaying(true);
        setCurrentTime(time);
        updateTimelineWindow(time);
        
        // Initial window move
        await api.hcnetMoveWindow(result.childHwnd, x, y, w, h);
        
        // Apply current enableSmart rules overlay
        await api.hcnetSetPlaybackRenderPrivateData(result.playbackKey, enableSmart);
        
        // Apply current audioEnabled state via hcnetSetPlaybackAudio
        await api.hcnetSetPlaybackAudio(result.playbackKey, audioEnabled);

        // Apply current volume level mapped to SDK range
        const sdkVolume = Math.round((volume / 100) * 65535);
        await api.hcnetControlPlayback(result.playbackKey, 11, sdkVolume);

        // Apply current speed value. If speed !== 1, trigger the SDK speed change.
        if (speed !== 1) {
          let cmd = 7; // NET_DVR_PLAYNORMAL = 7 (1x)
          let param = 0;
          const absSpeed = Math.abs(speed);

          if (absSpeed > 1) {
            cmd = 5; // NET_DVR_PLAYFAST
            param = absSpeed === 2 ? 0 : absSpeed === 4 ? 1 : absSpeed === 8 ? 2 : 3;
          } else if (absSpeed < 1) {
            cmd = 6; // NET_DVR_PLAYSLOW
            param = absSpeed === 0.5 ? 0 : absSpeed === 0.25 ? 1 : 2;
          }

          // Direction control
          const dirCmd = speed < 0 ? 30 : 29;
          await api.hcnetControlPlayback(result.playbackKey, dirCmd, 0);

          // Apply speed control
          await api.hcnetControlPlayback(result.playbackKey, cmd, param);

          setIsReverse(speed < 0);
        } else {
          setIsReverse(false);
        }
      } else {
        throw new Error(t('playback.sdkInitError'));
      }
    } catch (err) {
      console.error(err);
      alert(`${t('playback.playbackError')} ${err.message}`);
    }
    setIsLoading(false);
  }

  // Toggle play/pause
  function handleTogglePlay() {
    if (!nativePlaybackRef.current) return;
    if (isPlaying) {
      // Pause: NET_DVR_PLAYPAUSE = 3
      api.hcnetControlPlayback(nativePlaybackRef.current.playbackKey, 3, 0);
    } else {
      // Resume: NET_DVR_PLAYRESTART = 4
      api.hcnetControlPlayback(nativePlaybackRef.current.playbackKey, 4, 0);
    }
    setIsPlaying(!isPlaying);
  }

  // Toggle reverse
  function handleToggleReverse() {
    if (!nativePlaybackRef.current) return;
    const nextReverse = !isReverse;
    // NET_DVR_PLAY_REVERSE = 30, NET_DVR_PLAY_FORWARD = 29
    const cmd = nextReverse ? 30 : 29;
    api.hcnetControlPlayback(nativePlaybackRef.current.playbackKey, cmd, 0);
    setIsReverse(nextReverse);
    setIsPlaying(true);
  }

  // Step Frame
  function handleStepFrame() {
    if (!nativePlaybackRef.current) return;
    // NET_DVR_PLAYFRAME = 8
    api.hcnetControlPlayback(nativePlaybackRef.current.playbackKey, 8, 0);
    setIsPlaying(false);
  }

  // Speed adjust (Forward/Reverse, Fast/Slow)
  function handleChangeSpeed(newSpeed) {
    if (!nativePlaybackRef.current) return;
    setSpeed(newSpeed);

    let cmd = 7; // NET_DVR_PLAYNORMAL = 7 (1x)
    let param = 0;

    const absSpeed = Math.abs(newSpeed);

    if (absSpeed > 1) {
      cmd = 5; // NET_DVR_PLAYFAST
      // Speed mappings: 2x->0, 4x->1, 8x->2, 16x->3
      param = absSpeed === 2 ? 0 : absSpeed === 4 ? 1 : absSpeed === 8 ? 2 : 3;
    } else if (absSpeed < 1) {
      cmd = 6; // NET_DVR_PLAYSLOW
      // Slow mappings: 1/2x->0, 1/4x->1, 1/8x->2
      param = absSpeed === 0.5 ? 0 : absSpeed === 0.25 ? 1 : 2;
    }

    // Direction control
    const dirCmd = newSpeed < 0 ? 30 : 29;
    api.hcnetControlPlayback(nativePlaybackRef.current.playbackKey, dirCmd, 0);
    setIsReverse(newSpeed < 0);

    // Apply speed control
    api.hcnetControlPlayback(nativePlaybackRef.current.playbackKey, cmd, param);
    setIsPlaying(true);
  }

  // Audio control
  function handleToggleAudio() {
    if (!nativePlaybackRef.current) return;
    const nextAudio = !audioEnabled;
    api.hcnetSetPlaybackAudio(nativePlaybackRef.current.playbackKey, nextAudio);
    setAudioEnabled(nextAudio);
  }

  // Volume slider control
  function handleChangeVolume(newVolume) {
    setVolume(newVolume);
    if (nativePlaybackRef.current) {
      // Map 0-100 percentage to 0-65535 (0xffff) for the Hikvision SDK volume range
      const sdkVolume = Math.round((newVolume / 100) * 65535);
      // NET_DVR_PLAYAUDIOVOLUME = 11
      api.hcnetControlPlayback(nativePlaybackRef.current.playbackKey, 11, sdkVolume);
    }
  }

  // Smart Rules toggle control
  function handleToggleSmart() {
    const nextSmart = !enableSmart;
    setEnableSmart(nextSmart);
    if (nativePlaybackRef.current) {
      api.hcnetSetPlaybackRenderPrivateData(nativePlaybackRef.current.playbackKey, nextSmart);
      api.hcnetRedrawWindow(nativePlaybackRef.current.childHwnd);
    }
  }

  function handleRefresh() {
    startPlaybackAt(currentTime || dayStart);
  }

  // Playback end detection & Real-time time polling loop
  useEffect(() => {
    if (!activeKeyRef.current || !isPlaying) return;

    const interval = setInterval(async () => {
      if (isSeekingRef.current) return;
      const key = activeKeyRef.current;
      if (!key) return;

      try {
        // Poll current playback progress %
        const pos = await api.hcnetGetPlaybackProgress(key);
        if (pos === 100) {
          // Playback finished
          clearInterval(interval);
          setIsPlaying(false);
          alert(t('playback.playbackEnded'));
          return;
        }

        // Poll actual time
        const timeObj = await api.hcnetGetPlaybackTime(key);
        if (timeObj) {
          // Robust zero-time / garbage-time filter:
          // SDK returns empty NET_DVR_TIME during buffer transitions.
          // Filter: year=0 (some NVRs omit year), OR all-same-as-zero means invalid.
          // Also reject times that differ from last known good time by > 5 minutes
          // when we have a pending seek target (prevents jumpback during buffer).
          const isInvalidTime =
            (timeObj.year === 0 && timeObj.hour === 0 && timeObj.minute === 0 && timeObj.second === 0) ||
            (timeObj.year === 0 && timeObj.hour === 12 && timeObj.minute === 0 && timeObj.second === 0);

          if (!isInvalidTime) {
            const date = new Date(selectedDate);
            date.setHours(timeObj.hour, timeObj.minute, timeObj.second, 0);

            // Validate against seek target: if we have a pending seek and the polled
            // time is more than 5 minutes away from it, reject as SDK garbage.
            if (seekTargetRef.current) {
              const diffMs = Math.abs(date.getTime() - seekTargetRef.current.getTime());
              if (diffMs > 5 * 60 * 1000) {
                // SDK returned a stale/garbage time during buffer transition — skip update
                return;
              }
            }

            // Validate against last known good time: reject sudden backwards jumps > 60s
            // (normal playback goes forward; seek sets currentTime directly)
            if (lastValidTimeRef.current) {
              const backDiffMs = lastValidTimeRef.current.getTime() - date.getTime();
              if (backDiffMs > 60 * 1000 && !isSeekingRef.current) {
                // Unexpected backwards jump — skip this poll cycle
                return;
              }
            }

            lastValidTimeRef.current = date;
            setCurrentTime(date);
          }
        }
      } catch (err) {
        console.error('[PlaybackView] Loop error:', err);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [isPlaying, selectedDate]);

  // Window positioning and electronic zoom clipping pipeline
  const updatePosition = () => {
    if (!videoRef.current || !nativePlaybackRef.current) return;
    const rect = videoRef.current.getBoundingClientRect();
    const scaleFactor = window.devicePixelRatio || 1;

    // Viewport coordinates on screen (parent relative)
    const vx = Math.round(rect.left * scaleFactor);
    const vy = Math.round(rect.top * scaleFactor);
    const vw = Math.round(rect.width * scaleFactor);
    const vh = Math.round(rect.height * scaleFactor);

    const childHwnd = nativePlaybackRef.current.childHwnd;

    if (zoomLevel > 1.0) {
      // Scale video size
      const w = Math.round(vw * zoomLevel);
      const h = Math.round(vh * zoomLevel);

      // Compute top-left of the expanded video including panning offset
      const x = Math.round(vx - (vw * (zoomLevel - 1) / 2) + (zoomOffset.x * scaleFactor));
      const y = Math.round(vy - (vh * (zoomLevel - 1) / 2) + (zoomOffset.y * scaleFactor));

      // Move expanded window
      api.hcnetMoveWindow(childHwnd, x, y, w, h);

      // Compute region to crop (relative to child window top-left coordinate system)
      const left = vx - x;
      const top = vy - y;
      const right = left + vw;
      const bottom = top + vh;

      // Apply crop
      api.hcnetSetWindowClip(childHwnd, left, top, right, bottom);
    } else {
      // Normal display (1x)
      api.hcnetMoveWindow(childHwnd, vx, vy, vw, vh);
      // Remove any clipping
      api.hcnetSetWindowClip(childHwnd, 0, 0, 0, 0);
    }
  };

  // Re-run window bounds sync when zoom changes
  useEffect(() => {
    updatePosition();
  }, [zoomLevel, zoomOffset]);

  // Window resize observer
  useEffect(() => {
    if (!videoRef.current) return;

    const observer = new ResizeObserver(updatePosition);
    observer.observe(videoRef.current);
    window.addEventListener('resize', updatePosition);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [zoomLevel, zoomOffset]);

  const isAnyModalActive = isModalOpen || showDownloadModal || showShortcuts;

  // Hide/show playback native window based on modal visibility to allow keyboard focus in modals
  useEffect(() => {
    if (nativePlaybackRef.current) {
      const desiredVisibility = !isAnyModalActive && isPlaying;
      api.hcnetSetWindowVisible(nativePlaybackRef.current.childHwnd, desiredVisibility);
    }
  }, [isAnyModalActive, isPlaying]);

  // Focus and select download input when modal opens to resolve focus stealing in Electron
  useEffect(() => {
    if (showDownloadModal) {
      setTimeout(() => {
        downloadStartInputRef.current?.focus();
        downloadStartInputRef.current?.select();
      }, 150);
    }
  }, [showDownloadModal]);

  // Unmount cleanup
  useEffect(() => {
    return () => {
      if (nativePlaybackRef.current) {
        api.hcnetSetWindowVisible(nativePlaybackRef.current.childHwnd, false);
        api.hcnetStopPlayback(nativePlaybackRef.current.playbackKey);
      }
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current);
      }
      if (seekLockTimeoutRef.current) {
        clearTimeout(seekLockTimeoutRef.current);
      }
    };
  }, []);

  // Electronic Zoom Mouse Handlers (Scroll & Drag-to-Pan)
  const handleWheel = (e) => {
    if (!zoomActive || !nativePlaybackRef.current) return;
    e.preventDefault();

    const zoomStep = 0.25;
    let nextZoom = zoomLevel + (e.deltaY < 0 ? zoomStep : -zoomStep);
    nextZoom = Math.max(1.0, Math.min(4.0, nextZoom));

    if (nextZoom !== zoomLevel) {
      if (nextZoom === 1.0) {
        // Reset offset on zoom out
        setZoomOffset({ x: 0, y: 0 });
      }
      setZoomLevel(nextZoom);
    }
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return; // Only left click drag
    clickStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      time: Date.now()
    };
    if (!zoomActive || zoomLevel <= 1.0) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX - zoomOffset.x,
      y: e.clientY - zoomOffset.y
    };
  };

  const handleMouseMove = (e) => {
    if (!isDraggingRef.current || !dragStartRef.current) return;
    
    // Bounds check to avoid panning too far away from the viewport borders
    const newX = e.clientX - dragStartRef.current.x;
    const newY = e.clientY - dragStartRef.current.y;
    
    const maxOffsetX = (videoRef.current.clientWidth * (zoomLevel - 1)) / 2;
    const maxOffsetY = (videoRef.current.clientHeight * (zoomLevel - 1)) / 2;

    setZoomOffset({
      x: Math.max(-maxOffsetX, Math.min(maxOffsetX, newX)),
      y: Math.max(-maxOffsetY, Math.min(maxOffsetY, newY))
    });
  };

  const handleMouseUp = (e) => {
    isDraggingRef.current = false;
    if (clickStartRef.current) {
      const duration = Date.now() - clickStartRef.current.time;
      const dx = e.clientX - clickStartRef.current.x;
      const dy = e.clientY - clickStartRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (duration < 250 && distance < 6) {
        handleTogglePlay();
      }
      clickStartRef.current = null;
    }
  };

  // Keyboard shortcuts listener
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (showDownloadModal) return; // Ignore keys when popup is visible

      const tag = e.target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          handleTogglePlay();
          break;
        case 'KeyR':
          handleToggleReverse();
          break;
        case 'Period':
          handleStepFrame();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (currentTime) {
            const newTime = new Date(currentTime.getTime() - 30 * 1000);
            startPlaybackAt(newTime);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (currentTime) {
            const newTime = new Date(currentTime.getTime() + 30 * 1000);
            startPlaybackAt(newTime);
          }
          break;
        case 'Equal':
        case 'NumpadAdd':
          e.preventDefault();
          // Increase speed
          const nextSpeedIndex = Math.min(16, speed * 2);
          if (nextSpeedIndex !== speed) handleChangeSpeed(nextSpeedIndex);
          break;
        case 'Minus':
        case 'NumpadSubtract':
          e.preventDefault();
          // Decrease speed
          const prevSpeedIndex = Math.max(0.125, speed / 2);
          if (prevSpeedIndex !== speed) handleChangeSpeed(prevSpeedIndex);
          break;
        case 'Slash':
          if (e.shiftKey) {
            setShowShortcuts(prev => !prev);
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, isReverse, speed, currentTime, showDownloadModal]);

  // Handle Download process
  async function triggerDownload() {
    setDownloading(true);
    setDownloadProgress(0);

    const start = new Date(downloadStart);
    const end = new Date(downloadEnd);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      alert('Thời gian tải xuống không hợp lệ!');
      setDownloading(false);
      return;
    }

    try {
      // Mock progress since downloadFile runs natively
      const interval = setInterval(() => {
        setDownloadProgress(prev => {
          if (prev >= 90) {
            clearInterval(interval);
            return 90;
          }
          return prev + 10;
        });
      }, 500);

      const dev = devices.find(d => d.id === camera.deviceId || d.id === camera.id);
      const nvrIp = camera.nvrIp || camera.ip || dev?.ip;
      const ch = camera.channel || 1;
      const username = dev?.username || camera.username || 'admin';
      const password = dev?.password || camera.password || '12345';
      const httpPort = dev?.port || 80;
      const nvrHost = httpPort !== 80 ? `${nvrIp}:${httpPort}` : nvrIp;
      
      // Format to Hikvision RTSP time format: YYYYMMDDTHHMMSSZ (no dashes/colons)
      const formatRtspTime = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const startTimeStr = formatRtspTime(start);
      const endTimeStr = formatRtspTime(end);

      // Tìm bản ghi tương thích để trích xuất playbackURI thực tế do đầu ghi trả về (chứa name, size, v.v...)
      let playbackURI = null;
      const matchedRec = recordings.find(rec => {
        const recStart = new Date(rec.startTime);
        const recEnd = new Date(rec.endTime);
        return (start >= recStart && start <= recEnd) || (end >= recStart && end <= recEnd) || (recStart >= start && recStart <= end);
      });

      if (matchedRec?.sourceUrl) {
        try {
          const httpUrl = matchedRec.sourceUrl.replace(/^rtsp:/i, 'http:');
          const parsed = new URL(httpUrl);
          parsed.searchParams.set('starttime', startTimeStr);
          parsed.searchParams.set('endtime', endTimeStr);
          playbackURI = parsed.toString().replace(/^http:/i, 'rtsp:');
        } catch (err) {
          console.error('[PlaybackView] Error parsing matched record sourceUrl:', err);
        }
      }

      console.log('[triggerDownload] start:', start, 'end:', end)
      console.log('[triggerDownload] matchedRec:', matchedRec)
      console.log('[triggerDownload] final playbackURI:', playbackURI)
 
      let result = { success: false, reason: 'API not ready' };
      if (api?.downloadFile) {
        result = await api.downloadFile({
          nvrIp,
          httpPort,
          channel: ch,
          startTimeStr,
          endTimeStr,
          username,
          password,
          playbackURI
        });
      } else {
        const targetUrl = playbackURI || `rtsp://${nvrIp}/Streaming/tracks/${ch}01?starttime=${startTimeStr}&endtime=${endTimeStr}`;
        const downloadUrl = `http://${nvrHost}/ISAPI/ContentMgmt/download?playbackURI=${encodeURIComponent(targetUrl)}`;
        window.open(downloadUrl);
        result = { success: true };
      }
      
      clearInterval(interval);

      if (result && result.success) {
        setDownloadProgress(100);
        showToast(t('playback.downloadSuccess'));
        setShowDownloadModal(false);
      } else {
        setDownloadProgress(0);
        if (result?.reason !== 'cancelled') {
          alert(`${t('playback.downloadFailed')} ${result?.reason || 'Unknown error'}`);
        }
      }
    } catch (err) {
      alert(`${t('playback.downloadFailed')} ${err.message}`);
    }
    setDownloading(false);
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 9998,
      backgroundColor: '#0c0c14',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Top Header Bar */}
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        backgroundColor: '#12121a',
        borderBottom: '1px solid var(--border)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onClose}
            className="btn btn-secondary btn-sm"
            style={{ background: 'none', border: 'none', color: '#fff', fontSize: 14, cursor: 'pointer' }}
          >
            {t('playback.backButton')}
          </button>
          <span style={{ color: '#fff', fontSize: 13, fontWeight: 'bold' }}>
            {t('playback.headerPrefix')} {camera.name || `CAM ${camera.id}`}
          </span>
        </div>
      </div>

      {/* Main Container: Sidebar Left, Video and Timeline Right */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        
        {/* Left Sidebar (Calendar & Camera info) */}
        <div style={{
          width: 280,
          backgroundColor: '#12121a',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          padding: 16,
          gap: 16,
          overflowY: 'auto'
        }}>
          <div>
            <h4 style={{ color: 'var(--text-secondary)', fontSize: 11, textTransform: 'uppercase', marginBottom: 8 }}>{t('playback.selectDate')}</h4>
            <PlaybackCalendar
              selectedDate={selectedDate}
              onChangeDate={setSelectedDate}
              camera={camera}
            />
          </div>

          <div style={{
            backgroundColor: '#1e1e2f',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            color: 'var(--text-secondary)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}>
            <h4 style={{ color: '#fff', fontWeight: 'bold', margin: '0 0 4px 0' }}>{t('playback.cameraInfo')}</h4>
            <div>{t('playback.nvrIP')} {camera.nvrIp}</div>
            <div>{t('playback.nvrChannel')} {camera.channel}</div>
            <div>{t('playback.streamRes')} {t('playback.sdLabel')} / {t('playback.hdLabel')}</div>
          </div>
        </div>

        {/* Right Content Area (Video viewport + Timeline) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          
          {/* Video window container */}
          <div 
            style={{ 
              flex: 1, 
              position: 'relative', 
              backgroundColor: '#000',
              cursor: (zoomActive && zoomLevel > 1.0) ? 'move' : 'pointer'
            }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            {isDragActive && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                }}
                onDrop={handlePlaybackDrop}
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
                  fontSize: '16px',
                  pointerEvents: 'auto',
                  textShadow: '0 2px 4px rgba(0,0,0,0.8)'
                }}
              >
                {t('playback.dropToPlayback')}
              </div>
            )}
            <div
              ref={videoRef}
              style={{ width: '100%', height: '100%', contain: 'strict' }}
            />

            {isLoading && (
              <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#fff',
                backgroundColor: 'rgba(0,0,0,0.8)',
                padding: '12px 24px',
                borderRadius: 8,
                fontSize: 13,
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                gap: 8
              }}>
                <span className="spinner" /> {t('playback.loadingSDK')}
              </div>
            )}

            {!isPlaying && !isLoading && recordings.length === 0 && (
              <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: 'var(--text-muted)',
                textAlign: 'center'
              }}>
                <span style={{ fontSize: 40, display: 'block', marginBottom: 8 }}>📁</span>
                {t('playback.noVideoData')}
              </div>
            )}

            {/* Zoom level overlay indicator */}
            {zoomActive && zoomLevel > 1.0 && (
              <div style={{
                position: 'absolute',
                top: 12,
                left: 12,
                background: 'rgba(0,0,0,0.7)',
                color: 'var(--accent)',
                padding: '4px 10px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 'bold',
                zIndex: 10,
                border: '1px solid var(--border)'
              }}>
                {t('playback.zoomOverlay', { level: zoomLevel.toFixed(2) })}
              </div>
            )}

            {isDragActive && (
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handlePlaybackDrop}
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 999999,
                  background: 'rgba(246, 130, 31, 0.15)',
                  border: '2px dashed var(--accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontSize: 16,
                  fontWeight: 'bold',
                  pointerEvents: 'auto'
                }}
              >
                {t('playback.dropToPlayback')}
              </div>
            )}
          </div>

          {/* Bottom Bar: Timeline & Control buttons */}
          <div style={{
            backgroundColor: '#12121a',
            borderTop: '1px solid var(--border)',
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12
          }}>
            {/* Timeline */}
            <PlaybackTimeline
              selectedDate={selectedDate}
              recordings={recordings}
              currentTime={currentTime}
              onSeek={startPlaybackAt}
              scale={timelineScale}
              onChangeScale={setTimelineScale}
              winStart={winStart}
              winEnd={winEnd}
              onChangeWindow={(s, e) => {
                setWinStart(s);
                setWinEnd(e);
              }}
            />

            {/* Controls toolbar */}
            <PlaybackToolbar
              isPlaying={isPlaying}
              isReverse={isReverse}
              speed={speed}
              audioEnabled={audioEnabled}
              currentTime={currentTime}
              hasActivePlayback={!!nativePlaybackRef.current}
              onTogglePlay={handleTogglePlay}
              onToggleReverse={handleToggleReverse}
              onStepFrame={handleStepFrame}
              onChangeSpeed={handleChangeSpeed}
              onToggleAudio={handleToggleAudio}
              onDownloadClick={handleOpenDownloadModal}
              onShowShortcuts={() => setShowShortcuts(true)}
              enableSmart={enableSmart}
              onToggleSmart={handleToggleSmart}
              zoomActive={zoomActive}
              onToggleZoom={() => {
                const nextZoomActive = !zoomActive;
                setZoomActive(nextZoomActive);
                if (!nextZoomActive) {
                  // Reset zoom state on zoom deactivated
                  setZoomLevel(1.0);
                  setZoomOffset({ x: 0, y: 0 });
                }
              }}
              volume={volume}
              onChangeVolume={handleChangeVolume}
              onSnapshot={handleSnapshot}
              onRefresh={handleRefresh}
              onSeek={startPlaybackAt}
              selectedDate={selectedDate}
            />
          </div>

        </div>

      </div>

      {/* CUSTOM RANGE DOWNLOAD MODAL */}
      {showDownloadModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.7)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <div style={{
            backgroundColor: '#1e1e2f',
            border: '1px solid var(--border)',
            borderRadius: 8,
            width: 380,
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            color: '#fff'
          }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 'bold' }}>{t('playback.downloadTitle')}</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('playback.startTime')}</label>
              <input
                ref={downloadStartInputRef}
                type="datetime-local"
                step="1"
                value={downloadStart}
                onChange={(e) => setDownloadStart(e.target.value)}
                style={{
                  background: '#12121a',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  color: '#fff',
                  padding: 8,
                  fontSize: 13,
                  colorScheme: 'dark'
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('playback.endTime')}</label>
              <input
                type="datetime-local"
                step="1"
                value={downloadEnd}
                onChange={(e) => setDownloadEnd(e.target.value)}
                style={{
                  background: '#12121a',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  color: '#fff',
                  padding: 8,
                  fontSize: 13,
                  colorScheme: 'dark'
                }}
              />
            </div>

            {downloading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span>{t('playback.downloading')}</span>
                  <span>{downloadProgress}%</span>
                </div>
                <div style={{ height: 6, backgroundColor: '#12121a', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${downloadProgress}%`, height: '100%', backgroundColor: 'var(--accent)' }} />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowDownloadModal(false)}
                disabled={downloading}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--accent)', color: '#000' }}
                onClick={triggerDownload}
                disabled={downloading}
              >
                {downloading ? t('playback.downloadingBtn') : t('playback.downloadBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* KEYBOARD SHORTCUTS MODAL */}
      {showShortcuts && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.7)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }} onClick={() => setShowShortcuts(false)}>
          <div style={{
            backgroundColor: '#1e1e2f',
            border: '1px solid var(--border)',
            borderRadius: 8,
            width: 400,
            padding: 24,
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            gap: 12
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}>
              <span>{t('playback.shortcutsTitle')}</span>
              <button onClick={() => setShowShortcuts(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}>✕</button>
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 16px', fontSize: 13, marginTop: 8 }}>
              <strong style={{ color: 'var(--accent)' }}>Space</strong> <span>{t('playback.shortcutPause')}</span>
              <strong style={{ color: 'var(--accent)' }}>R</strong> <span>{t('playback.shortcutReverse')}</span>
              <strong style={{ color: 'var(--accent)' }}>{t('playback.shortcutStepKey')}</strong> <span>{t('playback.shortcutStep')}</span>
              <strong style={{ color: 'var(--accent)' }}>{t('playback.shortcutSeekKey')}</strong> <span>{t('playback.shortcutSeek')}</span>
              <strong style={{ color: 'var(--accent)' }}>{t('playback.shortcutSpeedKey')}</strong> <span>{t('playback.shortcutSpeed')}</span>
              <strong style={{ color: 'var(--accent)' }}>{t('playback.shortcutZoomKey')}</strong> <span>{t('playback.shortcutZoom')}</span>
            </div>
          </div>
        </div>
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
  );
}

export default PlaybackView;
