/**
 * PlaybackManager - Handles NVR recorded video playback
 * 
 * Note: Stream and seek functions now operate purely through the native HCNet SDK API,
 * eliminating the previous RTSP / go2rtc dependency.
 */

import { useStore } from '../store/useStore';

class PlaybackManager {
  constructor() {
    this.activePlayback = null; // Current playback session
    this.nvrCredentials = new Map(); // nvrIp -> {username, password}
  }

  /**
   * Set NVR credentials (load from config)
   */
  setCredentials(nvrIp, username, password) {
    this.nvrCredentials.set(nvrIp, { username, password });
  }

  /**
   * Search available recordings for a camera in a time range.
   * Always routes through Electron IPC (main process) to avoid CORS issues.
   *
   * @param {string} nvrIp - NVR IP address
   * @param {number} channel - Channel number (1-based)
   * @param {Date} startTime - Search start
   * @param {Date} endTime - Search end
   * @returns {Array} Array of recording segments [{startTime, endTime, size}]
   */
  async searchRecordings(nvrIp, channel, startTime, endTime) {
    // Always use IPC to avoid CORS issues
    return await this.searchRecordingsDigest(nvrIp, channel, startTime, endTime);
  }

  /**
   * Search which days in a month have recordings (for calendar indicators)
   * @param {string} nvrIp
   * @param {number} channel
   * @param {number} year
   * @param {number} month - 1-based (1=Jan, 12=Dec)
   * @returns {Set<number>} Set of day numbers that have recordings
   */
  async searchMonthRecordings(nvrIp, channel, year, month) {
    const startTime = new Date(year, month - 1, 1, 0, 0, 0);
    const lastDay = new Date(year, month, 0).getDate();
    const endTime = new Date(year, month - 1, lastDay, 23, 59, 59);

    try {
      const recordings = await this.searchRecordings(nvrIp, channel, startTime, endTime);
      const days = new Set();
      recordings.forEach(rec => {
        if (rec.startTime) {
          const d = rec.startTime instanceof Date ? rec.startTime : new Date(rec.startTime);
          days.add(d.getDate());
        }
      });
      return days;
    } catch (err) {
      console.error('Failed to search month recordings:', err);
      return new Set();
    }
  }

  /**
   * Search via Electron main process (supports Digest auth)
   */
  async searchRecordingsDigest(nvrIp, channel, startTime, endTime) {
    if (window.electronAPI?.searchNvrRecordings) {
      const raw = await window.electronAPI.searchNvrRecordings(nvrIp, channel, startTime, endTime);
      return (raw || []).map((item) => ({
        startTime: new Date(item.startTime),
        endTime: new Date(item.endTime),
        sourceUrl: item.sourceUrl || null
      }));
    }
    return [];
  }

  /**
   * Parse ISAPI search XML response into recording segments
   */
  parseSearchResults(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const matches = doc.querySelectorAll('searchMatchItem');
    const results = [];

    matches.forEach((item) => {
      const startTime = item.querySelector('startTime')?.textContent;
      const endTime = item.querySelector('endTime')?.textContent;
      const sourceUrl = item.querySelector('mediaSegmentDescriptor > playbackURI')?.textContent;

      if (startTime && endTime) {
        results.push({
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          sourceUrl: sourceUrl || null,
        });
      }
    });

    return results;
  }

  /**
   * Download a clip from NVR
   */
  async downloadClip(nvrIp, channel, startTime, endTime) {
    const cred = this.nvrCredentials.get(nvrIp);
    if (!cred) throw new Error(`No credentials for NVR ${nvrIp}`);

    const startStr = this.formatRtspTime(startTime);
    const endStr = this.formatRtspTime(endTime);

    // Hikvision ISAPI direct download URL
    const rtspUrl = `rtsp://${nvrIp}/Streaming/tracks/${channel}01?starttime=${startStr}&endtime=${endStr}`;
    const downloadUrl = `http://${nvrIp}/ISAPI/ContentMgmt/download?playbackURI=${encodeURIComponent(rtspUrl)}`;

    // Trigger download via Electron
    if (window.electronAPI?.downloadFile) {
      const parts = nvrIp.split(':');
      const ip = parts[0];
      const port = parts[1] ? parseInt(parts[1], 10) : 80;
      return await window.electronAPI.downloadFile({
        nvrIp: ip,
        httpPort: port,
        channel,
        startTimeStr: startStr,
        endTimeStr: endStr,
        username: cred.username,
        password: cred.password
      });
    }

    // Fallback: open in browser
    window.open(downloadUrl);
  }

  /**
   * Format Date to ISAPI time format: 2026-07-10T08:00:00Z
   */
  formatISAPITime(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  formatRtspTime(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
}

export const playbackManager = new PlaybackManager();
export default PlaybackManager;
