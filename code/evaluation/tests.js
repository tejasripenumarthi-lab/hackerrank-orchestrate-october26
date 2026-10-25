'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseCsv, isDeletionRequest } = require('../main.js');

const ROOT = path.resolve(__dirname, '../..');

test('CSV parsing preserves commas and escaped quotes', () => {
  const rows = parseCsv('id,text\r\n1,"remove this, please"\r\n2,"She said ""erase it"""\r\n');
  assert.deepEqual(rows, [
    { id: '1', text: 'remove this, please' },
    { id: '2', text: 'She said "erase it"' },
  ]);
});

test('access and correction requests do not authorize deletion', () => {
  assert.equal(isDeletionRequest('Please send me a copy of all personal data.'), false);
  assert.equal(isDeletionRequest('Please correct the phone number on my profile.'), false);
});

test('deletion intent is recognized across languages', () => {
  assert.equal(isDeletionRequest('Please permanently delete my account.'), true);
  assert.equal(isDeletionRequest('Solicito eliminar permanentemente mi cuenta.'), true);
  assert.equal(isDeletionRequest('このアカウントを削除してください。'), true);
});

test('an explicit denial of deletion takes precedence over keywords', () => {
  assert.equal(isDeletionRequest("I don't want you to delete my account; just stop marketing emails."), false);
});

test('generated submission has 518 sorted, parseable rows and valid step ordering', () => {
  const output = parseCsv(fs.readFileSync(path.join(ROOT, 'output.csv'), 'utf8'));
  const requests = parseCsv(fs.readFileSync(path.join(ROOT, 'dataset', 'deletion_requests.csv'), 'utf8'));
  assert.equal(output.length, 518);
  assert.equal(output.length, requests.length);
  assert.deepEqual(output.map((row) => row.case_id), [...output.map((row) => row.case_id)].sort());

  const allowedStatuses = new Set(['COMPLETE', 'INCOMPLETE', 'NOT_APPLICABLE']);
  const phaseOrder = { FINDING: 0, REMEDIATION: 1, VERIFICATION: 2 };
  for (const row of output) {
    assert.ok(allowedStatuses.has(row.deletion_status));
    const steps = JSON.parse(row.steps_json);
    if (row.deletion_status === 'NOT_APPLICABLE') assert.deepEqual(steps, []);
    steps.forEach((step, index) => {
      assert.equal(step.step_no, index + 1);
      assert.ok(Object.hasOwn(phaseOrder, step.phase));
      if (index > 0) assert.ok(phaseOrder[steps[index - 1].phase] <= phaseOrder[step.phase]);
      assert.equal(Object.keys(step).length, 7);
    });
  }
});

test('public sample reference covers every public request', () => {
  const requests = parseCsv(fs.readFileSync(path.join(ROOT, 'dataset', 'sample_deletion_requests.csv'), 'utf8'));
  const reference = parseCsv(fs.readFileSync(path.join(ROOT, 'dataset', 'sample_output.csv'), 'utf8'));
  const referenceIds = new Set(reference.map((row) => row.case_id));
  for (const request of requests) assert.ok(referenceIds.has(request.case_id), `missing ${request.case_id}`);
});
