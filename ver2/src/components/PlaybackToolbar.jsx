import React from 'react';
import { useLanguage } from '../i18n/useLanguage';

const SPEED_LABELS = {
  '-16': '⏪ 16x',
  '-8': '⏪ 8x',
  '-4': '⏪ 4x',
  '-2': '⏪ 2x',
  '-1': '⏪ 1x',
  '-0.5': '⏪ 1/2x',
  '-0.25': '⏪ 1/4x',
  '-0.125': '⏪ 1/8x',
  '0.125': '⏩ 1/8x',
  '0.25': '⏩ 1/4x',
  '0.5': '⏩ 1/2x',
  '1': '▶ 1x',
  '2': '⏩ 2x',
  '4': '⏩ 4x',
  '8': '⏩ 8x',
  '16': '⏩ 16x'
};

export function PlaybackToolbar({
  isPlaying,
  isReverse,
  speed,
  audioEnabled,
  currentTime,
  hasActivePlayback,
  onTogglePlay,
  onToggleReverse,
  onStepFrame,
  onChangeSpeed,
  onToggleAudio,
  onDownloadClick,
  onShowShortcuts,
  enableSmart,
  onToggleSmart,
  zoomActive,
  onToggleZoom,
  volume,
  onChangeVolume,
  onSnapshot,
  onRefresh,
  onSeek,
  selectedDate
}) {
  const { t } = useLanguage();
  const [inputTime, setInputTime] = React.useState('00:00:00');
  const [isDirty, setIsDirty] = React.useState(false);

  React.useEffect(() => {
    if (!isDirty && currentTime) {
      const timeStr = currentTime.toLocaleTimeString('en-GB', { hour12: false });
      setInputTime(timeStr);
    }
  }, [currentTime, isDirty]);

  function handleSeekClick() {
    if (!onSeek) return;
    const baseDate = selectedDate || new Date();
    const seekDate = new Date(baseDate);
    const parts = inputTime.split(':');
    const hh = parseInt(parts[0], 10) || 0;
    const mm = parseInt(parts[1], 10) || 0;
    const ss = parseInt(parts[2], 10) || 0;
    seekDate.setHours(hh, mm, ss, 0);
    onSeek(seekDate);
    setIsDirty(false); // Reset dirty flag after successful seek
  }

  function formatTime(date) {
    if (!date) return '--:--:--';
    return date.toLocaleTimeString('en-GB', { hour12: false });
  }

  const speedOptions = [
    -16, -8, -4, -2, -1, -0.5, -0.25, -0.125,
    0.125, 0.25, 0.5, 1, 2, 4, 8, 16
  ];

  let audioIcon = '🔇';
  if (audioEnabled && volume > 0) {
    if (volume <= 50) audioIcon = '🔈';
    else audioIcon = '🔊';
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      backgroundColor: '#1e1e2f',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '8px 16px',
      color: '#fff',
      flexWrap: 'wrap'
    }}>
      {/* Left controls: Play, Reverse, Step, Smart, Zoom, Audio */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Play/Pause */}
        <button
          onClick={onTogglePlay}
          disabled={!hasActivePlayback}
          className="btn"
          style={{
            background: isPlaying ? 'var(--bg-hover)' : 'var(--accent)',
            color: isPlaying ? '#fff' : '#000',
            border: 'none',
            borderRadius: 4,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 'bold',
            cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            opacity: hasActivePlayback ? 1 : 0.5,
          }}
          title={isPlaying ? t('toolbar.pause') : t('toolbar.play')}
        >
          {isPlaying ? t('toolbar.pauseBtn') : t('toolbar.playBtn')}
        </button>

        {/* Refresh */}
        <button
          onClick={onRefresh}
          disabled={!hasActivePlayback}
          className="btn btn-secondary"
          style={{
            background: 'var(--bg-hover)',
            border: '1px solid var(--border)',
            color: '#fff',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            opacity: hasActivePlayback ? 1 : 0.5,
          }}
          title={t('toolbar.refreshTooltip')}
        >
          {t('toolbar.refreshBtn')}
        </button>

        {/* Reverse Play */}
        <button
          onClick={onToggleReverse}
          disabled={!hasActivePlayback}
          className="btn btn-secondary"
          style={{
            background: isReverse ? 'var(--accent)' : 'var(--bg-hover)',
            color: isReverse ? '#000' : '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 'bold',
            cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            opacity: hasActivePlayback ? 1 : 0.5,
          }}
          title={t('toolbar.reverseTooltip')}
        >
          {isReverse ? t('toolbar.reverseOnBtn') : t('toolbar.reverseOffBtn')}
        </button>

        {/* Frame Step */}
        <button
          onClick={onStepFrame}
          disabled={!hasActivePlayback}
          className="btn btn-secondary"
          style={{
            background: 'var(--bg-hover)',
            border: '1px solid var(--border)',
            color: '#fff',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            opacity: hasActivePlayback ? 1 : 0.5,
          }}
          title={t('toolbar.stepTooltip')}
        >
          {t('toolbar.stepBtn')}
        </button>

        {/* Smart overlay */}
        <button
          onClick={onToggleSmart}
          disabled={!hasActivePlayback}
          className="btn btn-secondary"
          style={{
            background: enableSmart ? 'var(--accent)' : 'var(--bg-hover)',
            color: enableSmart ? '#000' : '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            opacity: hasActivePlayback ? 1 : 0.5,
          }}
          title={t('toolbar.smartTooltip')}
        >
          {enableSmart ? t('toolbar.smartOn') : t('toolbar.smartOff')}
        </button>

        {/* Electronic Zoom */}
        <button
          onClick={onToggleZoom}
          disabled={!hasActivePlayback}
          className="btn btn-secondary"
          style={{
            background: zoomActive ? 'var(--accent)' : 'var(--bg-hover)',
            color: zoomActive ? '#000' : '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            opacity: hasActivePlayback ? 1 : 0.5,
          }}
          title={t('toolbar.zoomTooltip')}
        >
          {zoomActive ? t('toolbar.zoomOn') : t('toolbar.zoomOff')}
        </button>

        {/* Audio toggle */}
        <button
          onClick={onToggleAudio}
          disabled={!hasActivePlayback}
          className="btn btn-secondary"
          style={{
            background: audioEnabled ? 'var(--accent)' : 'var(--bg-hover)',
            color: audioEnabled ? '#000' : '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            opacity: hasActivePlayback ? 1 : 0.5,
          }}
          title={t('toolbar.audioTooltip')}
        >
          {audioIcon} {audioEnabled ? t('toolbar.audioOn') : t('toolbar.audioOff')}
        </button>

        {/* Volume Slider */}
        {audioEnabled && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => onChangeVolume(parseInt(e.target.value, 10))}
              disabled={!hasActivePlayback}
              style={{
                width: 80,
                cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
                accentColor: 'var(--accent)',
                height: 4,
                borderRadius: 2,
                background: '#1a1a2e',
              }}
              title={`${t('toolbar.volume')} ${volume}%`}
            />
            <span style={{ fontSize: 10, minWidth: 20, textAlign: 'right', color: 'var(--text-secondary)' }}>{volume}</span>
          </div>
        )}
      </div>

      {/* Center controls: Speed dropdown, Time display */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Speed Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('toolbar.speed')}</span>
          <select
            value={speed}
            disabled={!hasActivePlayback}
            onChange={(e) => onChangeSpeed(parseFloat(e.target.value))}
            style={{
              background: '#1a1a2e',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: '#fff',
              padding: '4px 8px',
              fontSize: 12,
              cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            }}
          >
            {speedOptions.map((opt) => (
              <option key={opt} value={opt}>
                {SPEED_LABELS[String(opt)] || `${opt}x`}
              </option>
            ))}
          </select>
        </div>

        {/* Time display */}
        <div style={{
          fontSize: 13,
          fontFamily: 'monospace',
          backgroundColor: '#12121a',
          padding: '4px 12px',
          borderRadius: 4,
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 6
        }}>
          <span style={{ color: 'var(--accent)' }}>🕒</span>
          <span>{formatTime(currentTime)}</span>
        </div>

        {/* Go-to time input & button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="time"
            step="1"
            value={inputTime}
            onChange={(e) => {
              setInputTime(e.target.value);
              setIsDirty(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSeekClick();
              }
            }}
            style={{
              background: '#1a1a2e',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: '#fff',
              padding: '4px 8px',
              fontSize: 12,
              cursor: 'text',
              outline: 'none'
            }}
          />
          <button
            onClick={handleSeekClick}
            disabled={!onSeek}
            className="btn btn-secondary"
            style={{
              background: 'var(--bg-hover)',
              border: '1px solid var(--border)',
              color: '#fff',
              borderRadius: 4,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t('toolbar.goTo')}
          </button>
        </div>
      </div>

      {/* Right controls: Shortcuts info, Snapshot, Download */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onShowShortcuts}
          className="btn btn-secondary"
          style={{
            background: 'var(--bg-hover)',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer'
          }}
          title={t('toolbar.shortcutsTooltip')}
        >
          {t('toolbar.shortcutsBtn')}
        </button>

        <button
          onClick={onSnapshot}
          disabled={!hasActivePlayback}
          className="btn btn-secondary"
          style={{
            background: 'var(--bg-hover)',
            border: '1px solid var(--border)',
            color: '#fff',
            borderRadius: 4,
            padding: '6px 12px',
            fontSize: 12,
            cursor: hasActivePlayback ? 'pointer' : 'not-allowed',
            opacity: hasActivePlayback ? 1 : 0.5
          }}
          title={t('toolbar.snapshotTooltip')}
        >
          {t('toolbar.snapshotBtn')}
        </button>

        <button
          onClick={onDownloadClick}
          disabled={!currentTime}
          className="btn"
          style={{
            background: 'var(--accent)',
            color: '#000',
            border: 'none',
            borderRadius: 4,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 'bold',
            cursor: currentTime ? 'pointer' : 'not-allowed',
            opacity: currentTime ? 1 : 0.5
          }}
          title={t('toolbar.downloadTooltip')}
        >
          {t('toolbar.downloadBtn')}
        </button>
      </div>
    </div>
  );
}

export default PlaybackToolbar;
