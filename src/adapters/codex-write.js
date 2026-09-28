'use strict';

// Codex / DeepSeek harness writer: IR -> ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl
//
// Codex replays `response_item` records into the model context and ignores
// `event_msg`. So we write ONLY response_item + session_meta: every event we
// invent as a duplicate would be fed to the model twice, costing tokens and
// skewing the transcript.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_ROOT = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.codex',
  'sessions'
);

// Codex session ids are 26-char ULIDs (Crockford base32, time-ordered prefix).
// The prefix keeps migrated sessions sorted next to native ones by date.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(num, len) {
  let out = '';
  let n = BigInt(num);
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[Number(n % 32n)] + out;
    n = n / 32n;
  }
  return out;
}

function sessionIdFor(ir) {
  const ms = ir.timeCreated || Date.now();
  const time = encodeBase32(ms, 10);
  const rand = encodeBase32(BigInt('0x' + randomUUID().replace(/-/g, '')) % (32n ** 16n), 16);
  return time + rand;
}

function writeCodexSession(ir, { root = DEFAULT_ROOT, dir = null, cliVersion = '0.147.0-alpha.6.6' } = {}) {
  const sessionId = sessionIdFor(ir);
  const created = new Date(ir.timeCreated || Date.now());
  const y = created.getFullYear();
  const m = String(created.getMonth() + 1).padStart(2, '0');
  const d = String(created.getDate()).padStart(2, '0');
  const outDir = path.join(root, String(y), m, d);
  fs.mkdirSync(outDir, { recursive: true });

  // Local wall-clock, matching Codex's own naming: rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl
  const p2 = (x) => String(x).padStart(2, '0');
  const stampName = `${y}-${m}-${d}T${p2(created.getHours())}-${p2(created.getMinutes())}-${p2(created.getSeconds())}`;
  const file = path.join(outDir, `rollout-${stampName}-${sessionId}.jsonl`);

  const lines = [];
  const push = (o) => lines.push(JSON.stringify({ timestamp: o.__ts, type: o.type, payload: o.payload }));
  const stamp = (ts) => new Date(ts || ir.timeCreated || Date.now()).toISOString();

  push({
    __ts: stamp(ir.timeCreated),
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: sessionId,
      timestamp: stamp(ir.timeCreated),
      cwd: dir || ir.directory || '',
      originator: 'Codex CLI',
      cli_version: cliVersion,
      source: 'vscode',
      thread_source: 'user',
      model_provider: 'custom',
      instructions: null,
      migrated_from: ir.source,
      source_session_id: ir.id,
    },
  });

  for (const e of ir.events) {
    const ts = stamp(e.ts);
    if (e.kind === 'user' || e.kind === 'assistant') {
      if (!e.text && !(e.images && e.images.length)) continue;
      const content = [];
      if (e.text) content.push({ type: e.kind === 'user' ? 'input_text' : 'output_text', text: e.text });
      for (const img of e.images || []) content.push({ type: 'input_image', image_url: img });
      push({
        __ts: ts,
        type: 'response_item',
        payload: { type: 'message', id: `msg_${randomUUID()}`, role: e.kind, content },
      });
    } else if (e.kind === 'reasoning') {
      if (!e.text) continue;
      push({
        __ts: ts,
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: `rs_${randomUUID()}`,
          summary: [],
          content: [{ type: 'reasoning_text', text: e.text }],
          encrypted_content: null,
        },
      });
    } else if (e.kind === 'tool_call') {
      push({
        __ts: ts,
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: `fc_${randomUUID()}`,
          name: e.toolName || 'shell_command',
          arguments: e.argsJson || '{}',
          call_id: e.callId || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        },
      });
    } else if (e.kind === 'tool_result') {
      push({
        __ts: ts,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          id: `fco_${randomUUID()}`,
          call_id: e.callId || '',
          output: e.outputText || '',
        },
      });
    }
  }

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { file, sessionId, records: lines.length };
}

module.exports = { writeCodexSession, DEFAULT_ROOT };
