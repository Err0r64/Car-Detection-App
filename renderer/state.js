'use strict';

// Canonical detection state. UI modules receive snapshots and request changes
// through updateDetections; they never mutate this array directly.
const DetectionState = (() => {
  const EDITABLE_FIELDS = new Set([
    'start_s',
    'end_s',
    'car_number',
    'subject',
    'notes',
  ]);
  const MAX_DELETION_HISTORY = 50;
  const TIMESTAMP_SCALE = 1000;
  const MIN_INTERVAL_S = 1 / TIMESTAMP_SCALE;

  let detections = [];
  let durationS = 0;
  let dirty = false;
  let deletedIntervals = [];
  const listeners = new Set();

  function cloneDetections(items = detections) {
    return items.map((item) => ({ ...item }));
  }

  function snapshot(action = null) {
    return {
      detections: cloneDetections(),
      durationS,
      dirty,
      action,
    };
  }

  function emit(action) {
    const next = snapshot(action);
    listeners.forEach((listener) => listener(next));
  }

  function initialize(items, videoDurationS, options = {}) {
    const normalizedDuration = toTimestamp(videoDurationS);
    durationS = normalizedDuration !== null && normalizedDuration > 0
      ? normalizedDuration
      : 0;
    detections = (Array.isArray(items) ? items : [])
      .map(normalizeIncomingAppearance)
      .filter((item) => item !== null);
    dirty = options.dirty === true;
    deletedIntervals = [];
    emit({ type: 'initialize' });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function fail(error) {
    return { ok: false, error, ...snapshot() };
  }

  function validIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < detections.length;
  }

  function toTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.round(number * TIMESTAMP_SCALE) / TIMESTAMP_SCALE
      : null;
  }

  function clampTimestamp(value) {
    return Math.max(0, Math.min(value, durationS));
  }

  function normalizeIncomingAppearance(appearance) {
    const rawStart = toTimestamp(appearance?.start_s);
    const rawEnd = toTimestamp(appearance?.end_s);
    if (rawStart === null || rawEnd === null || rawStart >= rawEnd) return null;

    const start = clampTimestamp(rawStart);
    const end = clampTimestamp(rawEnd);
    if (start >= end) return null;
    return { ...appearance, start_s: start, end_s: end };
  }

  function validateInterval(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return 'Times must be numeric.';
    }
    if (start < 0 || start > durationS || end < 0 || end > durationS) {
      return `Times must be between 0 and ${durationS} seconds.`;
    }
    if (start >= end) return 'Start must be before end.';
    return null;
  }

  function normalizeCreatedAppearance(appearance) {
    const rawStart = toTimestamp(appearance.start_s);
    const rawEnd = toTimestamp(appearance.end_s);
    if (rawStart === null || rawEnd === null) {
      return { error: 'Times must be numeric.' };
    }
    const start = clampTimestamp(rawStart);
    const end = clampTimestamp(rawEnd);
    const error = validateInterval(start, end);
    if (error) return { error };
    return {
      value: {
        car_number: String(appearance.car_number ?? ''),
        start_s: start,
        end_s: end,
        subject: appearance.subject !== false,
        confidence: appearance.confidence ?? null,
        notes: String(appearance.notes ?? ''),
      },
    };
  }

  function updateDetections(action) {
    if (!action || typeof action.type !== 'string') {
      return fail('A mutation action is required.');
    }

    const next = cloneDetections();
    let changed = false;
    let deletedEntry = null;
    let restoredIndex = null;

    if (action.type === 'create') {
      const normalized = normalizeCreatedAppearance(action.appearance || action);
      if (normalized.error) return fail(normalized.error);
      next.push(normalized.value);
      changed = true;
    } else if (action.type === 'restore') {
      if (deletedIntervals.length === 0) return fail('No deleted interval to restore.');
      const entry = deletedIntervals[deletedIntervals.length - 1];
      restoredIndex = Math.min(entry.index, next.length);
      next.splice(restoredIndex, 0, { ...entry.appearance });
      changed = true;
    } else {
      if (!validIndex(action.index)) return fail('Appearance not found.');

      const current = next[action.index];
      if (action.type === 'move-bound') {
        if (action.bound !== 'start_s' && action.bound !== 'end_s') {
          return fail('Unknown interval bound.');
        }
        const value = toTimestamp(action.value);
        if (value === null) return fail('Time must be numeric.');

        if (action.bound === 'start_s') {
          const latestStart = toTimestamp(current.end_s - MIN_INTERVAL_S);
          current.start_s = Math.max(0, Math.min(value, latestStart));
        } else {
          const earliestEnd = toTimestamp(current.start_s + MIN_INTERVAL_S);
          current.end_s = Math.min(durationS, Math.max(value, earliestEnd));
        }
        changed = current[action.bound] !== detections[action.index][action.bound];
      } else if (action.type === 'move-interval') {
        const requestedDelta = toTimestamp(action.delta_s);
        if (requestedDelta === null) return fail('Move amount must be numeric.');
        const minDelta = -current.start_s;
        const maxDelta = durationS - current.end_s;
        const delta = Math.max(minDelta, Math.min(requestedDelta, maxDelta));
        current.start_s = toTimestamp(current.start_s + delta);
        current.end_s = toTimestamp(current.end_s + delta);
        changed = delta !== 0;
      } else if (action.type === 'delete') {
        deletedEntry = {
          appearance: { ...current },
          index: action.index,
        };
        next.splice(action.index, 1);
        changed = true;
      } else if (action.type === 'edit-field') {
        if (!EDITABLE_FIELDS.has(action.field)) return fail('Field is not editable.');
        if (action.field === 'start_s' || action.field === 'end_s') {
          const value = toTimestamp(action.value);
          if (value === null) return fail('Times must be numeric.');
          const candidateStart = action.field === 'start_s' ? value : current.start_s;
          const candidateEnd = action.field === 'end_s' ? value : current.end_s;
          const error = validateInterval(candidateStart, candidateEnd);
          if (error) return fail(error);
          current[action.field] = value;
        } else if (action.field === 'subject') {
          if (typeof action.value !== 'boolean') return fail('Subject must be true or false.');
          current.subject = action.value;
        } else {
          current[action.field] = String(action.value ?? '');
        }
        changed = current[action.field] !== detections[action.index][action.field];
      } else {
        return fail(`Unknown mutation type: ${action.type}`);
      }
    }

    let changedIndex = action.index;
    if (action.type === 'create') changedIndex = next.length - 1;
    if (action.type === 'restore') changedIndex = restoredIndex;
    const changedItem = action.type === 'delete' ? null : next[changedIndex];
    if (changedItem) {
      const error = validateInterval(changedItem.start_s, changedItem.end_s);
      if (error) return fail(error);
    }

    if (!changed) return { ok: true, changed: false, ...snapshot(action) };

    detections = next;
    dirty = true;

    if (action.type === 'delete') {
      deletedIntervals.push(deletedEntry);
      if (deletedIntervals.length > MAX_DELETION_HISTORY) deletedIntervals.shift();
    } else if (action.type === 'restore') {
      deletedIntervals.pop();
    } else {
      deletedIntervals = [];
    }

    const committedAction = action.type === 'restore'
      ? { ...action, index: restoredIndex }
      : action;
    emit(committedAction);
    return {
      ok: true,
      changed: true,
      restoredIndex,
      ...snapshot(committedAction),
    };
  }

  function getDetections() {
    return cloneDetections();
  }

  function isDirty() {
    return dirty;
  }

  function canUndoDelete() {
    return deletedIntervals.length > 0;
  }

  function markClean() {
    if (!dirty) return;
    dirty = false;
    emit({ type: 'mark-clean' });
  }

  return {
    initialize,
    subscribe,
    updateDetections,
    getDetections,
    isDirty,
    canUndoDelete,
    markClean,
  };
})();
