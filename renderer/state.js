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

  let detections = [];
  let durationS = 0;
  let dirty = false;
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
    durationS = Number.isFinite(videoDurationS) && videoDurationS > 0
      ? Math.floor(videoDurationS)
      : 0;
    detections = cloneDetections(Array.isArray(items) ? items : []);
    dirty = options.dirty === true;
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

  function toInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : null;
  }

  function validateInterval(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return 'Times must be whole seconds.';
    }
    if (start < 0 || end > durationS) {
      return `Times must be between 0 and ${durationS} seconds.`;
    }
    if (start >= end) return 'Start must be at least one second before end.';
    return null;
  }

  function normalizeCreatedAppearance(appearance) {
    const rawStart = toInteger(appearance.start_s);
    const rawEnd = toInteger(appearance.end_s);
    if (rawStart === null || rawEnd === null) {
      return { error: 'Times must be numeric.' };
    }
    const start = Math.max(0, Math.min(rawStart, Math.max(0, durationS - 1)));
    const end = Math.max(start + 1, Math.min(rawEnd, durationS));
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

    if (action.type === 'create') {
      const normalized = normalizeCreatedAppearance(action.appearance || action);
      if (normalized.error) return fail(normalized.error);
      next.push(normalized.value);
      changed = true;
    } else {
      if (!validIndex(action.index)) return fail('Appearance not found.');

      const current = next[action.index];
      if (action.type === 'move-bound') {
        if (action.bound !== 'start_s' && action.bound !== 'end_s') {
          return fail('Unknown interval bound.');
        }
        const rounded = toInteger(action.value);
        if (rounded === null) return fail('Time must be numeric.');

        if (action.bound === 'start_s') {
          current.start_s = Math.max(0, Math.min(rounded, current.end_s - 1));
        } else {
          current.end_s = Math.min(durationS, Math.max(rounded, current.start_s + 1));
        }
        changed = current[action.bound] !== detections[action.index][action.bound];
      } else if (action.type === 'move-interval') {
        const requestedDelta = toInteger(action.delta_s);
        if (requestedDelta === null) return fail('Move amount must be numeric.');
        const minDelta = -current.start_s;
        const maxDelta = durationS - current.end_s;
        const delta = Math.max(minDelta, Math.min(requestedDelta, maxDelta));
        current.start_s += delta;
        current.end_s += delta;
        changed = delta !== 0;
      } else if (action.type === 'delete') {
        next.splice(action.index, 1);
        changed = true;
      } else if (action.type === 'edit-field') {
        if (!EDITABLE_FIELDS.has(action.field)) return fail('Field is not editable.');
        if (action.field === 'start_s' || action.field === 'end_s') {
          const value = Number(action.value);
          if (!Number.isInteger(value)) return fail('Times must be whole seconds.');
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

    const changedItem = action.type === 'delete' ? null : next[action.index];
    if (changedItem) {
      const error = validateInterval(changedItem.start_s, changedItem.end_s);
      if (error) return fail(error);
    }

    if (!changed) return { ok: true, changed: false, ...snapshot(action) };

    detections = next;
    dirty = true;
    emit(action);
    return { ok: true, changed: true, ...snapshot(action) };
  }

  function getDetections() {
    return cloneDetections();
  }

  function isDirty() {
    return dirty;
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
    markClean,
  };
})();
