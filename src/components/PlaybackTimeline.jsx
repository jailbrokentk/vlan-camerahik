import React, { useRef, useState, useEffect } from 'react';
import { useLanguage } from '../i18n/useLanguage';

const SCALES = [24, 6, 2, 1, 0.5, 0.25]; // 24h, 6h, 2h, 1h, 30m, 15m

export function PlaybackTimeline({
  selectedDate,
  recordings,
  currentTime,
  onSeek,
  scale,
  onChangeScale,
  winStart,
  winEnd,
  onChangeWindow
}) {
  const { t } = useLanguage();
  const timelineRef = useRef(null);
  const [hoverTime, setHoverTime] = useState(null);
  const [hoverX, setHoverX] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, winStartMs: 0, winEndMs: 0 });
  const lastSeekTimeRef = useRef(0);
  const dragModeRef = useRef('seek');

  const dayStart = new Date(selectedDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(selectedDate);
  dayEnd.setHours(23, 59, 59, 999);

  // Percent calculator
  function getTimePercent(time) {
    if (!time) return 0;
    const tMs = typeof time === 'string' ? new Date(time).getTime() : time.getTime();
    const startMs = winStart.getTime();
    const endMs = winEnd.getTime();
    if (endMs === startMs) return 0;
    const pct = ((tMs - startMs) / (endMs - startMs)) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  // Handle mouse down
  function handleMouseDown(e) {
    if (!timelineRef.current) return;
    setIsDragging(true);

    // Shift + Left-click sets dragModeRef.current = 'pan' and pans (only if scale !== 24)
    if (e.shiftKey && scale !== 24) {
      dragModeRef.current = 'pan';
      dragStartRef.current = {
        x: e.clientX,
        winStartMs: winStart.getTime(),
        winEndMs: winEnd.getTime()
      };
    } else {
      // Left-click normally sets dragModeRef.current = 'seek' and seeks instantly
      dragModeRef.current = 'seek';
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, x / rect.width));
      const startMs = winStart.getTime();
      const endMs = winEnd.getTime();
      const targetMs = startMs + percent * (endMs - startMs);
      const targetDate = new Date(targetMs);

      lastSeekTimeRef.current = Date.now();
      onSeek(targetDate);
    }
  }

  // Handle mouse move (hover and drag)
  function handleMouseMove(e) {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));

    const startMs = winStart.getTime();
    const endMs = winEnd.getTime();
    const hoverMs = startMs + percent * (endMs - startMs);

    const hTime = new Date(hoverMs);
    setHoverX(x);
    setHoverTime(hTime);

    if (isDragging) {
      if (dragModeRef.current === 'pan' && scale !== 24) {
        // Handle panning (dragging timeline)
        const deltaX = e.clientX - dragStartRef.current.x;
        const msPerPixel = (dragStartRef.current.winEndMs - dragStartRef.current.winStartMs) / rect.width;
        const deltaMs = deltaX * msPerPixel;

        let newStartMs = dragStartRef.current.winStartMs - deltaMs;
        let newEndMs = dragStartRef.current.winEndMs - deltaMs;

        // Bound to current day
        if (newStartMs < dayStart.getTime()) {
          const diff = dayStart.getTime() - newStartMs;
          newStartMs += diff;
          newEndMs += diff;
        }
        if (newEndMs > dayEnd.getTime()) {
          const diff = newEndMs - dayEnd.getTime();
          newStartMs -= diff;
          newEndMs -= diff;
        }

        onChangeWindow(new Date(newStartMs), new Date(newEndMs));
      } else if (dragModeRef.current === 'seek') {
        // Seek throttled by 150ms
        const now = Date.now();
        if (now - lastSeekTimeRef.current >= 150) {
          lastSeekTimeRef.current = now;
          onSeek(hTime);
        }
      }
    }
  }

  // Handle mouse up / leave
  function handleMouseUpOrLeave(e) {
    if (isDragging && dragModeRef.current === 'seek' && timelineRef.current) {
      // Seek once more to the final hoverTime
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, x / rect.width));
      const startMs = winStart.getTime();
      const endMs = winEnd.getTime();
      const targetMs = startMs + percent * (endMs - startMs);
      onSeek(new Date(targetMs));
    }
    setIsDragging(false);
    setHoverX(null);
    setHoverTime(null);
  }

  // Zoom on wheel scroll
  function handleWheel(e) {
    e.preventDefault();
    if (!timelineRef.current) return;
    
    // Zoom in or out
    const currentIdx = SCALES.indexOf(scale);
    let nextIdx = currentIdx;
    if (e.deltaY < 0) {
      // Zoom in
      nextIdx = Math.min(SCALES.length - 1, currentIdx + 1);
    } else {
      // Zoom out
      nextIdx = Math.max(0, currentIdx - 1);
    }

    if (nextIdx !== currentIdx) {
      const newScale = SCALES[nextIdx];
      onChangeScale(newScale);
    }
  }

  // Generate tick marks dynamically based on scale
  const ticks = [];
  const startMs = winStart.getTime();
  const endMs = winEnd.getTime();

  if (scale === 24) {
    for (let i = 0; i <= 24; i++) {
      ticks.push({
        percent: (i / 24) * 100,
        label: i % 2 === 0 && i < 24 ? `${String(i).padStart(2, '0')}:00` : null,
        isMajor: i % 6 === 0
      });
    }
  } else {
    // 6h scale -> ticks every 30m, labels every 1h
    // 2h scale -> ticks every 10m, labels every 20m
    // 1h scale -> ticks every 5m, labels every 10m
    // 30m scale -> ticks every 2m, labels every 5m
    // 15m scale -> ticks every 1m, labels every 2m
    let stepMin = 10;
    let labelStepMin = 20;

    if (scale === 6) { stepMin = 30; labelStepMin = 60; }
    else if (scale === 2) { stepMin = 10; labelStepMin = 20; }
    else if (scale === 1) { stepMin = 5; labelStepMin = 10; }
    else if (scale === 0.5) { stepMin = 2; labelStepMin = 5; }
    else if (scale === 0.25) { stepMin = 1; labelStepMin = 2; }

    const startMin = Math.ceil(winStart.getMinutes() / stepMin) * stepMin;
    const firstTickTime = new Date(winStart);
    firstTickTime.setMinutes(startMin, 0, 0);

    let curr = firstTickTime.getTime();
    while (curr <= endMs) {
      const pct = ((curr - startMs) / (endMs - startMs)) * 100;
      const date = new Date(curr);
      const min = date.getMinutes();
      const label = min % labelStepMin === 0 ? date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
      ticks.push({
        percent: pct,
        label,
        isMajor: min % labelStepMin === 0
      });
      curr += stepMin * 60 * 1000;
    }
  }

  function formatTime(date) {
    if (!date) return '--:--:--';
    return date.toLocaleTimeString('en-GB', { hour12: false });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Zoom scale selectors */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('timeline.scrollHint')}</span>
        <div style={{ display: 'flex', gap: 2, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          {SCALES.map((s) => {
            const label = s === 24 ? '24h' : s === 6 ? '6h' : s === 2 ? '2h' : s === 1 ? '1h' : s === 0.5 ? '30m' : '15m';
            return (
              <button
                key={s}
                onClick={() => onChangeScale(s)}
                style={{
                  background: scale === s ? 'var(--accent)' : 'var(--bg-hover)',
                  color: scale === s ? '#000' : '#fff',
                  border: 'none',
                  padding: '4px 10px',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  transition: 'all 0.1s ease'
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main timeline wrapper */}
      <div
        ref={timelineRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUpOrLeave}
        onMouseLeave={handleMouseUpOrLeave}
        style={{
          position: 'relative',
          height: 48,
          backgroundColor: '#151522',
          borderRadius: 6,
          cursor: scale === 24 ? 'crosshair' : isDragging ? 'grabbing' : 'grab',
          overflow: 'visible',
          border: '1px solid var(--border)',
          marginTop: 8,
          boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.5)',
          userSelect: 'none'
        }}
      >
        {/* Recording segments (color coded) */}
        {recordings.map((rec, i) => {
          const startPercent = getTimePercent(rec.startTime);
          const endPercent = getTimePercent(rec.endTime);
          const width = endPercent - startPercent;

          if (width <= 0) return null;

          // Type color coding: Continuous (standard blue-ish or amber)
          const isEvent = rec.sourceUrl && rec.sourceUrl.includes('motion'); // Simple mock detection
          const segmentBg = isEvent 
            ? 'rgba(239, 68, 68, 0.45)' // Red-ish for event
            : 'rgba(246, 130, 31, 0.45)'; // Orange/Continuous

          const borderColors = isEvent ? '#ef4444' : 'var(--accent)';

          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${startPercent}%`,
                width: `${width}%`,
                top: 0,
                bottom: 0,
                backgroundColor: segmentBg,
                borderLeft: `1px solid ${borderColors}`,
                borderRight: `1px solid ${borderColors}`,
                transition: 'left 0.1s ease, width 0.1s ease'
              }}
            />
          );
        })}

        {/* Current position indicator (red glow line) */}
        {currentTime && currentTime >= winStart && currentTime <= winEnd && (
          <div
            style={{
              position: 'absolute',
              left: `${getTimePercent(currentTime)}%`,
              top: -6,
              bottom: -6,
              width: 3,
              backgroundColor: '#ef4444',
              zIndex: 3,
              boxShadow: '0 0 10px #ef4444, 0 0 4px #ef4444',
              pointerEvents: 'none',
              borderRadius: 2
            }}
          />
        )}

        {/* Hover preview tooltip */}
        {hoverTime && hoverX !== null && (
          <>
            {/* Vertical line indicator */}
            <div
              style={{
                position: 'absolute',
                left: hoverX,
                top: 0,
                bottom: 0,
                width: 1,
                borderLeft: '1px dashed rgba(255,255,255,0.4)',
                pointerEvents: 'none',
                zIndex: 2
              }}
            />
            {/* Tooltip box */}
            <div
              style={{
                position: 'absolute',
                left: hoverX,
                transform: 'translateX(-50%)',
                top: -36,
                backgroundColor: '#1e1e2f',
                border: '1px solid var(--border)',
                color: '#fff',
                padding: '4px 8px',
                borderRadius: 4,
                fontSize: 10,
                fontFamily: 'monospace',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                zIndex: 10,
                boxShadow: '0 4px 12px rgba(0,0,0,0.6)'
              }}
            >
              {formatTime(hoverTime)}
            </div>
          </>
        )}

        {/* Tick markers */}
        {ticks.map((t, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${t.percent}%`,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: t.isMajor ? '#444' : '#2a2a2a',
              pointerEvents: 'none'
            }}
          >
            {t.label && (
              <span
                style={{
                  position: 'absolute',
                  bottom: -22,
                  left: '-50%',
                  transform: 'translateX(-40%)',
                  fontSize: 9,
                  color: '#888',
                  whiteSpace: 'nowrap',
                  fontFamily: 'monospace'
                }}
              >
                {t.label}
              </span>
            )}
          </div>
        ))}
      </div>
      <div style={{ height: 18 }} />
    </div>
  );
}

export default PlaybackTimeline;
