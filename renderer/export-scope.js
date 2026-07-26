'use strict';

const ExportScope = (() => {
  const VALID_SCOPES = new Set(['all', 'subject', 'selected']);

  function selectIntervals(detections, scope, selectedIndex) {
    if (!Array.isArray(detections)) return [];
    if (!VALID_SCOPES.has(scope)) throw new Error(`Unknown export scope: ${scope}`);

    let selected;
    if (scope === 'all') {
      selected = detections;
    } else if (scope === 'subject') {
      selected = detections.filter((detection) => detection.subject === true);
    } else {
      selected = Number.isInteger(selectedIndex) ? [detections[selectedIndex]] : [];
    }

    return selected.filter(Boolean).map((detection) => ({ ...detection }));
  }

  return { selectIntervals };
})();

if (typeof module !== 'undefined') module.exports = ExportScope;
