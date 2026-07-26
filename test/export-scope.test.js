const test = require('node:test');
const assert = require('node:assert/strict');

const { selectIntervals } = require('../renderer/export-scope');

const detections = [
  { car_number: '29|33', start_s: 1, end_s: 3, subject: true },
  { car_number: '14', start_s: 4.5, end_s: 6, subject: false },
  { car_number: '', start_s: 7.25, end_s: 9.75, subject: true },
];

test('all scope returns every interval as snapshots', () => {
  const selected = selectIntervals(detections, 'all', null);

  assert.deepEqual(selected, detections);
  assert.notEqual(selected[0], detections[0]);
});

test('subject scope reflects the current edited subject flags', () => {
  const edited = detections.map((detection) => ({ ...detection }));
  edited[1].subject = true;

  assert.deepEqual(
    selectIntervals(detections, 'subject', null).map((interval) => interval.car_number),
    ['29|33', '']
  );
  assert.deepEqual(
    selectIntervals(edited, 'subject', null).map((interval) => interval.car_number),
    ['29|33', '14', '']
  );
});

test('selected scope returns exactly the current selection', () => {
  assert.deepEqual(
    selectIntervals(detections, 'selected', 1),
    [{ car_number: '14', start_s: 4.5, end_s: 6, subject: false }]
  );
  assert.deepEqual(selectIntervals(detections, 'selected', null), []);
  assert.deepEqual(selectIntervals(detections, 'selected', 99), []);
});

test('unknown scope is rejected', () => {
  assert.throws(() => selectIntervals(detections, 'unknown', null), /Unknown export scope/);
});
