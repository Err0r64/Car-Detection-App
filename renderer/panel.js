'use strict';

// Analysis Panel module — read-only list of appearance cards, kept in sync
// with the timeline via the shared selection state in app.js. All confidence
// coloring goes through Timeline.bucketFor so both views always agree.
const Panel = (() => {
  let panelEl = null;
  let listEl = null;
  let onSelect = null;

  function init(els, callbacks) {
    panelEl = els.panel;
    listEl = els.list;
    onSelect = callbacks.onSelect;
  }

  // Renders cards in start_s order, titled Appearance0, Appearance1, ...
  // dataset.index maps each card back to its position in the original
  // appearances array (same mapping the timeline bars use).
  function render(appearances) {
    listEl.textContent = '';
    const ordered = appearances
      .map((a, index) => ({ a, index }))
      .sort((x, y) => x.a.start_s - y.a.start_s);

    ordered.forEach(({ a, index }, displayOrder) => {
      const card = document.createElement('div');
      card.className = 'appearance-card';
      card.dataset.index = String(index);
      card.tabIndex = -1;

      const header = document.createElement('div');
      header.className = 'card-header';

      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = `Appearance${displayOrder}`;
      header.appendChild(title);

      const confidence = document.createElement('span');
      confidence.className = `card-confidence ${Timeline.bucketFor(a.confidence).cls}`;
      confidence.textContent = a.confidence === null || a.confidence === undefined
        ? 'Not scored'
        : `${Math.round(a.confidence * 100)}%`;
      header.appendChild(confidence);

      const times = document.createElement('div');
      times.className = 'card-times';
      times.textContent = `${Timeline.formatMMSS(a.start_s)} – ${Timeline.formatMMSS(a.end_s)} · Car #${a.car_number}`;

      const description = document.createElement('div');
      description.className = 'card-description';
      description.textContent = a.notes || '';

      card.appendChild(header);
      card.appendChild(times);
      card.appendChild(description);

      if (a.subject === false) {
        const badge = document.createElement('div');
        badge.className = 'card-badge';
        badge.textContent = 'non-subject';
        card.appendChild(badge);
      }

      card.addEventListener('click', () => onSelect(index));
      listEl.appendChild(card);
    });

    panelEl.hidden = ordered.length === 0;
  }

  function setSelected(index) {
    listEl.querySelectorAll('.appearance-card').forEach((card) => {
      const isSelected = index !== null && card.dataset.index === String(index);
      card.classList.toggle('selected', isSelected);
      if (isSelected) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function focusFirstField(index) {
    const card = listEl.querySelector(`.appearance-card[data-index="${index}"]`);
    if (!card) return;
    const field = card.querySelector('input, textarea, button, [contenteditable="true"]');
    (field || card).focus({ preventScroll: true });
  }

  function clear() {
    listEl.textContent = '';
    panelEl.hidden = true;
  }

  return { init, render, setSelected, focusFirstField, clear };
})();
