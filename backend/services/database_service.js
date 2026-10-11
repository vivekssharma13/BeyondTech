const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DATABASE_PATH = path.join(__dirname, '..', 'data', 'energy_platform.sqlite');
const MIGRATIONS_PATH = path.join(__dirname, '..', 'db', 'migrations');

let database;
let databasePath;

function json(value) {
  return JSON.stringify(value ?? null);
}

function resolveDatabasePath() {
  return process.env.ENERGY_DB_PATH || DEFAULT_DATABASE_PATH;
}

function runMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => Number(row.version)));
  const files = fs.readdirSync(MIGRATIONS_PATH).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_PATH, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(version, file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyRetention(db) {
  const configuredDays = Number(process.env.EXECUTION_LOG_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(configuredDays) || configuredDays < 1) throw new Error('EXECUTION_LOG_RETENTION_DAYS must be a positive number');
  const cutoff = new Date(Date.now() - configuredDays * 86400000).toISOString();
  db.prepare('DELETE FROM workflow_events WHERE timestamp < ?').run(cutoff);
  db.prepare(`DELETE FROM optimizer_scenarios WHERE created_at < ? AND
    (workflow_id IS NULL OR workflow_id NOT IN (SELECT DISTINCT workflow_id FROM decision_proposals WHERE workflow_id IS NOT NULL))`).run(cutoff);
  db.prepare(`DELETE FROM component_executions WHERE started_at < ? AND
    (workflow_id IS NULL OR workflow_id NOT IN (SELECT DISTINCT workflow_id FROM decision_proposals WHERE workflow_id IS NOT NULL))`).run(cutoff);
  db.prepare('DELETE FROM workflows WHERE started_at < ? AND workflow_id NOT IN (SELECT DISTINCT workflow_id FROM decision_proposals WHERE workflow_id IS NOT NULL)').run(cutoff);
}

function getDatabase() {
  const wantedPath = resolveDatabasePath();
  if (database && databasePath === wantedPath) return database;
  if (database) database.close();
  if (wantedPath !== ':memory:') fs.mkdirSync(path.dirname(wantedPath), { recursive: true });
  database = new DatabaseSync(wantedPath);
  databasePath = wantedPath;
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  runMigrations(database);
  applyRetention(database);
  return database;
}

function transaction(operation) {
  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function closeDatabase() {
  if (database) database.close();
  database = undefined;
  databasePath = undefined;
}

module.exports = { getDatabase, transaction, closeDatabase, json, DEFAULT_DATABASE_PATH };

