import { LEGACY_LATENCY_SLOTS, mergeLatencyAssignments, validateLatencyTask, validateLatencyBackup } from '../shared/latencyTasks.js';
import { EXTRA_PING_MAX_BYTES } from '../shared/extraPing.js';
import { sanitizePingNode, validatePingNode } from '../shared/pingNode.js';
import { AppError } from '../utils/errors.js';

const newId = () => `p_${crypto.randomUUID()}`;
const key = 'latency_tasks';

export function migrateLatencyConfig(settings, servers, now = Date.now()) {
  const tasks = [], sources = [];
  for (const slot of LEGACY_LATENCY_SLOTS) {
    const globalTarget = sanitizePingNode(settings[slot]);
    const targets = new Map();
    if (globalTarget) targets.set(globalTarget, []);
    for (const server of servers) {
      const raw = server[slot];
      const target = raw === 0 || raw === '0' ? '' : sanitizePingNode(raw || globalTarget);
      if (!target) continue;
      if (!targets.has(target)) targets.set(target, []);
      targets.get(target).push(server.id);
    }
    for (const [target, nodes] of targets) {
      const id = newId();
      tasks.push({ id, name: String(settings[`${slot}_name`] || slot), target, interval: 20, nodes, auto_join: target === globalTarget, legacy_slot: slot });
      for (const node of nodes) sources.push({ id, node, slot, target, before: now });
    }
  }
  for (const extra of settings.extra_ping_nodes || []) {
    if (!extra.target) continue;
    tasks.push({ ...extra, name: extra.name?.trim() || extra.id, interval: 20, nodes: servers.map(server => server.id), auto_join: true });
    sources.push({ id: extra.id, extra: true, target: extra.target, before: now });
  }
  return { version: 1, revision: 1, migrated_at: now, tasks, sources, archives: [], seen_nodes: servers.map(server => server.id), legacy: { settings: Object.fromEntries([...LEGACY_LATENCY_SLOTS, ...LEGACY_LATENCY_SLOTS.map(slot => `${slot}_name`), 'extra_ping_nodes'].map(field => [field, settings[field]])), servers: servers.map(server => ({ id: server.id, ...Object.fromEntries(LEGACY_LATENCY_SLOTS.map(slot => [slot, server[slot]])) })) } };
}

async function readDocument(db) {
  const { success, results } = await db.prepare("SELECT key,value FROM settings WHERE key='latency_tasks' OR key GLOB 'latency_tasks:document:*' ORDER BY key").all();
  if (success === false) throw new AppError('latency_config_invalid', 503);
  const row = results.find(row => row.key === key);
  if (!row) return null;
  const header = JSON.parse(row.value);
  const serialized = header.chunked ? results.filter(row => row.key !== key).map(row => row.value).join('') : row.value;
  const document = JSON.parse(serialized);
  if (document.version !== 1 || !Array.isArray(document.tasks)) throw new AppError('latency_config_invalid', 503);
  return { raw: row.value, serialized, document };
}

export async function readLatencyTaskDocument(db) {
  return (await readDocument(db))?.document ?? null;
}

export async function loadLatencyTasks(db) {
  const row = await readDocument(db);
  return row ? reconcileLatencyTasks(db, row, 'reconcile') : null;
}

