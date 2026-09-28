'use strict';

// WorkBuddy writer: IR -> .workbuddy/projects/<slug>/<sessionId>.jsonl
//
// Emits the record shapes WorkBuddy actually reads back:
//   session-meta, message (user/assistant), reasoning, function_call,
//   function_call_result, ai-title
//
// A new UUIDv7-style time-ordered id is generated per record; the original
// source id is preserved in `meta` so a migrated session stays traceable and
// re-migration is idempotent.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_ROOT = path.join(process.env.USERPROFILE || process.env.HOME, '.workbuddy', 'projects');

function slugify(dir, timeCreated) {
  const d = new Date(timeCreated || Date.now());
  const p = (dir || 'unknown').replace(/\\/g, '-').replace(/:/g, '-').replace(/[^\w-]+/g, '-');
  const pad = (n) => String(n).padStart(2, '0');
  return `${p}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(
    d.getMinutes()
  )}-${pad(d.getSeconds())}`;
}

function writeWorkBuddySession(ir, { root = DEFAULT_ROOT, dir = null } = {}) {
  const sessionId = randomUUID();
  const slug = slugify(dir || ir.directory, ir.timeCreated);
  const outDir = path.join(root, slug);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${sessionId}.jsonl`);

  const lines = [];
  const push = (o) => lines.push(JSON.stringify(o));

  push({
    type: 'session-meta',
    id: randomUUID(),
    sessionId,
    timestamp: ir.timeCreated || Date.now(),
    meta: { 'codebuddy.ai/hostKind': 'unopted', migratedFrom: ir.source, sourceSessionId: ir.id },
  });

  const cwd = ir.directory || '';
  let lastId = null;
  const callNames = new Map();

  for (const e of ir.events) {
    if (e.kind === 'user' || e.kind === 'assistant') {
      if (!e.text && !(e.images && e.images.length)) continue;
      const content = [];
      if (e.text) content.push({ type: e.kind === 'user' ? 'input_text' : 'output_text', text: e.text });
      for (const img of e.images || []) content.push({ type: 'image_blob_ref', blobId: img });
      const rec = {
        id: randomUUID(),
        parentId: lastId,
        timestamp: e.ts || Date.now(),
        type: 'message',
        role: e.kind,
        content,
        sessionId,
        cwd,
      };
      if (e.model) rec.providerData = { model: e.model };
      push(rec);
      lastId = rec.id;
    } else if (e.kind === 'reasoning') {
      if (!e.text) continue;
      const rec = {
        id: randomUUID(),
        parentId: lastId,
        timestamp: e.ts || Date.now(),
        type: 'reasoning',
        content: [],
        rawContent: [{ type: 'reasoning_text', text: e.text }],
        sessionId,
        cwd,
      };
      push(rec);
      lastId = rec.id;
    } else if (e.kind === 'tool_call') {
      const callId = e.callId || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      callNames.set(callId, e.toolName);
      const rec = {
        id: randomUUID(),
        parentId: lastId,
        timestamp: e.ts || Date.now(),
        type: 'function_call',
        callId,
        name: e.toolName || 'tool',
        arguments: e.argsJson || '{}',
        sessionId,
        cwd,
      };
      push(rec);
      lastId = rec.id;
    } else if (e.kind === 'tool_result') {
      const out = e.outputText || '';
      push({
        id: randomUUID(),
        parentId: lastId,
        timestamp: e.ts || Date.now(),
        type: 'function_call_result',
        name: callNames.get(e.callId) || 'tool',
        callId: e.callId,
        status: e.status || 'completed',
        output: [{ type: 'input_text', text: out }],
        sessionId,
        cwd,
      });
      lastId = null; // results are leaves; next message starts a new branch
    }
  }

  push({
    type: 'ai-title',
    id: randomUUID(),
    timestamp: ir.timeUpdated || Date.now(),
    aiTitle: ir.title,
    sessionId,
    cwd,
  });

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { file, sessionId, records: lines.length };
}

module.exports = { writeWorkBuddySession, DEFAULT_ROOT, slugify };
