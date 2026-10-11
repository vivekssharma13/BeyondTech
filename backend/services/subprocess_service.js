const { spawn } = require('child_process');

class SubprocessError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'SubprocessError';
    this.code = code;
    this.metadata = metadata;
  }
}

function sanitizeStderr(value) {
  return String(value || '')
    .replace(/(api[_-]?key|authorization|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 4000);
}

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function runAttempt({ command, args = [], cwd, env = process.env, input, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const startedMs = Date.now();
    const child = spawn(command, args, { cwd, env });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let terminationTimer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (error) reject(error);
      else resolve(result);
    };

    const terminate = (code, message) => {
      child.kill('SIGTERM');
      terminationTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000);
      finish(new SubprocessError(code, message, {
        durationMs: Date.now() - startedMs,
        stderr: sanitizeStderr(stderr.toString('utf8')),
      }));
    };

    const timeoutTimer = setTimeout(() => terminate('PROCESS_TIMEOUT', `Process exceeded ${timeoutMs} ms timeout`), timeoutMs);
    child.on('error', error => finish(new SubprocessError('PROCESS_SPAWN_FAILED', error.message, { durationMs: Date.now() - startedMs })));
    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > maxOutputBytes) terminate('PROCESS_OUTPUT_LIMIT', `Process stdout exceeded ${maxOutputBytes} bytes`);
    });
    child.stderr.on('data', chunk => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > maxOutputBytes) terminate('PROCESS_OUTPUT_LIMIT', `Process stderr exceeded ${maxOutputBytes} bytes`);
    });
    child.on('close', exitCode => {
      clearTimeout(terminationTimer);
      if (settled) return;
      const metadata = { exitCode, durationMs: Date.now() - startedMs, stderr: sanitizeStderr(stderr.toString('utf8')) };
      if (exitCode !== 0) {
        finish(new SubprocessError('PROCESS_NONZERO_EXIT', metadata.stderr || `Process exited with status ${exitCode}`, metadata));
        return;
      }
      let data;
      try {
        data = JSON.parse(stdout.toString('utf8'));
      } catch {
        finish(new SubprocessError('PROCESS_INVALID_JSON', 'Process returned invalid JSON', metadata));
        return;
      }
      if (data?.error) {
        finish(new SubprocessError('PROCESS_REPORTED_ERROR', String(data.error), metadata));
        return;
      }
      finish(null, { data, metadata });
    });
    child.stdin.on('error', error => finish(new SubprocessError('PROCESS_STDIN_FAILED', error.message, { durationMs: Date.now() - startedMs })));
    child.stdin.end(input == null ? undefined : typeof input === 'string' ? input : JSON.stringify(input));
  });
}

async function runJsonProcess(options) {
  const timeoutMs = positiveInteger(options.timeoutMs, process.env.PYTHON_PROCESS_TIMEOUT_MS || 30000, 'timeoutMs');
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, process.env.PYTHON_MAX_OUTPUT_BYTES || 1048576, 'maxOutputBytes');
  const retries = Number(options.retries ?? 0);
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) throw new TypeError('retries must be an integer from 0 to 2');
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await runAttempt({ ...options, timeoutMs, maxOutputBytes });
      return { ...result, metadata: { ...result.metadata, attempt: attempt + 1 } };
    } catch (error) {
      lastError = error;
      if (attempt === retries || !['PROCESS_SPAWN_FAILED', 'PROCESS_TIMEOUT'].includes(error.code)) throw error;
    }
  }
  throw lastError;
}

module.exports = { SubprocessError, sanitizeStderr, runJsonProcess };

