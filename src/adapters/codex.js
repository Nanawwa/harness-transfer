'use strict';

// Codex / DeepSeek harness reader. Sessions live in
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl.
//
// The file is a flat event log with two interleaved channels:
//   - `type:'response_item'` -> payload is an actual model-protocol item
//       { type:'message', role, content:[{type:'input_text'|'output_text', text}] }
//       { type:'reasoning', summary, content:[{type:'reasoning_text'}] }
//       { type:'function_call', name, arguments(JSON string), call_id }
//       { type:'function_call_output', call_id, output }
//       { type:'custom_tool_call'|'custom_tool_call_output', name, input, call_id }
//   - `type:'event_msg'`    -> UI-level duplicates of the above; SKIPPED
//   - `type:'session_meta'|'turn_context'|'world_state'|'compacted'` -> metadata
//
// Reading only `response_item` avoids duplicating every turn, which is the
// single biggest accuracy win when migrating from Codex.

const fs = require('fs');
const path = require('path');
const { makeSession, textOf } = require('../ir');
const { flattenOutput } = require('./workbuddy');

const DEFAULT_ROOT = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.codex',
  'sessions'
);

function readCodexSession(file) {
  const stats = { unknown: {}, skipped: 0, badLines: 0, images: 0 };
  const events = [];
  let meta = null;
  let directory = '';
  let title = '';
  let timeCreated = 0;
  let timeUpdated = 0;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try {
      r = JSON.parse(t);
    } catch {
      stats.badLines++;
      continue;
    }

    if (r.timestamp) {
      const ms = Date.parse(r.timestamp);
      if (!Number.isNaN(ms)) {
        timeUpdated = Math.max(timeUpdated, ms);
        if (!timeCreated || ms < timeCreated) timeCreated = ms;
      }
    }

    if (r.type === 'session_meta') {
      meta = r.payload || {};
      if (meta.cwd) directory = meta.cwd;
      continue;
    }
    if (r.type === 'event_msg' || r.type === 'turn_context' || r.type === 'world_state' || r.type === 'compacted') {
      stats.skipped++;
      continue;
    }
    if (r.type !== 'response_item') {
      stats.unknown[r.type || '(no type)'] = (stats.unknown[r.type || '(no type)'] || 0) + 1;
      continue;
    }

    const p = r.payload || {};
    const ts = r.timestamp ? Date.parse(r.timestamp) : 0;

    if (p.type === 'message') {
      // `developer` is injected system boilerplate, not conversation.
      if (p.role === 'developer' || p.role === 'system') {
        stats.skipped++;
        continue;
      }
      const text = textOf(p.content);
      const images = (p.content || []).filter((c) => c && c.type === 'input_image');
      stats.images += images.length;
      if (!text && !images.length) {
        stats.skipped++;
        continue;
      }
      events.push({
        kind: p.role === 'assistant' ? 'assistant' : 'user',
        ts,
        text,
        images: images.map((i) => i.image_url || i.file_id || '').filter(Boolean),
      });
      continue;
    }
    if (p.type === 'reasoning') {
      const text = textOf(p.content || []) || textOf(p.summary || []);
      if (!text) {
        stats.skipped++;
        continue;
      }
      events.push({ kind: 'reasoning', ts, text });
      continue;
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      events.push({
        kind: 'tool_call',
        ts,
        callId: p.call_id,
        toolName: p.name,
        argsJson: p.type === 'custom_tool_call' ? p.input : p.arguments,
      });
      continue;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      events.push({
        kind: 'tool_result',
        ts,
        callId: p.call_id,
        outputText: flattenOutput(p.output),
        status: /error|failed/i.test(String(p.output || '').slice(0, 200)) ? 'error' : 'completed',
      });
      continue;
    }
    stats.unknown[`response_item:${p.type || '?'}`] = (stats.unknown[`response_item:${p.type || '?'}`] || 0) + 1;
  }

  const s = makeSession({
    id: (meta && (meta.session_id || meta.id)) || path.basename(file, '.jsonl'),
    source: 'codex',
    title: deriveTitle(events),
    directory,
    timeCreated,
    timeUpdated,
  });
  s.events = events;
  s.stats = stats;
  return s;
}

// Codex injects a synthetic first user turn carrying environment metadata.
// The user never typed it, so it must not become the session title.
function isInjected(text) {
  const t = (text || '').trimStart();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<app-context>')
  );
}

function deriveTitle(events) {
  const first = events.find((e) => e.kind === 'user' && e.text && !isInjected(e.text));
  if (!first) return '(untitled)';
  const one = first.text.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? one.slice(0, 60) + '…' : one;
}

function listCodexSessions(root = DEFAULT_ROOT) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  (function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const f of entries) {
      const p = path.join(d, f);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (f.endsWith('.jsonl')) out.push({ file: p });
    }
  })(root);
  return out;
}

/**
 * A resumed Codex session spans several rollout files that share one
 * session_id, oldest first. Reading a single file yields only a fragment, so
 * the migrator groups by id and merges.
 */
function readCodexSessionFiles(files) {
  if (!Array.isArray(files)) files = [files];
  const ordered = [...files].sort(
    (a, b) => fs.statSync(typeof a === 'string' ? a : a.file).mtimeMs - fs.statSync(typeof b === 'string' ? b : b.file).mtimeMs
  );
  const merged = makeSession({ id: '', source: 'codex' });
  const stats = { unknown: {}, skipped: 0, badLines: 0, images: 0 };
  let seen = false;

  for (const f of ordered) {
    const file = typeof f === 'string' ? f : f.file;
    const part = readCodexSession(file);
    if (!seen) {
      merged.id = part.id;
      merged.directory = part.directory;
      merged.timeCreated = part.timeCreated;
      seen = true;
    } else if (part.directory && !merged.directory) {
      merged.directory = part.directory;
    }
    if (part.timeCreated) {
      merged.timeCreated = seen && merged.timeCreated ? Math.min(merged.timeCreated, part.timeCreated) : part.timeCreated;
    }
    merged.timeUpdated = Math.max(merged.timeUpdated || 0, part.timeUpdated || 0);
    merged.events.push(...part.events);
    for (const k of Object.keys(part.stats.unknown)) {
      stats.unknown[k] = (stats.unknown[k] || 0) + part.stats.unknown[k];
    }
    stats.skipped += part.stats.skipped;
    stats.badLines += part.stats.badLines;
    stats.images += part.stats.images;
  }

  merged.events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  merged.title = deriveTitle(merged.events);
  merged.stats = stats;
  return merged;
}

/** Group rollout files by session id (one session may span several files). */
function groupCodexSessionsById(root = DEFAULT_ROOT) {
  const groups = new Map();
  for (const { file } of listCodexSessions(root)) {
    let id;
    try {
      id = readCodexSession(file).id;
    } catch {
      continue;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ file });
  }
  return groups;
}

module.exports = {
  readCodexSession,
  readCodexSessionFiles,
  groupCodexSessionsById,
  listCodexSessions,
  isInjected,
  DEFAULT_ROOT,
};