async function writeDocument(db, previous, document, purge = []) {
  // D1 strings/rows are limited to 2MB. Keep the complete recovery document in ordered chunks,
  // plus bounded active/seen fragments for atomic SQL report filtering without reconstructing a giant SQL string.
  const serialized = JSON.stringify(document), entries = [];
  const add = (kind, value) => entries.push([`${key}:${kind}:${String(entries.length).padStart(9, '0')}`, value]);
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + 32768, serialized.length);
    // Keep a surrogate pair in one D1 string; json_extract cannot preserve its isolated halves.
    if (serialized.charCodeAt(end - 1) >= 0xd800 && serialized.charCodeAt(end - 1) <= 0xdbff &&
      serialized.charCodeAt(end) >= 0xdc00 && serialized.charCodeAt(end) <= 0xdfff) end--;
    add('document', serialized.slice(start, end));
    start = end;
  }
  for (const task of document.tasks) {
    if (!task.nodes.length) add('active', JSON.stringify({ tasks: [task] }));
    for (let i = 0; i < task.nodes.length; i += 1000) add('active', JSON.stringify({ tasks: [{ ...task, nodes: task.nodes.slice(i, i + 1000) }] }));
  }
  for (let i = 0; i < document.seen_nodes.length; i += 1000) add('seen', JSON.stringify({ seen_nodes: document.seen_nodes.slice(i, i + 1000) }));
  const raw = JSON.stringify({ version: document.version, revision: document.revision, chunked: true, write_id: crypto.randomUUID(), tasks: [], seen_nodes: [] });
  const statement = previous
    ? db.prepare("UPDATE settings SET value = ? WHERE key = 'latency_tasks' AND value = ?").bind(raw, previous)
    : db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').bind(key, raw);
  const statements = [statement, db.prepare("DELETE FROM settings WHERE key GLOB 'latency_tasks:*' AND EXISTS(SELECT 1 FROM settings WHERE key='latency_tasks' AND value=?)").bind(raw)];
  let group = [], size = 0;
  const flush = () => {
    if (!group.length) return;
    statements.push(db.prepare("INSERT INTO settings(key,value) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?) WHERE EXISTS(SELECT 1 FROM settings WHERE key='latency_tasks' AND value=?)").bind(JSON.stringify(group), raw));
    group = []; size = 0;
  };
  for (const entry of entries) {
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (size + bytes > 512000) flush();
    group.push(entry); size += bytes;
  }
  flush();
  if (purge.length) {
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('metrics_history','metrics_history_old')").all();
    statements.push(...tables.map(({ name }) => db.prepare(`WITH deleted AS (SELECT value FROM json_each(?)) UPDATE ${name} SET extra_probes=(SELECT json_group_object(key,json(value)) FROM json_each(${name}.extra_probes) WHERE key NOT IN (SELECT value FROM deleted)) WHERE json_valid(extra_probes) AND EXISTS (SELECT 1 FROM json_each(${name}.extra_probes) WHERE key IN (SELECT value FROM deleted)) AND EXISTS (SELECT 1 FROM settings WHERE key='latency_tasks' AND value=?)`).bind(JSON.stringify(purge), raw)));
  }
  const batch = await db.batch(statements);
  return batch[0].meta.changes > 0;
}

export async function ensureLatencyTasks(db, settings) {
  const row = await readDocument(db) || await createLatencyDocument(db, settings);
  return row.document;
}

async function createLatencyDocument(db, settings) {
  const { results } = await db.prepare('SELECT id, custom_ct, custom_cu, custom_cm, custom_bd, node_1, node_2, node_3, node_4 FROM servers').all();
  await writeDocument(db, null, migrateLatencyConfig(settings, results));
  return readDocument(db);
}

// Register/delete and edits reconcile against the same CAS row, including auto-join.
export async function changeLatencyTasks(db, settings, action, input = {}) {
  const row = await readDocument(db) || await createLatencyDocument(db, settings);
  return reconcileLatencyTasks(db, row, action, input);
}

