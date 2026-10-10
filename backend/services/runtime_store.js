const MAX_HISTORY = 100;

let sequence = 0;
const agentRuns = [];
const activity = [];
const decisions = new Map();

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
  return pushLimited(agentRuns, {
    time: generatedAt.slice(11, 16),
    title: `${run.agent} run completed`,
    detail: `${run.source || 'service'} · ${run.status || 'COMPLETED'}`,
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
  return decision;
}

function getDecision(id) {
  return decisions.get(id);
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
