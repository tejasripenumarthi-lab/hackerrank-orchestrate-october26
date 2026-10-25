#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATASET = path.join(ROOT, 'dataset');
const OUTPUT_FIELDS = ['case_id', 'deletion_status', 'steps_json'];
const ID_PATTERN = /^(?:account|search|analytics|support|export|marketing|audit_record|backup|data_flow|tombstone|delivery|telemetry|profile|attachment|archive|customer)[_-][A-Za-z0-9-]+$/i;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  if (rows.length === 0) return [];

  const headers = rows.shift();
  return rows
    .filter((values) => values.some((value) => value !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function readCsv(filePath) {
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}

function parseTime(value, fallback) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function lower(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function addAlias(aliases, value, kind) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'none') return;
  if (kind === 'email') aliases.add(lower(raw));
  else if (kind === 'phone') {
    const normalized = digits(raw);
    if (normalized.length >= 7) aliases.add(`phone:${normalized}`);
  } else aliases.add(lower(raw));
}

function resolveIdentity(request, identities, auditRows) {
  const requestedEmail = lower(request.email);
  const identity = identities.find((row) => lower(row.email) === requestedEmail);
  const auditMatch = auditRows.find((row) =>
    lower(row.field_name) === 'email' &&
    [lower(row.old_value), lower(row.new_value)].includes(requestedEmail));
  const userId = identity?.user_id || auditMatch?.user_id || '';
  const aliases = new Set();
  addAlias(aliases, request.email, 'email');

  if (userId) {
    const current = identities.find((row) => row.user_id === userId);
    addAlias(aliases, userId, 'reference');
    if (current) {
      addAlias(aliases, current.email, 'email');
      addAlias(aliases, current.phone, 'phone');
      addAlias(aliases, current.email_hash, 'hash');
    }
    for (const event of auditRows) {
      if (event.user_id !== userId) continue;
      const field = lower(event.field_name);
      const kind = field.includes('email') ? 'email' : field.includes('phone') ? 'phone' : 'hash';
      addAlias(aliases, event.old_value, kind);
      addAlias(aliases, event.new_value, kind);
    }
  }
  return { userId, aliases };
}

function aliasMatches(values, aliases) {
  const needles = [...aliases];
  for (const value of values) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'none') continue;
    const normalized = lower(raw);
    if (needles.includes(normalized)) return true;
    const phone = `phone:${digits(raw)}`;
    if (digits(raw).length >= 7 && needles.includes(phone)) return true;
  }
  return false;
}

function textContainsAlias(text, aliases) {
  const candidate = lower(text);
  const candidateDigits = digits(candidate);
  for (const alias of aliases) {
    if (alias.startsWith('phone:')) {
      const number = alias.slice(6);
      if (candidateDigits.includes(number)) return true;
    } else {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const delimiters = alias.includes('@') ? 'A-Za-z0-9._%+-' : 'A-Za-z0-9_';
      if (new RegExp(`(^|[^${delimiters}])${escaped}(?![${delimiters}])`).test(candidate)) return true;
    }
  }
  return false;
}

function flattenValues(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenValues(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) flattenValues(item, output);
  } else if (value !== null && value !== undefined) {
    output.push(String(value));
  }
  return output;
}

function flattenPairs(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenPairs(item, output);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') flattenPairs(item, output);
      else output.push([key.toLowerCase(), item]);
    }
  }
  return output;
}

function findResourceId(record) {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && (key.toLowerCase() === 'resource_id' || key.toLowerCase() === 'resourceid') &&
        ID_PATTERN.test(value)) return value;
  }
  return '';
}

