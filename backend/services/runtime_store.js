const MAX_HISTORY = 100;

let sequence = 0;
const agentRuns = [];
const activity = [];
const decisions = new Map();
const { saveDecisionProposal, loadDecision } = require('./audit_repository');

function createId(prefix) {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}`;
}

function pushLimited(collection, item) {
  collection.unshift(item);
  if (collection.length > MAX_HISTORY) collection.length = MAX_HISTORY;
  return item;
}

function recordAgentRun(run) {
  const generatedAt = run.generatedAt || new Date().toISOString();
  const normalizedStatus = run.status || 'COMPLETED';
  return pushLimited(agentRuns, {
    time: generatedAt.slice(11, 16),
    title: `${run.agent} run ${normalizedStatus.toLowerCase()}`,
    detail: `${run.source || 'service'} · ${normalizedStatus}`,
    ...run,
    generatedAt,
  });
}

function listAgentRuns({ agent, farmId } = {}) {
  return agentRuns.filter(run => (!agent || run.agent === agent) && (!farmId || run.farmId === farmId));
}

function recordActivity(entry) {
  return pushLimited(activity, {
    activityId: createId('activity'),
    timestamp: new Date().toISOString(),
    ...entry,
  });
}

function listActivity({ farmId } = {}) {
  return activity.filter(entry => !farmId || entry.farmId === farmId);
}

function saveDecision(decision) {
  decisions.set(decision.agentRunId, decision);
  saveDecisionProposal(decision);
  return decision;
}

function getDecision(id) {
  const inMemory = decisions.get(id);
  if (inMemory) return inMemory;
  const persisted = loadDecision(id);
  if (persisted) decisions.set(id, persisted);
  return persisted;
}

function resetRuntimeStore() {
  sequence = 0;
  agentRuns.length = 0;
  activity.length = 0;
  decisions.clear();
}

module.exports = {
  createId,
  recordAgentRun,
  listAgentRuns,
  recordActivity,
  listActivity,
  saveDecision,
  getDecision,
  resetRuntimeStore,
};
