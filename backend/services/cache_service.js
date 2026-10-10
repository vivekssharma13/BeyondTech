const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function bucketFor(timeMs) {
  return Math.floor(timeMs / FIFTEEN_MINUTES_MS);
}

function createBucketCache() {
  const entries = new Map();
  const inFlight = new Map();

  async function getOrCreate(keyPrefix, factory, { refresh = false, now = Date.now() } = {}) {
    const bucket = bucketFor(now);
    const key = `${keyPrefix}:${bucket}`;
    const existing = entries.get(key);
    if (!refresh && existing && Date.parse(existing.expiresAt) > now) return existing.data;
    if (!refresh && inFlight.has(key)) return inFlight.get(key);

    const pending = Promise.resolve()
      .then(factory)
      .then(data => {
        const expiresAt = new Date((bucket + 1) * FIFTEEN_MINUTES_MS).toISOString();
        entries.set(key, {
          data,
          generatedAt: data.generatedAt,
          expiresAt,
          agentRunId: data.agentRunId,
        });
        return data;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  function latest(prefix) {
    return [...entries.entries()]
      .filter(([key]) => key.startsWith(`${prefix}:`))
      .map(([, entry]) => entry)
      .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))[0];
  }

  function clear() {
    entries.clear();
    inFlight.clear();
  }

  return { getOrCreate, latest, clear };
}

module.exports = { FIFTEEN_MINUTES_MS, bucketFor, createBucketCache };
