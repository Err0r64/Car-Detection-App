'use strict';

// Timeline module — owns the single time<->pixel mapping and ALL timeline DOM.
// Every ruler tick, interval position, playhead position, and seek calculation
// must go through timeToX/xToTime so the whole timeline shares one scale.
const Timeline = (() => {
  // Tick spacing is chosen from this set so MM:SS labels never collide.
  const TICK_INTERVALS_S = [1, 5, 10, 30, 60];
  const MIN_TICK_SPACING_PX = 60;

  let rulerEl = null;
  let trackEl = null;
  let videoEl = null;
  let playheadEl = null;
  let durationS = 0;
  let pxPerSec = 0;
  let rafId = null;

  function init(els) {
    rulerEl = els.ruler;
    trackEl = els.track;
    videoEl = els.video;

    playheadEl = document.createElement('div');
    playheadEl.id = 'playhead';
    playheadEl.hidden = true;
    trackEl.appendChild(playheadEl);

    videoEl.addEventListener('timeupdate', () => updatePlayhead());
    videoEl.addEventListener('seeked', () => updatePlayhead());
    videoEl.addEventListener('play', startPlayheadLoop);
    videoEl.addEventListener('pause', stopPlayheadLoop);
    videoEl.addEventListener('ended', stopPlayheadLoop);

    trackEl.addEventListener('pointerdown', onTrackPointerDown);
  }

  // --- Time mapping (fit-to-width) ---

  function setScale(duration, trackWidthPx) {
    durationS = duration;
    pxPerSec = duration > 0 ? trackWidthPx / duration : 0;
  }

  function timeToX(seconds) {
    return seconds * pxPerSec;
  }

  function xToTime(px) {
    return pxPerSec > 0 ? px / pxPerSec : 0;
  }

  function formatMMSS(seconds) {
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // --- Ruler ---

  function chooseTickIntervalS() {
    for (const interval of TICK_INTERVALS_S) {
      if (interval * pxPerSec >= MIN_TICK_SPACING_PX) return interval;
    }
    return TICK_INTERVALS_S[TICK_INTERVALS_S.length - 1];
  }

  function renderRuler() {
    rulerEl.textContent = '';
    if (durationS <= 0) return;
    const interval = chooseTickIntervalS();
    for (let t = 0; t <= Math.floor(durationS); t += interval) {
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = `${timeToX(t)}px`;
      const label = document.createElement('span');
      label.className = 'ruler-label';
      label.textContent = formatMMSS(t);
      tick.appendChild(label);
      rulerEl.appendChild(tick);
    }
  }

  // --- Playhead ---

  function updatePlayhead() {
    if (durationS <= 0) return;
    playheadEl.style.left = `${timeToX(videoEl.currentTime)}px`;
  }

  // requestAnimationFrame loop while playing, for smoother motion than the
  // sparse timeupdate events.
  function startPlayheadLoop() {
    stopPlayheadLoop();
    const step = () => {
      updatePlayhead();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function stopPlayheadLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    updatePlayhead();
  }

  // --- Seeking (click / click-drag on the track) ---

  function seekToClientX(clientX) {
    const rect = trackEl.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    // Seek to the exact clicked time; only displayed values are rounded.
    videoEl.currentTime = xToTime(x);
  }

  function onTrackPointerDown(e) {
    if (durationS <= 0 || e.button !== 0) return;
    try {
      trackEl.setPointerCapture(e.pointerId);
    } catch {
      // no active pointer (e.g. synthetic events) — drag still works within the track
    }
    seekToClientX(e.clientX);

    const onMove = (ev) => seekToClientX(ev.clientX);
    const onUp = () => {
      trackEl.removeEventListener('pointermove', onMove);
      trackEl.removeEventListener('pointerup', onUp);
      trackEl.removeEventListener('pointercancel', onUp);
    };
    trackEl.addEventListener('pointermove', onMove);
    trackEl.addEventListener('pointerup', onUp);
    trackEl.addEventListener('pointercancel', onUp);
  }

  // --- Public render entry points ---

  // Fit the timeline to a video of `duration` seconds at the track's current
  // width and (re)render everything scale-dependent.
  function setVideo(duration) {
    setScale(duration, trackEl.clientWidth);
    renderRuler();
    playheadEl.hidden = false;
    updatePlayhead();
  }

  function handleResize() {
    if (durationS > 0) setVideo(durationS);
  }

  function clear() {
    stopPlayheadLoop();
    durationS = 0;
    pxPerSec = 0;
    rulerEl.textContent = '';
    playheadEl.hidden = true;
    playheadEl.style.left = '0px';
  }

  return { init, setScale, timeToX, xToTime, formatMMSS, setVideo, handleResize, clear };
})();