function inferSystem(context, record, resourceId) {
  const text = `${context.join(' ')} ${Object.keys(record).join(' ')} ${resourceId}`.toLowerCase();
  const known = [
    ['account_service', 'account_service'],
    ['search_service', 'search_service'],
    ['analytics_platform', 'analytics_platform'],
    ['support_platform', 'support_platform'],
    ['export_service', 'export_service'],
    ['marketing_platform', 'marketing_platform'],
    ['identity_service', 'identity_service'],
    ['security_service', 'security_service'],
    ['integration_service', 'integration_service'],
    ['backup_service', 'backup_service'],
  ];
  for (const [needle, system] of known) if (text.includes(needle)) return system;

  const prefix = resourceId.split(/[_-]/)[0].toLowerCase();
  const byPrefix = {
    account: 'account_service',
    search: 'search_service',
    analytics: 'analytics_platform',
    support: 'support_platform',
    export: 'export_service',
    marketing: 'marketing_platform',
    tombstone: 'identity_service',
    audit: 'security_service',
    backup: 'backup_service',
    data: 'integration_service',
    delivery: 'notification_service',
    telemetry: 'analytics_platform',
  };
  return byPrefix[prefix] || 'unknown_system';
}

function recordTime(record, fallback) {
  const pairs = flattenPairs(record);
  for (const [key, value] of pairs) {
    if (['observed_at', 'captured_at', 'updated_at', 'event_time', 'created_at', 'timestamp'].includes(key)) {
      const time = parseTime(value, NaN);
      if (Number.isFinite(time)) return time;
    }
  }
  return fallback;
}

function stateFromRecord(record, system, resourceId) {
  const pairs = flattenPairs(record);
  const values = new Map(pairs.map(([key, value]) => [key, lower(value)]));
  const flat = pairs.map(([key, value]) => `${key}=${lower(value)}`).join(' ');

  if (/(http_status=404|status_code=404|rows=0|total_hits=0|result=miss|result=not_found|state=absent)/.test(flat)) {
    return 'ABSENT';
  }
  if (/\b(deleted|absent|not_found|missing)\b/.test(values.get('state') || values.get('status') || '')) return 'ABSENT';

  if (resourceId.startsWith('data_flow_')) {
    const enabled = values.get('enabled');
    return enabled === 'true' || enabled === '1' ? 'ACTIVE' : 'DISABLED';
  }
  if (resourceId.startsWith('backup_')) {
    const allowed = values.get('restore_allowed');
    return allowed === 'true' || allowed === '1' ? 'ACTIVE' : 'BLOCKED';
  }

  if (/\b(redacted|anonymized|anonymised)\b/.test(flat)) {
    if (flat.includes('redacted')) return 'REDACTED';
    return 'ANONYMIZED';
  }
  if (values.get('http_status') === '200' || values.get('status_code') === '200' ||
      values.get('result') === 'hit' || Number(values.get('rows')) > 0 ||
      Number(values.get('total_hits')) > 0) return 'PRESENT';
  if (system === 'account_service' && Object.hasOwn(record, 'profile') && record.profile === null) return 'ABSENT';
  if (Object.hasOwn(record, 'profile') && record.profile === null && !Object.hasOwn(record, 'resource_id')) return 'ABSENT';
  return 'PRESENT';
}

function makeObservation(record, context, evidence, fallbackTime, sourceType) {
  const resourceId = findResourceId(record);
  if (!resourceId) return null;
  const systemId = inferSystem(context, record, resourceId);
  const pairs = flattenPairs(record);
  const categoryPair = pairs.find(([key]) => ['data_category', 'category', 'record_category', 'policy_category'].includes(key));
  const table = context.find((part) => part.startsWith('table:'))?.slice(6) || '';
  const recordText = JSON.stringify(record);
  return {
    resourceId,
    systemId,
    category: categoryPair ? String(categoryPair[1]) : '',
    context: `${context.join(' ')} ${table}`.toLowerCase(),
    pairs,
    recordText,
    time: recordTime(record, fallbackTime),
    evidenceId: evidence.file_id,
    state: stateFromRecord(record, systemId, resourceId),
    sourceType,
  };
}

function walkJson(value, context, evidence, fallbackTime, aliases, output) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, context, evidence, fallbackTime, aliases, output));
    return;
  }
  if (!value || typeof value !== 'object') return;

  const resourceId = findResourceId(value);
  if (resourceId && aliasMatches(flattenValues(value), aliases)) {
    const observation = makeObservation(value, context, evidence, fallbackTime, 'json');
    if (observation) output.push(observation);
  }
  for (const [key, item] of Object.entries(value)) {
    walkJson(item, [...context, key], evidence, fallbackTime, aliases, output);
  }
}

