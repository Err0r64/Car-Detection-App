'use strict';

// Timeline module — owns the single time<->pixel mapping and ALL timeline DOM.
// Every ruler tick, interval position, playhead position, and seek calculation
// must go through timeToX/xToTime so the whole timeline shares one scale.
const Timeline = (() => {
  // Tick spacing is chosen from this set so MM:SS labels never collide.
  const TICK_INTERVALS_S = [1, 5, 10, 30, 60];
  const MIN_TICK_SPACING_PX = 60;

  // Confidence color buckets — the single source of truth, used by both the
  // timeline bars and the Analysis Panel. Checked top-down.
  const CONFIDENCE_BUCKETS = [
    { min: 0.85, cls: 'bucket-high' },
    { min: 0.6, cls: 'bucket-mid' },
    { min: 0, cls: 'bucket-low' },
  ];

  function bucketFor(confidence) {
    if (confidence === null || confidence === undefined) return { cls: 'bucket-user' };
    return CONFIDENCE_BUCKETS.find((b) => confidence >= b.min) || CONFIDENCE_BUCKETS[CONFIDENCE_BUCKETS.length - 1];
  }

  const MAX_LANES = 3;
  const LANE_TOP_PX = 4;
  const LANE_HEIGHT_PX = 19;
  const BAR_HEIGHT_PX = 17;
  const CREATE_DRAG_THRESHOLD_PX = 4;

  let rulerEl = null;
  let trackEl = null;
  let videoEl = null;
  let playheadEl = null;
  let dragReadoutEl = null;
  let createPreviewEl = null;
  let contextMenuEl = null;
  let durationS = 0;
  let pxPerSec = 0;
  let rafId = null;
  let appearances = [];
  let selectedIndex = null;
  let dragState = null;
  let createState = null;
  let onIntervalClick = null;
  let onEmptyTrackClick = null;
  let onDragPreview = null;
  let onDragCommit = null;
  let onCreateCommit = null;
  let onDeleteRequest = null;

  function init(els, callbacks = {}) {
    rulerEl = els.ruler;
    trackEl = els.track;
    videoEl = els.video;
    onIntervalClick = callbacks.onIntervalClick || null;
    onEmptyTrackClick = callbacks.onEmptyTrackClick || null;
    onDragPreview = callbacks.onDragPreview || null;
    onDragCommit = callbacks.onDragCommit || null;
    onCreateCommit = callbacks.onCreateCommit || null;
    onDeleteRequest = callbacks.onDeleteRequest || null;

    playheadEl = document.createElement('div');
    playheadEl.id = 'playhead';
    playheadEl.hidden = true;
    trackEl.appendChild(playheadEl);

    dragReadoutEl = document.createElement('div');
    dragReadoutEl.className = 'drag-readout';
    dragReadoutEl.hidden = true;
    trackEl.appendChild(dragReadoutEl);

    createPreviewEl = document.createElement('div');
    createPreviewEl.className = 'interval-create-preview';
    createPreviewEl.hidden = true;
    trackEl.appendChild(createPreviewEl);

    contextMenuEl = document.createElement('div');
    contextMenuEl.className = 'timeline-context-menu';
    contextMenuEl.hidden = true;
    const deleteItem = document.createElement('button');
    deleteItem.type = 'button';
    deleteItem.textContent = 'Delete Interval';
    deleteItem.addEventListener('click', () => {
      const index = Number(contextMenuEl.dataset.index);
      hideContextMenu();
      if (Number.isInteger(index) && onDeleteRequest) onDeleteRequest(index);
    });
    contextMenuEl.appendChild(deleteItem);
    document.body.appendChild(contextMenuEl);

    videoEl.addEventListener('timeupdate', () => updatePlayhead());
    videoEl.addEventListener('seeked', () => updatePlayhead());
    videoEl.addEventListener('play', startPlayheadLoop);
    videoEl.addEventListener('pause', stopPlayheadLoop);
    videoEl.addEventListener('ended', stopPlayheadLoop);

    trackEl.addEventListener('pointerdown', onTrackPointerDown);
    trackEl.addEventListener('contextmenu', onTrackContextMenu);
    document.addEventListener('pointerdown', (event) => {
      if (!contextMenuEl.contains(event.target)) hideContextMenu();
    });
    window.addEventListener('blur', hideContextMenu);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideContextMenu();
    });
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

  // --- Intervals ---

  // Greedy lane assignment in start order: each appearance takes the first
  // lane whose previous interval has ended. Returns lane index, or -1 for
  // overflow past MAX_LANES.
  function assignLanes(items) {
    const laneEnds = [];
    return items.map(({ appearance: a }) => {
      for (let lane = 0; lane < MAX_LANES; lane++) {
        if (!(laneEnds[lane] > a.start_s)) {
          laneEnds[lane] = a.end_s;
          return lane;
        }
      }
      return -1;
    });
  }

  function renderIntervals(items = appearances) {
    trackEl.querySelectorAll('.interval, .interval-overflow').forEach((el) => el.remove());
    if (durationS <= 0 || items.length === 0) return;

    const ordered = items
      .map((appearance, index) => ({ appearance, index }))
      .sort((a, b) => a.appearance.start_s - b.appearance.start_s);
    const lanes = assignLanes(ordered);

    ordered.forEach(({ appearance: a, index: originalIndex }, i) => {
      const left = timeToX(a.start_s);
      const width = Math.max(timeToX(a.end_s) - left, 2);
      const lane = lanes[i];
      const confidenceLabel = a.confidence === null || a.confidence === undefined
        ? 'Not scored'
        : `${Math.round(a.confidence * 100)}%`;
      const label = `Car ${a.car_number || 'Unassigned'} - ${formatMMSS(a.start_s)}-${formatMMSS(a.end_s)} - ${confidenceLabel}`;

      if (lane === -1) {
        // Overflow indicator: more intervals here than visible lanes.
        const marker = document.createElement('div');
        marker.className = 'interval-overflow';
        marker.style.left = `${left}px`;
        marker.style.width = `${width}px`;
        marker.title = `More overlapping intervals than lanes — ${label}`;
        trackEl.appendChild(marker);
        return;
      }

      const bar = document.createElement('div');
      bar.className = `interval ${bucketFor(a.confidence).cls}`;
      if (a.subject === false) {
        bar.classList.add('non-subject');
        bar.title = `Non-subject appearance — ${label}`;
      } else {
        bar.title = label;
      }
      bar.dataset.index = String(originalIndex);
      if (originalIndex === selectedIndex) bar.classList.add('selected');
      bar.style.left = `${left}px`;
      bar.style.width = `${width}px`;
      bar.style.top = `${LANE_TOP_PX + lane * LANE_HEIGHT_PX}px`;
      bar.style.height = `${BAR_HEIGHT_PX}px`;

      const startEdge = document.createElement('div');
      startEdge.className = 'interval-edge interval-edge-start';
      startEdge.dataset.bound = 'start_s';
      startEdge.title = 'Drag start';
      bar.appendChild(startEdge);

      const endEdge = document.createElement('div');
      endEdge.className = 'interval-edge interval-edge-end';
      endEdge.dataset.bound = 'end_s';
      endEdge.title = 'Drag end';
      bar.appendChild(endEdge);

      trackEl.appendChild(bar);
    });
  }

  // Sets the appearances rendered on the track (integer-second data straight
  // from the fixture/pipeline; this module never mutates it).
  function setDetections(list) {
    appearances = Array.isArray(list) ? list.map((appearance) => ({ ...appearance })) : [];
    renderIntervals();
  }

  // Highlights the bar for `index` (null clears). Selection state itself is
  // owned by app.js.
  function setSelected(index) {
    selectedIndex = index;
    trackEl.querySelectorAll('.interval').forEach((bar) => {
      bar.classList.toggle('selected', index !== null && bar.dataset.index === String(index));
    });
  }

  // --- Interval context menu ---

  function hideContextMenu() {
    if (contextMenuEl) contextMenuEl.hidden = true;
  }

  function onTrackContextMenu(event) {
    const bar = event.target.closest('.interval');
    if (!bar) return;

    event.preventDefault();
    const index = Number(bar.dataset.index);
    if (!Number.isInteger(index)) return;
    if (onIntervalClick) onIntervalClick(index);

    contextMenuEl.dataset.index = String(index);
    contextMenuEl.hidden = false;
    const left = Math.min(event.clientX, window.innerWidth - contextMenuEl.offsetWidth - 4);
    const top = Math.min(event.clientY, window.innerHeight - contextMenuEl.offsetHeight - 4);
    contextMenuEl.style.left = `${Math.max(4, left)}px`;
    contextMenuEl.style.top = `${Math.max(4, top)}px`;
  }

  // --- Interval dragging ---

  function pointerTime(clientX) {
    const rect = trackEl.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    return xToTime(x);
  }

  function previewForDrag(clientX) {
    if (!dragState) return;
    const preview = appearances.map((appearance) => ({ ...appearance }));
    const item = preview[dragState.index];
    const maxTime = Math.floor(durationS);

    if (dragState.kind === 'bound') {
      const value = Math.round(pointerTime(clientX));
      if (dragState.bound === 'start_s') {
        item.start_s = Math.max(0, Math.min(value, item.end_s - 1));
      } else {
        item.end_s = Math.min(maxTime, Math.max(value, item.start_s + 1));
      }
      dragState.action = {
        type: 'move-bound',
        index: dragState.index,
        bound: dragState.bound,
        value: item[dragState.bound],
      };
      dragReadoutEl.textContent = `${dragState.bound === 'start_s' ? 'Start' : 'End'} ${formatMMSS(item[dragState.bound])}`;
    } else {
      const requestedDelta = Math.round(pointerTime(clientX) - dragState.anchorTime);
      const minDelta = -dragState.original.start_s;
      const maxDelta = maxTime - dragState.original.end_s;
      const delta = Math.max(minDelta, Math.min(requestedDelta, maxDelta));
      item.start_s = dragState.original.start_s + delta;
      item.end_s = dragState.original.end_s + delta;
      dragState.action = {
        type: 'move-interval',
        index: dragState.index,
        delta_s: delta,
      };
      dragReadoutEl.textContent = `${formatMMSS(item.start_s)} - ${formatMMSS(item.end_s)}`;
    }

    const rect = trackEl.getBoundingClientRect();
    dragReadoutEl.style.left = `${Math.min(Math.max(clientX - rect.left, 44), rect.width - 44)}px`;
    dragReadoutEl.hidden = false;
    renderIntervals(preview);
    if (onDragPreview) onDragPreview(preview, dragState.index);
  }

  function cleanupDrag() {
    window.removeEventListener('pointermove', onIntervalPointerMove);
    window.removeEventListener('pointerup', onIntervalPointerUp);
    window.removeEventListener('pointercancel', onIntervalPointerCancel);
    document.body.classList.remove('timeline-dragging');
    dragReadoutEl.hidden = true;
  }

  function onIntervalPointerMove(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    previewForDrag(event.clientX);
  }

  function onIntervalPointerUp(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    previewForDrag(event.clientX);
    const action = dragState.action;
    const index = dragState.index;
    cleanupDrag();
    dragState = null;
    renderIntervals();
    if (action && onDragCommit) onDragCommit(action, index);
  }

  function onIntervalPointerCancel(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const index = dragState.index;
    cleanupDrag();
    dragState = null;
    renderIntervals();
    if (onDragPreview) onDragPreview(appearances, index);
  }

  function beginIntervalDrag(event, bar, edge) {
    const index = Number(bar.dataset.index);
    if (!Number.isInteger(index) || !appearances[index]) return;
    if (onIntervalClick) onIntervalClick(index);
    event.preventDefault();

    try {
      trackEl.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events may not have an active pointer to capture.
    }

    dragState = {
      pointerId: event.pointerId,
      index,
      kind: edge ? 'bound' : 'interval',
      bound: edge ? edge.dataset.bound : null,
      anchorTime: pointerTime(event.clientX),
      original: { ...appearances[index] },
      action: null,
    };
    document.body.classList.add('timeline-dragging');
    window.addEventListener('pointermove', onIntervalPointerMove);
    window.addEventListener('pointerup', onIntervalPointerUp);
    window.addEventListener('pointercancel', onIntervalPointerCancel);
    previewForDrag(event.clientX);
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

  // --- Empty-track click and create-by-drag ---

  function seekToClientX(clientX) {
    const rect = trackEl.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    // Seek to the exact clicked time; only displayed values are rounded.
    videoEl.currentTime = xToTime(x);
  }

  function createBoundsForClientX(clientX) {
    const maxTime = Math.floor(durationS);
    const currentTime = pointerTime(clientX);
    let start = Math.max(0, Math.min(maxTime, Math.round(Math.min(createState.startTime, currentTime))));
    let end = Math.max(0, Math.min(maxTime, Math.round(Math.max(createState.startTime, currentTime))));

    if (start === end) {
      if (currentTime >= createState.startTime) {
        start = Math.min(start, maxTime - 1);
        end = start + 1;
      } else {
        end = Math.max(end, 1);
        start = end - 1;
      }
    }

    return { start_s: start, end_s: end };
  }

  function updateCreatePreview(clientX) {
    if (!createState) return;
    if (!createState.dragging
        && Math.abs(clientX - createState.startClientX) < CREATE_DRAG_THRESHOLD_PX) {
      return;
    }

    createState.dragging = true;
    createState.bounds = createBoundsForClientX(clientX);
    const left = timeToX(createState.bounds.start_s);
    const right = timeToX(createState.bounds.end_s);
    createPreviewEl.style.left = `${left}px`;
    createPreviewEl.style.width = `${Math.max(2, right - left)}px`;
    createPreviewEl.hidden = false;

    const rect = trackEl.getBoundingClientRect();
    dragReadoutEl.style.left = `${Math.min(Math.max(clientX - rect.left, 44), rect.width - 44)}px`;
    dragReadoutEl.textContent = `${formatMMSS(createState.bounds.start_s)} - ${formatMMSS(createState.bounds.end_s)}`;
    dragReadoutEl.hidden = false;
  }

  function cleanupCreate() {
    window.removeEventListener('pointermove', onCreatePointerMove);
    window.removeEventListener('pointerup', onCreatePointerUp);
    window.removeEventListener('pointercancel', onCreatePointerCancel);
    createPreviewEl.hidden = true;
    dragReadoutEl.hidden = true;
  }

  function onCreatePointerMove(event) {
    if (!createState || event.pointerId !== createState.pointerId) return;
    updateCreatePreview(event.clientX);
  }

  function onCreatePointerUp(event) {
    if (!createState || event.pointerId !== createState.pointerId) return;
    updateCreatePreview(event.clientX);
    const wasDragging = createState.dragging;
    const bounds = createState.bounds;
    cleanupCreate();
    createState = null;

    if (wasDragging && bounds) {
      if (onCreateCommit) onCreateCommit(bounds);
    } else {
      seekToClientX(event.clientX);
    }
  }

  function onCreatePointerCancel(event) {
    if (!createState || event.pointerId !== createState.pointerId) return;
    cleanupCreate();
    createState = null;
  }

  function beginCreate(event) {
    if (onEmptyTrackClick) onEmptyTrackClick();
    event.preventDefault();
    try {
      trackEl.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events may not have an active pointer to capture.
    }

    createState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startTime: pointerTime(event.clientX),
      dragging: false,
      bounds: null,
    };
    window.addEventListener('pointermove', onCreatePointerMove);
    window.addEventListener('pointerup', onCreatePointerUp);
    window.addEventListener('pointercancel', onCreatePointerCancel);
  }

  function onTrackPointerDown(e) {
    if (durationS <= 0 || e.button !== 0) return;

    // Clicks on an interval bar select it instead of seeking; clicks on the
    // empty track seek and clear the selection.
    const bar = e.target.closest('.interval');
    if (bar) {
      beginIntervalDrag(e, bar, e.target.closest('.interval-edge'));
      return;
    }
    beginCreate(e);
  }

  // --- Public render entry points ---

  // Fit the timeline to a video of `duration` seconds at the track's current
  // width and (re)render everything scale-dependent.
  function setVideo(duration) {
    setScale(duration, trackEl.clientWidth);
    renderRuler();
    renderIntervals();
    playheadEl.hidden = false;
    updatePlayhead();
  }

  function handleResize() {
    if (durationS > 0) setVideo(durationS);
  }

  function clear() {
    stopPlayheadLoop();
    if (dragState) cleanupDrag();
    if (createState) cleanupCreate();
    dragState = null;
    createState = null;
    hideContextMenu();
    durationS = 0;
    pxPerSec = 0;
    appearances = [];
    selectedIndex = null;
    rulerEl.textContent = '';
    trackEl.querySelectorAll('.interval, .interval-overflow').forEach((el) => el.remove());
    playheadEl.hidden = true;
    playheadEl.style.left = '0px';
    dragReadoutEl.hidden = true;
    createPreviewEl.hidden = true;
  }

  return {
    init,
    setScale,
    timeToX,
    xToTime,
    formatMMSS,
    bucketFor,
    setDetections,
    setSelected,
    setVideo,
    handleResize,
    clear,
  };
})();