async function reconcileLatencyTasks(db, row, action, input = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const document = row.document;
    let purge = [];
    const { results } = await db.prepare('SELECT id FROM servers').all();
    const nodes = results.map(node => node.id), fresh = nodes.filter(id => !document.seen_nodes.includes(id));
    for (const task of document.tasks) task.nodes = [...new Set([...task.nodes.filter(id => nodes.includes(id)), ...(task.auto_join ? fresh : [])])];
    document.seen_nodes = nodes;
    if (action === 'save') {
      if (!validateLatencyTask(input, validatePingNode, nodes)) throw new AppError('invalidLatencyTask', 400);
      const previous = input.id && document.tasks.find(task => task.id === input.id);
      if (input.id && !previous) throw new AppError('latency_task_missing', 404);
      if (previous && (!Array.isArray(input.base) || input.base.some(id => typeof id !== 'string'))) throw new AppError('latency_base_required', 400);
      const task = { ...(previous || {}), id: previous?.id || newId(), name: input.name.trim(), target: validatePingNode(input.target).value, interval: input.interval, auto_join: input.auto_join, nodes: previous ? mergeLatencyAssignments(previous.nodes, input.nodes, input.base).filter(id => nodes.includes(id)) : input.nodes };
      if (previous && previous.target !== task.target) {
        document.archives.push({ ...previous, archived_at: Date.now() });
        task.metric_id = newId();
        delete task.legacy_slot;
      }
      if (previous) document.tasks[document.tasks.indexOf(previous)] = task;
      else document.tasks.push(task);
    } else if (action === 'node') {
      if (!nodes.includes(input.node)) throw new AppError('serverNotFound', 404);
      if (!Array.isArray(input.tasks) || !Array.isArray(input.base) || [...input.tasks, ...input.base].some(id => typeof id !== 'string')) throw new AppError('invalidLatencyTask', 400);
      for (const task of document.tasks) {
        const current = task.nodes.includes(input.node);
        const chosen = input.tasks.includes(task.id), base = input.base.includes(task.id);
        if (chosen !== base) task.nodes = chosen ? [...new Set([...task.nodes, input.node])] : task.nodes.filter(id => id !== input.node);
        else if (current) task.nodes = [...new Set(task.nodes)];
      }
    } else if (action === 'order') {
      if (!Array.isArray(input.ids) || input.ids.length !== document.tasks.length || new Set(input.ids).size !== input.ids.length || input.ids.some(id => !document.tasks.some(task => task.id === id))) throw new AppError('latency_order_conflict', 409);
      document.tasks.sort((a, b) => input.ids.indexOf(a.id) - input.ids.indexOf(b.id));
    } else if (action === 'import') {
      const backup = input.document;
      if (!validateLatencyBackup(backup, validatePingNode)) throw new AppError('invalidLatencyTask', 400);
      const imported = [], ids = new Set();
      for (const task of backup.tasks) {
        const mapped = { ...task, nodes: task.nodes?.map(id => input.serverIdMap?.get(id) || id).filter(id => nodes.includes(id)) };
        if (!validateLatencyTask(mapped, validatePingNode, nodes) || ids.has(task.id) || (task.legacy_slot && !LEGACY_LATENCY_SLOTS.includes(task.legacy_slot))) throw new AppError('invalidLatencyTask', 400);
        ids.add(task.id);
        const known = [...document.tasks, ...document.archives].find(entry => (entry.metric_id || entry.id) === (task.metric_id || task.id) && entry.target !== task.target);
        imported.push({ id: task.id, name: task.name.trim(), target: validatePingNode(task.target).value, interval: task.interval, auto_join: task.auto_join, nodes: mapped.nodes, ...(task.legacy_slot ? { legacy_slot: task.legacy_slot } : {}), ...(known ? { metric_id: newId() } : task.metric_id ? { metric_id: task.metric_id } : {}) });
      }
      document.archives.push(...document.tasks.filter(task => !imported.some(entry => entry.id === task.id && (entry.metric_id || entry.id) === (task.metric_id || task.id))).map(task => ({ ...task, archived_at: Date.now() })));
      document.tasks = imported;
      const importedByMetric = new Map(imported.map(task => [task.metric_id || task.id, task]));
      const importedSources = (Array.isArray(backup.sources) ? backup.sources : []).filter(source => {
        const task = importedByMetric.get(source.id);
        return task && source.target === task.target && Number.isFinite(source.before) &&
          (source.extra === true || (LEGACY_LATENCY_SLOTS.includes(source.slot) && typeof source.node === 'string'));
      }).map(source => ({ ...source, ...(source.node ? { node: input.serverIdMap?.get(source.node) || source.node } : {}) }));
      document.sources = [...document.sources.filter(source => !ids.has(source.id)), ...importedSources];
      document.archives.push(...(Array.isArray(backup.archives) ? backup.archives : []).filter(entry =>
        entry.id && validateLatencyTask(entry, validatePingNode, entry.nodes || []) &&
        !document.archives.some(known => known.id === entry.id && (known.metric_id || known.id) === (entry.metric_id || entry.id)) &&
        (!importedByMetric.has(entry.metric_id || entry.id) || importedByMetric.get(entry.metric_id || entry.id).id === entry.id)
      ).map(entry => ({ ...entry, nodes: entry.nodes.map(id => input.serverIdMap?.get(id) || id) })));
      // Keep the imported original configuration retrievable without making it live.
      document.imported_legacy = { migrated_at: backup.migrated_at, tasks: backup.tasks, sources: backup.sources, legacy: backup.legacy, archives: backup.archives };
    } else if (action === 'delete') {
      const task = document.tasks.find(task => task.id === input.id);
      if (!task) throw new AppError('latency_task_missing', 404);
      document.archives.push({ ...task, deleted_at: Date.now() });
      document.tasks = document.tasks.filter(task => task.id !== input.id);
      purge = document.archives.filter(entry => entry.id === task.id).map(entry => entry.metric_id || entry.id);
    }
    // A catalog can contain disjoint node targets; the Agent boundary applies to each delivered config, not their union.
    if (['save', 'node'].includes(action)) for (const node of nodes) {
      const assigned = document.tasks.filter(task => task.nodes.includes(node)).map(task => ({ id: task.metric_id || task.id, target: task.target, interval: task.interval }));
      if (new TextEncoder().encode(JSON.stringify(assigned)).length > EXTRA_PING_MAX_BYTES) throw new AppError('pingConfigTooLarge', 400);
      const named = document.tasks.filter(task => task.nodes.includes(node)).map(task => ({ id: task.metric_id || task.id, name: task.name, target: task.target }));
      if (new TextEncoder().encode(JSON.stringify(named)).length > EXTRA_PING_MAX_BYTES) throw new AppError('pingConfigTooLarge', 400);
    }
    if (JSON.stringify(document) === row.serialized) return document;
    document.revision++;
    if (await writeDocument(db, row.raw, document, purge)) return document;
    row = await readDocument(db);
  }
  throw new AppError('latency_config_conflict', 409);
}
