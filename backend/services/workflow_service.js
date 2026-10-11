const { randomUUID } = require('crypto');
const { getDatabase, json } = require('./database_service');

const SECRET_PATTERN = /(api[_-]?key|authorization|token|secret|password)/i;

function sanitize(value, depth = 0) {
  if (depth > 5) return '[MAX_DEPTH]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      SECRET_PATTERN.test(key) ? '[REDACTED]' : sanitize(item, depth + 1),
    ]));
  }
  return String(value);
}

function createIdentifier(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function recordEvent({ workflowId = null, runId = null, component, eventType, status, durationMs = null, metadata = {} }) {
  const eventId = createIdentifier('event');
  getDatabase().prepare(`INSERT INTO workflow_events
    (event_id, workflow_id, run_id, component, event_type, status, timestamp, duration_ms, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, workflowId, runId, component, eventType, status, new Date().toISOString(), durationMs, json(sanitize(metadata)));
  return eventId;
}

function startWorkflow({ workflowType, farmId = null, metadata = {} }) {
  const workflowId = createIdentifier('workflow');
  const startedAt = new Date().toISOString();
  getDatabase().prepare(`INSERT INTO workflows
    (workflow_id, workflow_type, status, farm_id, started_at, request_metadata_json)
    VALUES (?, ?, 'RUNNING', ?, ?, ?)`)
    .run(workflowId, workflowType, farmId, startedAt, json(sanitize(metadata)));
  recordEvent({ workflowId, component: 'ORCHESTRATOR', eventType: 'WORKFLOW_STARTED', status: 'RUNNING', metadata });
  return { workflowId, workflowType, farmId, startedAt, startedMs: Date.now() };
}

function completeWorkflow(workflow, resultSummary = {}) {
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - workflow.startedMs;
  const status = ['DEGRADED', 'UNAVAILABLE', 'INCOMPLETE_SIMULATION_CONFIG', 'INCOMPLETE_ASSUMPTIONS', 'INCOMPLETE_DATA', 'INCOMPLETE_GENERATION_OUTLOOK', 'INFEASIBLE', 'REJECTED', 'EXPIRED'].includes(resultSummary.status)
    ? resultSummary.status : 'COMPLETED';
  getDatabase().prepare(`UPDATE workflows SET status=?, completed_at=?, duration_ms=?, result_summary_json=? WHERE workflow_id=?`)
    .run(status, completedAt, durationMs, json(sanitize(resultSummary)), workflow.workflowId);
  recordEvent({ workflowId: workflow.workflowId, component: 'ORCHESTRATOR', eventType: 'WORKFLOW_COMPLETED', status, durationMs, metadata: resultSummary });
}

function failWorkflow(workflow, error) {
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - workflow.startedMs;
  const detail = { type: error?.name || 'Error', code: error?.code || null, message: error?.message || String(error) };
  getDatabase().prepare(`UPDATE workflows SET status='FAILED', completed_at=?, duration_ms=?, error_json=? WHERE workflow_id=?`)
    .run(completedAt, durationMs, json(sanitize(detail)), workflow.workflowId);
  recordEvent({ workflowId: workflow.workflowId, component: 'ORCHESTRATOR', eventType: 'WORKFLOW_FAILED', status: 'FAILED', durationMs, metadata: detail });
}

function startComponent({ workflowId = null, component, sourceType = null, modelName = null, modelVersion = null, input = {} }) {
  const runId = createIdentifier(`${component.toLowerCase()}-run`);
  const startedAt = new Date().toISOString();
  getDatabase().prepare(`INSERT INTO component_executions
    (run_id, workflow_id, component, status, source_type, model_name, model_version, started_at, input_summary_json)
    VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)`)
    .run(runId, workflowId, component, sourceType, modelName, modelVersion, startedAt, json(sanitize(input)));
  recordEvent({ workflowId, runId, component, eventType: 'COMPONENT_STARTED', status: 'RUNNING', metadata: { sourceType, modelName, modelVersion } });
  return { workflowId, runId, component, startedAt, startedMs: Date.now() };
}

function completeComponent(execution, { status = 'COMPLETED', sourceType = null, output = {} } = {}) {
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - execution.startedMs;
  getDatabase().prepare(`UPDATE component_executions SET status=?, source_type=COALESCE(?, source_type), completed_at=?, duration_ms=?, output_summary_json=? WHERE run_id=?`)
    .run(status, sourceType, completedAt, durationMs, json(sanitize(output)), execution.runId);
  recordEvent({ workflowId: execution.workflowId, runId: execution.runId, component: execution.component, eventType: 'COMPONENT_COMPLETED', status, durationMs, metadata: { sourceType, output: sanitize(output) } });
}

function failComponent(execution, error, metadata = {}) {
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - execution.startedMs;
  const detail = { type: error?.name || 'Error', code: error?.code || null, message: error?.message || String(error), process: error?.metadata || null, ...metadata };
  getDatabase().prepare(`UPDATE component_executions SET status='FAILED', completed_at=?, duration_ms=?, error_json=? WHERE run_id=?`)
    .run(completedAt, durationMs, json(sanitize(detail)), execution.runId);
  recordEvent({ workflowId: execution.workflowId, runId: execution.runId, component: execution.component, eventType: 'COMPONENT_FAILED', status: 'FAILED', durationMs, metadata: detail });
}

function recordFallback({ workflowId = null, runId = null, component, reason, sourceType = 'FALLBACK' }) {
  recordEvent({ workflowId, runId, component, eventType: 'FALLBACK_USED', status: 'DEGRADED', metadata: { reason, sourceType } });
}

function cacheObserver(workflowId, component) {
  return event => recordEvent({
    workflowId,
    component,
    eventType: event.type,
    status: event.type === 'CACHE_MISS' ? 'RUNNING' : 'COMPLETED',
    metadata: event,
  });
}

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

function mapWorkflow(row) {
  return {
    workflowId: row.workflow_id,
    workflowType: row.workflow_type,
    status: row.status,
    farmId: row.farm_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    requestMetadata: parseJson(row.request_metadata_json),
    resultSummary: parseJson(row.result_summary_json),
    error: parseJson(row.error_json),
  };
}

function listWorkflows({ limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return getDatabase().prepare('SELECT * FROM workflows ORDER BY started_at DESC LIMIT ?').all(safeLimit).map(mapWorkflow);
}

function getWorkflowDetails(workflowId) {
  const workflow = getDatabase().prepare('SELECT * FROM workflows WHERE workflow_id=?').get(workflowId);
  if (!workflow) return null;
  const events = getDatabase().prepare('SELECT * FROM workflow_events WHERE workflow_id=? ORDER BY timestamp, rowid').all(workflowId).map(row => ({
    eventId: row.event_id,
    workflowId: row.workflow_id,
    runId: row.run_id,
    component: row.component,
    eventType: row.event_type,
    status: row.status,
    timestamp: row.timestamp,
    durationMs: row.duration_ms,
    metadata: parseJson(row.metadata_json),
  }));
  const components = getDatabase().prepare('SELECT * FROM component_executions WHERE workflow_id=? ORDER BY started_at').all(workflowId).map(row => ({
    runId: row.run_id,
    component: row.component,
    status: row.status,
    sourceType: row.source_type,
    modelName: row.model_name,
    modelVersion: row.model_version,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    inputSummary: parseJson(row.input_summary_json),
    outputSummary: parseJson(row.output_summary_json),
    error: parseJson(row.error_json),
  }));
  return { workflow: mapWorkflow(workflow), components, events };
}

module.exports = {
  sanitize,
  createIdentifier,
  recordEvent,
  startWorkflow,
  completeWorkflow,
  failWorkflow,
  startComponent,
  completeComponent,
  failComponent,
  recordFallback,
  cacheObserver,
  listWorkflows,
  getWorkflowDetails,
};

