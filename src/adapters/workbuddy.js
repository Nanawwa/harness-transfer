'use strict';

// WorkBuddy reader. Sessions live in ~/.workbuddy/projects/<slug>/<sessionId>.jsonl,
// one JSON record per line. Record shapes observed in the wild:
//
//   { type:'session-meta', id, sessionId, timestamp, meta }
//   { type:'message', id, parentId, timestamp, role:'user'|'assistant',
//     content:[{type:'input_text'|'output_text'|'image_blob_ref', text, ...}] }
//   { type:'reasoning', id, parentId, timestamp, rawContent:[{type:'reasoning_text'}] }
//   { type:'function_call', id, parentId, timestamp, callId, name, arguments }
//   { type:'function_call_result', id, parentId, timestamp, callId, name,
//     status, output:[{type:'input_text', text}] }
//   { type:'ai-title', aiTitle, timestamp }
//   { type:'file-history-snapshot' | 'resend-fork-notice', ... }  -> no conversational value
//
// Unknown record types are counted and reported, never guessed at.

const fs = require('fs');
const path = require('path');
const { makeSession, textOf } = require('../ir');

const DEFAULT_ROOT = path.join(process.env.USERPROFILE || process.env.HOME, '.workbuddy', 'projects');

function parseJsonl(file) {
  const out = [];
  const bad = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      bad.push(line.slice(0, 120));
    }
  }
  return { records: out, bad };
}

function readWorkBuddySession(file) {
  const { records, bad } = parseJsonl(file);
  const stats = { unknown: {}, skipped: 0, badLines: bad.length, images: 0 };

  let meta = null;
  let sessionId = path.basename(file, '.jsonl');
  let title = '';
  let directory = '';
  let timeCreated = 0;
  let timeUpdated = 0;
  const events = [];

  for (const r of records) {
    const t = r && r.type;
    if (r.timestamp) {
      timeUpdated = Math.max(timeUpdated, r.timestamp);
      if (!timeCreated || r.timestamp < timeCreated) timeCreated = r.timestamp;
    }

    if (t === 'session-meta') {
      if (r.sessionId) sessionId = r.sessionId;
      meta = r;
      continue;
    }
    if (t === 'ai-title') {
      if (r.aiTitle) title = r.aiTitle;
      if (r.cwd && !directory) directory = r.cwd;
      continue;
    }
    if (t === 'message') {
      if (r.cwd && !directory) directory = r.cwd;
      // content is normally an array of parts, but some records carry a bare string.
      const blocks = Array.isArray(r.content)
        ? r.content
        : r.content
        ? [{ type: 'input_text', text: String(r.content) }]
        : [];
      const text = textOf(blocks);
      const images = blocks
        .filter((c) => c && c.type === 'image_blob_ref')
        // the blob ref is the durable, portable identifier; blob_path is a
        // machine-local path that means nothing in another harness
        .map((c) => c.blob_id || c.blobId || '')
        .filter(Boolean);
      stats.images += images.length;
      if (!text && !images.length) {
        stats.skipped++;
        continue;
      }
      events.push({
        kind: r.role === 'assistant' ? 'assistant' : 'user',
        ts: r.timestamp || 0,
        text,
        images,
        model: r.providerData && r.providerData.model,
      });
      continue;
    }
    if (t === 'reasoning') {
      const text = textOf((r.rawContent || r.content || []).map((c) => ({ type: 'text', text: c.text })));
      if (!text) {
        stats.skipped++;
        continue;
      }
      events.push({ kind: 'reasoning', ts: r.timestamp || 0, text });
      continue;
    }
    if (t === 'function_call') {
      events.push({
        kind: 'tool_call',
        ts: r.timestamp || 0,
        callId: r.callId,
        toolName: r.name,
        argsJson: typeof r.arguments === 'string' ? r.arguments : JSON.stringify(r.arguments || {}),
      });
      continue;
    }
    if (t === 'function_call_result') {
      events.push({
        kind: 'tool_result',
        ts: r.timestamp || 0,
        callId: r.callId,
        toolName: r.name,
        outputText: textOf(r.output) || flattenOutput(r.output),
        status: r.status || 'completed',
      });
      continue;
    }
    if (t === 'file-history-snapshot' || t === 'resend-fork-notice') {
      stats.skipped++;
      continue;
    }
    stats.unknown[t || '(no type)'] = (stats.unknown[t || '(no type)'] || 0) + 1;
  }

  // WorkBuddy interleaves message / reasoning / function_call records without
  // guaranteeing chronological order, so a tool_result can precede its call.
  // Sorting makes the stream deterministic; writers pair calls with results by
  // callId rather than by adjacency, so this is safe.
  events.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const s = makeSession({
    id: sessionId,
    source: 'workbuddy',
    title: title || deriveTitle(events),
    directory,
    timeCreated,
    timeUpdated,
  });
  s.events = events;
  s.stats = stats;
  return s;
}

function flattenOutput(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(flattenOutput).filter(Boolean).join('\n');
  if (typeof output === 'object') {
    for (const k of ['text', 'output', 'content', 'result']) {
      if (typeof output[k] === 'string') return output[k];
    }
    try {
      return JSON.stringify(output);
    } catch {
      return '';
    }
  }
  return String(output);
}

// WorkBuddy wraps the real prompt in a <system-reminder> context block, so the
// naive first-user-message title is a wall of boilerplate.
function isInjected(text) {
  const t = (text || '').trimStart();
  return t.startsWith('<system-reminder') || t.startsWith('<user_info>');
}

function deriveTitle(events) {
  const first = events.find((e) => e.kind === 'user' && e.text && !isInjected(e.text));
  if (!first) return '(untitled)';
  const one = first.text.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? one.slice(0, 60) + '…' : one;
}

/** List every WorkBuddy session file on disk. */
function listWorkBuddySessions(root = DEFAULT_ROOT) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (f.endsWith('.jsonl') && !f.includes('.file-rollback.')) {
        out.push({ file: path.join(p, f), slug: dir });
      }
    }
  }
  return out;
}

module.exports = { readWorkBuddySession, listWorkBuddySessions, isInjected, DEFAULT_ROOT, flattenOutput };