function splitSqlValues(value) {
  const result = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      current += ch;
      if (ch === quote && value[i + 1] === quote) {
        current += value[i + 1];
        i += 1;
      } else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result.map((item) => {
    if ((item.startsWith("'") && item.endsWith("'")) || (item.startsWith('"') && item.endsWith('"'))) {
      return item.slice(1, -1).replace(/''/g, "'").replace(/""/g, '"');
    }
    return item.toUpperCase() === 'NULL' ? null : item;
  });
}

function parseSql(text, evidence, fallbackTime, aliases, output) {
  const columnsByTable = new Map();
  const schemaPattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?\s*\(([\s\S]*?)\)\s*;/gi;
  let match;
  while ((match = schemaPattern.exec(text)) !== null) {
    const columns = match[2]
      .split(',')
      .map((definition) => definition.trim().match(/^["`]?([A-Za-z0-9_]+)["`]?\s+/)?.[1])
      .filter(Boolean);
    columnsByTable.set(match[1], columns);
  }

  const insertPattern = /INSERT\s+INTO\s+["`]?([A-Za-z0-9_]+)["`]?\s+VALUES\s*\(([\s\S]*?)\)\s*;/gi;
  while ((match = insertPattern.exec(text)) !== null) {
    const table = match[1];
    const columns = columnsByTable.get(table) || [];
    const values = splitSqlValues(match[2]);
    const storedRecord = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null]));
    const payloadColumn = Object.entries(storedRecord)
      .find(([column, value]) => /^(payload|record_json|record_data|document_json)$/i.test(column) &&
        typeof value === 'string' && value.trim().startsWith('{'));
    let payload = {};
    if (payloadColumn) {
      try {
        payload = JSON.parse(payloadColumn[1]);
      } catch (error) {
        throw new Error(`Invalid JSON payload in ${evidence.file_path}, table ${table}: ${error.message}`);
      }
    }
    const record = { ...storedRecord, ...payload };
    const resourceId = record.resource_id || record.resourceId;
    if (!resourceId || !ID_PATTERN.test(String(resourceId)) || !aliasMatches(flattenValues(record), aliases)) continue;
    const observation = makeObservation({ ...record, resource_id: String(resourceId) }, [`table:${table}`, table], evidence, fallbackTime, 'sql');
    if (observation) output.push(observation);
  }
}

function parseLog(text, evidence, fallbackTime, aliases, output) {
  const kvPattern = /([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  for (const line of text.split(/\r?\n/)) {
    if (!textContainsAlias(line, aliases)) continue;
    const record = {};
    let match;
    kvPattern.lastIndex = 0;
    while ((match = kvPattern.exec(line)) !== null) record[match[1]] = match[2] ?? match[3] ?? match[4];
    const resourceId = record.resource_id;
    if (!resourceId || !ID_PATTERN.test(resourceId)) continue;
    const service = record.service || '';
    const observation = makeObservation(
      { ...record, resource_id: resourceId },
      [service, evidence.origin || ''],
      evidence,
      fallbackTime,
      'log',
    );
    if (observation) output.push(observation);
  }
}

function loadEvidence(dataset, manifest) {
  return manifest.map((row) => {
    const absolutePath = path.resolve(dataset, row.file_path);
    const extension = path.extname(absolutePath).toLowerCase();
    return {
      ...row,
      absolutePath,
      extension,
      capturedTime: parseTime(row.captured_at, 0),
    };
  }).filter((row) => fs.existsSync(row.absolutePath));
}

function collectObservations(request, identity, evidenceFiles, activityRows) {
  const auditTime = parseTime(request.audit_at, 0);
  const observations = [];
  const linkedResources = new Set();

  for (const activity of activityRows) {
    if (parseTime(activity.event_time, 0) > auditTime) continue;
    if (!textContainsAlias(
      [activity.details, activity.resource_id, activity.source_system, activity.target_system].join(' '),
      identity.aliases,
    )) continue;
    if (activity.resource_id) linkedResources.add(activity.resource_id);
  }

  for (const evidence of evidenceFiles) {
    if (evidence.capturedTime > auditTime) continue;
    if (['.png', '.jpg', '.jpeg', '.pdf'].includes(evidence.extension)) continue;

    let text;
    try {
      text = fs.readFileSync(evidence.absolutePath, 'utf8');
    } catch (error) {
      throw new Error(`Unable to read participant evidence ${evidence.file_path}: ${error.message}`);
    }
    const before = observations.length;
    if (evidence.extension === '.json') {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`Invalid JSON in participant evidence ${evidence.file_path}: ${error.message}`);
      }
      walkJson(parsed, [], evidence, evidence.capturedTime, identity.aliases, observations);
    } else if (evidence.extension === '.sql') {
      parseSql(text, evidence, evidence.capturedTime, identity.aliases, observations);
    } else {
      parseLog(text, evidence, evidence.capturedTime, identity.aliases, observations);
    }
    for (const observation of observations.slice(before)) linkedResources.add(observation.resourceId);
  }

  const byResource = new Map();
  for (const observation of observations) {
    if (observation.time > auditTime) continue;
    const key = `${observation.systemId}\u0000${observation.resourceId}`;
    const previous = byResource.get(key);
    if (!previous || observation.time > previous.time ||
        (observation.time === previous.time && observation.sourceType === 'json' && previous.sourceType !== 'json')) {
      byResource.set(key, observation);
    }
  }
  return { observations: [...byResource.values()], linkedResources };
}

function containsDirectIdentifiers(observation) {
  const identifierKeys = /(^|_)(email|phone|name|email_hash|address|ip_address|device_id|customer_id|user_id)(_|$)/i;
  return observation.pairs.some(([key, value]) => {
    if (!identifierKeys.test(key) || value === null || value === undefined) return false;
    const stringValue = String(value).trim();
    return stringValue !== '' && lower(stringValue) !== 'null' && lower(stringValue) !== 'none';
  });
}

function categoryFor(observation) {
  if (observation.category) return String(observation.category).toUpperCase();
  const resourceId = observation.resourceId.toLowerCase();
  const context = observation.context;
  if (resourceId.startsWith('account_')) return 'USER_PROFILE';
  if (resourceId.startsWith('search_')) return 'SEARCH_INDEX_ENTRY';
  if (resourceId.startsWith('analytics_')) return 'ANALYTICS_PROFILE';
  if (resourceId.startsWith('support_')) {
    return /attachment/.test(context) ? 'SUPPORT_ATTACHMENT' : 'SUPPORT_MESSAGE';
  }
  if (resourceId.startsWith('export_')) return 'USER_EXPORT';
  if (resourceId.startsWith('marketing_')) return 'MARKETING_PROFILE';
  if (resourceId.startsWith('audit_record_')) return 'SECURITY_AUDIT_LOG';
  if (resourceId.startsWith('backup_')) return 'BACKUP_ARCHIVE';
  if (resourceId.startsWith('tombstone_')) return 'ACCOUNT_TOMBSTONE';
  if (resourceId.startsWith('delivery_')) return 'EMAIL_DELIVERY_LOG';
  if (resourceId.startsWith('telemetry_')) return 'PRODUCT_TELEMETRY';
  return '';
}

function evidencePolicy(observation, rules) {
  const category = categoryFor(observation);
  const rule = rules.find((item) => item.data_category.toUpperCase() === category);
  if (rule) return { category, action: rule.required_action.toUpperCase() };
  if (observation.resourceId.startsWith('data_flow_')) return { category: 'DATA_FLOW', action: 'DISABLE' };
  if (observation.resourceId.startsWith('backup_')) return { category: 'BACKUP_ARCHIVE', action: 'RETAIN' };
  return { category, action: '' };
}

function makeStep(phase, systemId, resourceId, operation, state, evidenceId) {
  return { step_no: 0, phase, system_id: systemId, resource_id: resourceId, operation, state, evidence_id: evidenceId };
}

const FINDING_ORDER = {
  REPORT_REMAINING_RECORD: 1,
  REPORT_EXPOSED_PII: 2,
  REPORT_ACTIVE_DATA_FLOW: 3,
  REPORT_RESTORE_RISK: 4,
};
const REMEDIATION_ORDER = {
  DISABLE_DATA_FLOW: 1,
  BLOCK_RESTORE: 2,
  DELETE_RECORD: 3,
  REDACT_RECORD: 4,
  ANONYMIZE_RECORD: 5,
};
const VERIFICATION_ORDER = {
  VERIFY_RECORD_ABSENT: 1,
  VERIFY_RECORD_PRESENT: 2,
  VERIFY_RECORD_REDACTED: 3,
  VERIFY_RECORD_ANONYMIZED: 4,
  VERIFY_DATA_FLOW_DISABLED: 5,
  VERIFY_RESTORE_BLOCKED: 6,
};

function sortSteps(steps, order) {
  return steps.sort((left, right) =>
    order[left.operation] - order[right.operation] ||
    left.system_id.localeCompare(right.system_id) ||
    left.resource_id.localeCompare(right.resource_id));
}

function isDeletionRequest(text) {
  const content = lower(text);
  const negative = /\b(?:do not|don't|dont|never|not asking for|not requesting|without|no need to)\b.{0,45}\b(?:delete|erase|remove|close|cancel|purge|wipe|suppression|supprimer|eliminar|borrar|löschen)\b/;
  if (negative.test(content)) return false;

  const positiveTerms = [
    /\b(delete|deleted|deleting|deletion|erase|erased|erasure|remove|removed|removal|purge|wipe|forget|account closure|close my account|close this account|close the account|closed my account|closed account|cancel my account)\b/,
    /\b(supprimer|suppression|effacer|effacement|eliminar|eliminación|borrar|borrado|dar de baja|löschen|löschung|entfernen|entfernung|eliminare|cancellare|rimuovere|删除|消除|削除|削除を依頼|アカウントを削除)\b/,
    /\b(cerrar|cierre|chiudere|cancellazione|verwijderen|удалить|удаление|удалить аккаунт)\b/,
  ];
  const cjkDeletion = /削除|删除|消除/.test(content);
  const explicitlyNotDeletion =
    /\b(access request|request access|export my data|correct my|update my|change my|marketing opt.?out|unsubscribe|stop marketing|fix my)\b/.test(content);
  return !explicitlyNotDeletion && (cjkDeletion || positiveTerms.some((pattern) => pattern.test(content)));
}

function chooseTreatment(observation, rules) {
  const { category, action } = evidencePolicy(observation, rules);
  if (observation.state === 'ABSENT') return { category, action, violation: false };
  if (observation.resourceId.startsWith('data_flow_')) {
    return { category, action: observation.state === 'ACTIVE' ? 'DISABLE' : 'DISABLED',
      violation: observation.state === 'ACTIVE', operation: 'REPORT_ACTIVE_DATA_FLOW' };
  }
  if (observation.resourceId.startsWith('backup_')) {
    return { category, action: 'RETAIN', violation: observation.state !== 'BLOCKED', operation: 'REPORT_RESTORE_RISK' };
  }
  if (observation.state === 'BLOCKED' || observation.state === 'DISABLED') return { category, action, violation: false };

  const directPii = containsDirectIdentifiers(observation);
  const linked = observation.pairs.some(([key, value]) =>
    ['customer_reference', 'subject_reference', 'user_id'].includes(key) &&
    value !== null && String(value).trim() !== '');

  if (category === 'SECURITY_AUDIT_LOG' || action === 'RETAIN') {
    return { category, action: 'RETAIN', violation: false };
  }
  if (action === 'REDACT') {
    return { category, action, violation: directPii, operation: directPii ? 'REPORT_EXPOSED_PII' : '' };
  }
  if (action === 'ANONYMIZE') {
    return { category, action, violation: directPii || linked, operation: directPii || linked ? 'REPORT_EXPOSED_PII' : '' };
  }
  if (action === 'DELETE') {
    return { category, action, violation: true, operation: 'REPORT_REMAINING_RECORD' };
  }
  return { category, action, violation: directPii || linked, operation: directPii || linked ? 'REPORT_REMAINING_RECORD' : '' };
}

function buildCase(request, identity, evidenceFiles, activityRows, rules) {
  if (!isDeletionRequest(request.request_text)) {
    return { case_id: request.case_id, deletion_status: 'NOT_APPLICABLE', steps: [] };
  }

  const { observations } = collectObservations(request, identity, evidenceFiles, activityRows);
  const findings = [];
  const remediations = [];
  const verifications = [];

  for (const observation of observations) {
    const treatment = chooseTreatment(observation, rules);

    if (observation.state === 'ABSENT') {
      if (observation.systemId === 'account_service') {
        verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId,
          'VERIFY_RECORD_ABSENT', 'ABSENT', observation.evidenceId));
      }
      continue;
    }

    if (observation.resourceId.startsWith('data_flow_') && observation.state === 'ACTIVE') {
      findings.push(makeStep('FINDING', observation.systemId, observation.resourceId,
        'REPORT_ACTIVE_DATA_FLOW', 'ACTIVE', observation.evidenceId));
      remediations.push(makeStep('REMEDIATION', observation.systemId, observation.resourceId,
        'DISABLE_DATA_FLOW', 'DISABLED', ''));
      verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId,
        'VERIFY_DATA_FLOW_DISABLED', 'DISABLED', ''));
      continue;
    }
    if (observation.resourceId.startsWith('backup_') && observation.state !== 'BLOCKED') {
      findings.push(makeStep('FINDING', observation.systemId, observation.resourceId,
        'REPORT_RESTORE_RISK', 'ACTIVE', observation.evidenceId));
      remediations.push(makeStep('REMEDIATION', observation.systemId, observation.resourceId,
        'BLOCK_RESTORE', 'BLOCKED', ''));
      verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId,
        'VERIFY_RESTORE_BLOCKED', 'BLOCKED', ''));
      continue;
    }

    if (treatment.violation) {
      findings.push(makeStep('FINDING', observation.systemId, observation.resourceId,
        treatment.operation || 'REPORT_REMAINING_RECORD', 'PRESENT', observation.evidenceId));
      const operationByAction = {
        DELETE: ['DELETE_RECORD', 'ABSENT', 'VERIFY_RECORD_ABSENT'],
        REDACT: ['REDACT_RECORD', 'REDACTED', 'VERIFY_RECORD_REDACTED'],
        ANONYMIZE: ['ANONYMIZE_RECORD', 'ANONYMIZED', 'VERIFY_RECORD_ANONYMIZED'],
      };
      const plan = operationByAction[treatment.action];
      if (plan) {
        remediations.push(makeStep('REMEDIATION', observation.systemId, observation.resourceId, plan[0], plan[1], ''));
        verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId, plan[2], plan[1], ''));
      }
    } else if (observation.state === 'BLOCKED') {
      verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId,
        'VERIFY_RESTORE_BLOCKED', 'BLOCKED', observation.evidenceId));
    } else if (treatment.action === 'RETAIN') {
      verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId,
        'VERIFY_RECORD_PRESENT', 'PRESENT', observation.evidenceId));
    } else if (observation.state === 'REDACTED') {
      verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId,
        'VERIFY_RECORD_REDACTED', 'REDACTED', observation.evidenceId));
    } else if (observation.state === 'ANONYMIZED') {
      verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId,
        'VERIFY_RECORD_ANONYMIZED', 'ANONYMIZED', observation.evidenceId));
    } else if (observation.state === 'DISABLED') {
      verifications.push(makeStep('VERIFICATION', observation.systemId, observation.resourceId,
        'VERIFY_DATA_FLOW_DISABLED', 'DISABLED', observation.evidenceId));
    }
  }

  const accountAbsent = verifications.some((step) =>
    step.system_id === 'account_service' && step.operation === 'VERIFY_RECORD_ABSENT');
  if (findings.length > 0 && !accountAbsent) {
    const accountResource = observations.find((item) => item.systemId === 'account_service')?.resourceId;
    if (accountResource) {
      verifications.push(makeStep('VERIFICATION', 'account_service', accountResource,
        'VERIFY_RECORD_ABSENT', 'ABSENT', ''));
    }
  }

  const hasViolations = findings.length > 0;
  const hasEvidenceBackedAccountAbsence = verifications.some((step) =>
    step.system_id === 'account_service' && step.operation === 'VERIFY_RECORD_ABSENT' && step.evidence_id);
  let status;
  if (hasViolations) status = 'INCOMPLETE';
  else if (hasEvidenceBackedAccountAbsence) status = 'COMPLETE';
  else {
    status = 'INCOMPLETE';
    const account = observations.find((item) => item.systemId === 'account_service');
    if (account && !verifications.some((step) => step.resource_id === account.resourceId)) {
      verifications.push(makeStep('VERIFICATION', 'account_service', account.resourceId,
        'VERIFY_RECORD_ABSENT', 'ABSENT', ''));
    }
  }

  let steps;
  if (status === 'COMPLETE') {
    steps = sortSteps(verifications.filter((step) => step.evidence_id), VERIFICATION_ORDER);
  } else {
    const uniqueFindings = dedupeSteps(findings);
    const uniqueRemediations = dedupeSteps(remediations);
    const uniqueVerifications = dedupeSteps(verifications.map((step) => ({ ...step, evidence_id: '' })));
    steps = [
      ...sortSteps(uniqueFindings, FINDING_ORDER),
      ...sortSteps(uniqueRemediations, REMEDIATION_ORDER),
      ...sortSteps(uniqueVerifications, VERIFICATION_ORDER),
    ];
  }
  steps.forEach((step, index) => { step.step_no = index + 1; });
  return { case_id: request.case_id, deletion_status: status, steps };
}

