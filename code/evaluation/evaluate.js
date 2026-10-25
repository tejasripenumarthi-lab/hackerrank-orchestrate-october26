'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCsv } = require('../main.js');

const ROOT = path.resolve(__dirname, '../..');
const FIELD_NAMES = ['step_no', 'phase', 'system_id', 'resource_id', 'operation', 'state', 'evidence_id'];

function normalizedSteps(value) {
  return JSON.parse(value).map((step) => Object.fromEntries(FIELD_NAMES.map((field) => [field, step[field]])));
}

function compare(referencePath, predictionPath) {
  const reference = parseCsv(fs.readFileSync(referencePath, 'utf8'));
  const predictions = parseCsv(fs.readFileSync(predictionPath, 'utf8'));
  const predictionById = new Map(predictions.map((row) => [row.case_id, row]));
  let statusCorrect = 0;
  let sequencesCorrect = 0;
  let expectedStepCount = 0;
  let fieldCorrect = 0;
  let comparedFieldCount = 0;
  let exactSteps = 0;
  const mismatches = [];

  for (const expected of reference) {
    const actual = predictionById.get(expected.case_id);
    if (!actual) {
      mismatches.push(`${expected.case_id}: missing prediction`);
      continue;
    }
    if (expected.deletion_status === actual.deletion_status) statusCorrect += 1;
    const expectedSteps = normalizedSteps(expected.steps_json);
    const actualSteps = normalizedSteps(actual.steps_json);
    expectedStepCount += expectedSteps.length;
    let exactSequence = expectedSteps.length === actualSteps.length;

    for (let index = 0; index < Math.max(expectedSteps.length, actualSteps.length); index += 1) {
      const expectedStep = expectedSteps[index];
      const actualStep = actualSteps[index];
      if (!expectedStep || !actualStep) {
        comparedFieldCount += FIELD_NAMES.length;
        if (actualStep) exactSteps += 0;
        continue;
      }
      let exactStep = true;
      for (const field of FIELD_NAMES) {
        comparedFieldCount += 1;
        if (expectedStep[field] === actualStep[field]) fieldCorrect += 1;
        else exactStep = false;
      }
      if (exactStep) exactSteps += 1;
      else exactSequence = false;
    }
    if (exactSequence) sequencesCorrect += 1;
    else if (mismatches.length < 20) {
      mismatches.push(`${expected.case_id}: status ${expected.deletion_status}/${actual.deletion_status}; steps ${expectedSteps.length}/${actualSteps.length}`);
    }
  }

  return {
    cases: reference.length,
    predictions: predictions.length,
    statusCorrect,
    statusAccuracy: reference.length ? statusCorrect / reference.length : 0,
    exactSequences: sequencesCorrect,
    sequenceAccuracy: reference.length ? sequencesCorrect / reference.length : 0,
    expectedSteps: expectedStepCount,
    exactPositionSteps: exactSteps,
    stepAccuracy: expectedStepCount ? exactSteps / expectedStepCount : 0,
    fieldsCorrect: fieldCorrect,
    fieldsCompared: comparedFieldCount,
    fieldAccuracy: comparedFieldCount ? fieldCorrect / comparedFieldCount : 0,
    mismatches,
  };
}

if (require.main === module) {
  const referencePath = process.argv[2] || path.join(ROOT, 'dataset', 'sample_output.csv');
  const predictionPath = process.argv[3] || path.join(ROOT, 'output.csv');
  console.log(JSON.stringify(compare(referencePath, predictionPath), null, 2));
}

module.exports = { compare, normalizedSteps };
