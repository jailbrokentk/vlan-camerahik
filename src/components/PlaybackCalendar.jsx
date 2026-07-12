import React, { useState, useEffect } from 'react';
import { playbackManager } from '../lib/playback-manager';
import { useLanguage } from '../i18n/useLanguage';

export function PlaybackCalendar({ selectedDate, onChangeDate, camera }) {
  const { t } = useLanguage();
  const [currentMonth, setCurrentMonth] = useState(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  const [recordingDays, setRecordingDays] = useState(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (camera) {
      loadMonthRecordings();
    }
  }, [currentMonth, camera]);

  async function loadMonthRecordings() {
    setLoading(true);
    try {
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth() + 1; // 1-based
      const days = await playbackManager.searchMonthRecordings(camera.nvrIp, camera.channel, year, month);
      setRecordingDays(days);
    } catch (e) {
      console.error('Failed to load recording days for calendar:', e);
      setRecordingDays(new Set());
    }
    setLoading(false);
  }

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const prevMonth = () => {
    setCurrentMonth(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentMonth(new Date(year, month + 1, 1));
  };

  // Generate days array
  const firstDayIndex = new Date(year, month, 1).getDay(); // 0 = Sun, 6 = Sat
  const totalDays = new Date(year, month + 1, 0).getDate();

  const days = [];
  // Empty slots for padding
  const padOffset = firstDayIndex === 0 ? 6 : firstDayIndex - 1; // Mon-indexed
  for (let i = 0; i < padOffset; i++) {
    days.push(null);
  }

  for (let d = 1; d <= totalDays; d++) {
    days.push(new Date(year, month, d));
  }

  const isSelected = (date) => {
    if (!date) return false;
    return date.getDate() === selectedDate.getDate() &&
           date.getMonth() === selectedDate.getMonth() &&
           date.getFullYear() === selectedDate.getFullYear();
  };

  const isToday = (date) => {
    if (!date) return false;
    const today = new Date();
    return date.getDate() === today.getDate() &&
           date.getMonth() === today.getMonth() &&
           date.getFullYear() === today.getFullYear();
  };

  const hasRecordings = (date) => {
    if (!date) return false;
    return recordingDays.has(date.getDate());
  };

  const monthNames = t('calendar.months');

  return (
    <div style={{
      width: 250,
      backgroundColor: '#1e1e2f',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      userSelect: 'none'
    }}>
      {/* Month nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifySpace: 'between', justifyContent: 'space-between' }}>
        <button className="btn btn-secondary btn-sm" onClick={prevMonth} style={{ padding: '2px 8px', background: 'transparent' }}>&lt;</button>
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 'bold' }}>
          {monthNames[month]} {year} {loading && '⏳'}
        </span>
        <button className="btn btn-secondary btn-sm" onClick={nextMonth} style={{ padding: '2px 8px', background: 'transparent' }}>&gt;</button>
      </div>

      {/* Weekday headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, textAlign: 'center' }}>
        {t('calendar.weekdays').map((w, idx) => (
          <span key={idx} style={{ color: 'var(--text-secondary)', fontSize: 10, fontWeight: 'bold' }}>{w}</span>
        ))}
      </div>

      {/* Days grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {days.map((date, idx) => {
          if (!date) return <div key={idx} />;
          
          const selected = isSelected(date);
          const activeToday = isToday(date);
          const hasRec = hasRecordings(date);

          return (
            <button
              key={idx}
              onClick={() => onChangeDate(date)}
              style={{
                position: 'relative',
                height: 28,
                background: selected ? 'var(--accent)' : 'transparent',
                border: activeToday ? '1px solid var(--accent)' : 'none',
                color: selected ? '#000' : '#fff',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: selected || activeToday ? 'bold' : 'normal',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.1s ease',
                opacity: date.getMonth() === month ? 1 : 0.4
              }}
              onMouseEnter={(e) => {
                if (!selected) e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                if (!selected) e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {date.getDate()}
              
              {/* Dot recording indicator */}
              {hasRec && (
                <span style={{
                  position: 'absolute',
                  bottom: 3,
                  width: 4,
                  height: 4,
                  borderRadius: '50%',
                  backgroundColor: selected ? '#000' : 'var(--accent)'
                }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default PlaybackCalendar;