function dedupeSteps(steps) {
  const unique = new Map();
  for (const step of steps) {
    const key = [step.phase, step.system_id, step.resource_id, step.operation].join('\u0000');
    const previous = unique.get(key);
    if (!previous || (!previous.evidence_id && step.evidence_id)) unique.set(key, step);
  }
  return [...unique.values()];
}

function encodeCsvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function run(args = process.argv.slice(2)) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key.startsWith('--')) options.set(key, args[index + 1]);
  }

  const inputPath = options.has('--input')
    ? path.resolve(process.cwd(), options.get('--input'))
    : path.join(DATASET, 'deletion_requests.csv');
  const outputPath = options.has('--output')
    ? path.resolve(process.cwd(), options.get('--output'))
    : path.join(ROOT, 'output.csv');

  const requests = readCsv(inputPath);
  const identities = readCsv(path.join(DATASET, 'user_identities.csv'));
  const auditRows = readCsv(path.join(DATASET, 'user_audit_log.csv'));
  const activityRows = readCsv(path.join(DATASET, 'system_activity.csv'));
  const rules = readCsv(path.join(DATASET, 'deletion_rules.csv'));
  const manifest = readCsv(path.join(DATASET, 'evidence_files.csv'));
  const evidenceFiles = loadEvidence(DATASET, manifest);

  const rows = requests.map((request) => {
    const identity = resolveIdentity(request, identities, auditRows);
    return buildCase(request, identity, evidenceFiles, activityRows, rules);
  }).sort((left, right) => left.case_id.localeCompare(right.case_id));

  const output = [
    OUTPUT_FIELDS.join(','),
    ...rows.map((row) => [
      row.case_id,
      row.deletion_status,
      JSON.stringify(row.steps),
    ].map(encodeCsvField).join(',')),
  ].join('\n') + '\n';
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Wrote ${rows.length} rows to ${path.relative(ROOT, outputPath) || outputPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseCsv, isDeletionRequest, resolveIdentity, buildCase, run };
