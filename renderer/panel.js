'use strict';

// Editable Analysis Panel. Successful changes commit through DetectionState.
const Panel = (() => {
  const ERROR_VISIBLE_MS = 2400;
  let panelEl = null;
  let listEl = null;
  let onSelect = null;
  let onEdit = null;
  let descriptionDialog = null;
  let descriptionTextarea = null;
  let descriptionError = null;
  let activeDescriptionIndex = null;
  const errorTimers = new WeakMap();

  function ensureDescriptionDialog() {
    if (descriptionDialog) return;

    descriptionDialog = document.createElement('dialog');
    descriptionDialog.className = 'description-dialog';
    descriptionDialog.setAttribute('aria-labelledby', 'description-dialog-title');

    const content = document.createElement('div');
    content.className = 'description-dialog-content';
    const title = document.createElement('h2');
    title.id = 'description-dialog-title';
    title.textContent = 'Vehicle Description';

    descriptionTextarea = document.createElement('textarea');
    descriptionTextarea.className = 'description-dialog-textarea';
    descriptionTextarea.setAttribute('aria-label', 'Vehicle Description');
    descriptionTextarea.spellcheck = true;

    descriptionError = document.createElement('div');
    descriptionError.className = 'description-dialog-error';
    descriptionError.setAttribute('role', 'status');
    descriptionError.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'description-dialog-actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'dialog-button dialog-button-secondary';
    cancelButton.textContent = 'Cancel';
    const applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'dialog-button dialog-button-primary';
    applyButton.textContent = 'Apply';
    actions.appendChild(cancelButton);
    actions.appendChild(applyButton);

    content.appendChild(title);
    content.appendChild(descriptionTextarea);
    content.appendChild(descriptionError);
    content.appendChild(actions);
    descriptionDialog.appendChild(content);
    document.body.appendChild(descriptionDialog);

    const applyDescription = () => {
      if (activeDescriptionIndex === null) return;
      const result = onEdit(activeDescriptionIndex, 'notes', descriptionTextarea.value);
      if (!result.ok) {
        descriptionError.textContent = result.error;
        descriptionError.hidden = false;
        return;
      }
      descriptionDialog.close();
    };

    cancelButton.addEventListener('click', () => descriptionDialog.close());
    applyButton.addEventListener('click', applyDescription);
    descriptionTextarea.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        applyDescription();
      }
    });
    descriptionDialog.addEventListener('close', () => {
      if (descriptionDialog.open) return;
      activeDescriptionIndex = null;
      descriptionTextarea.value = '';
      descriptionError.textContent = '';
      descriptionError.hidden = true;
    });
  }

  function openDescriptionDialog(index, value) {
    ensureDescriptionDialog();
    activeDescriptionIndex = index;
    descriptionTextarea.value = value;
    descriptionError.textContent = '';
    descriptionError.hidden = true;
    onSelect(index);
    descriptionDialog.showModal();
    descriptionTextarea.focus();
    descriptionTextarea.setSelectionRange(
      descriptionTextarea.value.length,
      descriptionTextarea.value.length
    );
  }

  function init(els, callbacks) {
    panelEl = els.panel;
    listEl = els.list;
    onSelect = callbacks.onSelect;
    onEdit = callbacks.onEdit;
    ensureDescriptionDialog();
  }

  function parseMMSS(rawValue) {
    const match = String(rawValue).trim().match(/^(\d+):([0-5]\d)$/);
    if (!match) return { error: 'Use MM:SS with seconds from 00 to 59.' };
    return { value: Number(match[1]) * 60 + Number(match[2]) };
  }

  function clearError(card, control) {
    const timer = errorTimers.get(card);
    if (timer) clearTimeout(timer);
    errorTimers.delete(card);
    control.removeAttribute('aria-invalid');
    const errorEl = card.querySelector('.card-error');
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function showError(card, control, message, restore) {
    const timer = errorTimers.get(card);
    if (timer) clearTimeout(timer);
    restore();
    control.setAttribute('aria-invalid', 'true');
    const errorEl = card.querySelector('.card-error');
    errorEl.textContent = message;
    errorEl.hidden = false;
    errorTimers.set(card, setTimeout(() => {
      control.removeAttribute('aria-invalid');
      errorEl.textContent = '';
      errorEl.hidden = true;
      errorTimers.delete(card);
    }, ERROR_VISIBLE_MS));
  }

  function makeTextField(card, index, options) {
    const wrapper = document.createElement('label');
    wrapper.className = 'card-field' + (options.compact ? ' card-field-compact' : '');
    const label = document.createElement('span');
    label.className = 'card-field-label';
    label.textContent = options.label;
    const input = document.createElement('input');
    input.className = 'card-field-control';
    input.type = 'text';
    input.value = options.displayValue;
    input.autocomplete = 'off';
    input.spellcheck = options.spellcheck === true;
    input.setAttribute('aria-label', options.label);

    let suppressNextBlur = false;
    const commit = () => {
      clearError(card, input);
      const parsed = options.parse ? options.parse(input.value) : { value: input.value };
      if (parsed.error) {
        showError(card, input, parsed.error, () => {
          input.value = options.displayValue;
        });
        return false;
      }

      const result = onEdit(index, options.field, parsed.value);
      if (!result.ok) {
        showError(card, input, result.error, () => {
          input.value = options.displayValue;
        });
        return false;
      }

      const current = result.detections[index];
      if (current) {
        input.value = options.format
          ? options.format(current[options.field])
          : String(current[options.field] ?? '');
      }
      return true;
    };

    input.addEventListener('focus', () => onSelect(index));
    input.addEventListener('blur', () => {
      if (suppressNextBlur) {
        suppressNextBlur = false;
        return;
      }
      commit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const accepted = commit();
      if (accepted && input.isConnected) {
        suppressNextBlur = true;
        input.blur();
      }
    });

    wrapper.appendChild(label);
    if (options.expandable) {
      const inputRow = document.createElement('div');
      inputRow.className = 'card-field-input-row';
      const expandButton = document.createElement('button');
      expandButton.type = 'button';
      expandButton.className = 'card-field-expand';
      expandButton.textContent = '↗';
      expandButton.title = 'Expand vehicle description';
      expandButton.setAttribute('aria-label', 'Expand vehicle description');
      expandButton.addEventListener('mousedown', (event) => event.preventDefault());
      expandButton.addEventListener('click', () => {
        const displayedOriginal = String(options.displayValue).replace(/[\r\n]/g, '');
        const value = input.value === displayedOriginal ? options.displayValue : input.value;
        openDescriptionDialog(index, value);
      });
      inputRow.appendChild(input);
      inputRow.appendChild(expandButton);
      wrapper.appendChild(inputRow);
    } else {
      wrapper.appendChild(input);
    }
    return wrapper;
  }

  function render(appearances) {
    listEl.textContent = '';
    const ordered = appearances
      .map((appearance, index) => ({ appearance, index }))
      .sort((left, right) => left.appearance.start_s - right.appearance.start_s);

    ordered.forEach(({ appearance, index }, displayOrder) => {
      const card = document.createElement('div');
      card.className = 'appearance-card';
      card.dataset.index = String(index);
      card.tabIndex = -1;
      const header = document.createElement('div');
      header.className = 'card-header';
      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = 'Appearance' + displayOrder;
      const confidence = document.createElement('span');
      confidence.className = 'card-confidence ' + Timeline.bucketFor(appearance.confidence).cls;
      confidence.textContent = appearance.confidence === null || appearance.confidence === undefined
        ? 'Not scored'
        : Math.round(appearance.confidence * 100) + '%';
      confidence.title = 'Confidence is read-only';
      header.appendChild(title);
      header.appendChild(confidence);

      const timeFields = document.createElement('div');
      timeFields.className = 'card-time-fields';
      timeFields.appendChild(makeTextField(card, index, {
        label: 'Start',
        field: 'start_s',
        displayValue: Timeline.formatMMSS(appearance.start_s),
        parse: parseMMSS,
        format: Timeline.formatMMSS,
        compact: true,
      }));
      timeFields.appendChild(makeTextField(card, index, {
        label: 'End',
        field: 'end_s',
        displayValue: Timeline.formatMMSS(appearance.end_s),
        parse: parseMMSS,
        format: Timeline.formatMMSS,
        compact: true,
      }));

      const carField = makeTextField(card, index, {
        label: 'Car #',
        field: 'car_number',
        displayValue: String(appearance.car_number ?? ''),
      });
      const descriptionField = makeTextField(card, index, {
        label: 'Vehicle Description',
        field: 'notes',
        displayValue: String(appearance.notes ?? ''),
        spellcheck: true,
        expandable: true,
      });

      const subjectLabel = document.createElement('label');
      subjectLabel.className = 'card-subject-toggle';
      const subjectInput = document.createElement('input');
      subjectInput.type = 'checkbox';
      subjectInput.className = 'card-subject-input';
      subjectInput.checked = appearance.subject === true;
      subjectInput.setAttribute('aria-label', 'Subject appearance');
      const subjectText = document.createElement('span');
      subjectText.textContent = 'Subject appearance';
      subjectLabel.appendChild(subjectInput);
      subjectLabel.appendChild(subjectText);
      subjectInput.addEventListener('focus', () => onSelect(index));
      subjectInput.addEventListener('change', () => {
        clearError(card, subjectInput);
        const result = onEdit(index, 'subject', subjectInput.checked);
        if (!result.ok) {
          showError(card, subjectInput, result.error, () => {
            subjectInput.checked = appearance.subject === true;
          });
        }
      });

      const error = document.createElement('div');
      error.className = 'card-error';
      error.setAttribute('role', 'status');
      error.hidden = true;
      card.appendChild(header);
      card.appendChild(timeFields);
      card.appendChild(carField);
      card.appendChild(descriptionField);
      card.appendChild(subjectLabel);
      card.appendChild(error);
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
    const card = listEl.querySelector('.appearance-card[data-index="' + index + '"]');
    if (!card) return;
    const field = card.querySelector('.card-field-control');
    (field || card).focus({ preventScroll: true });
  }

  function clear() {
    if (descriptionDialog && descriptionDialog.open) descriptionDialog.close();
    listEl.textContent = '';
    panelEl.hidden = true;
  }

  return { init, render, setSelected, focusFirstField, clear };
})();