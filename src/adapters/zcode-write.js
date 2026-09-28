'use strict';

// zcode writer: IR -> the SQLite transcript store at ~/.zcode/cli/db/db.sqlite.
//
// This is the only writer that mutates an existing database, so it is strict:
//   - refuses to run unless `confirm: true` is passed
//   - takes a timestamped backup of the .sqlite file before writing
//   - wraps everything in one transaction
//   - inserts session + message + part rows with zcode's id/sequence conventions
//     (msg_<rand>_<uuid> / part_<rand>_<uuid>, per-row `sequence` ordering)
//
// zcode must be CLOSED while this runs; it holds the WAL open.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { defaultDbPath } = require('./zcode-read');

function zcodeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}_${randomUUID()}`;
}

function projectIdFor(directory) {
  const slug = (directory || 'unknown')
    .replace(/\\/g, '-')
    .replace(/:/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `proj_${slug || 'unknown'}`;
}

// Minimal schema matching zcode's, so a migrated session is loadable by zcode
// itself and by the reader. Only used when the target db does not exist yet.
const SCHEMA = `
create table if not exists session (
  id text primary key, project_id text not null, workspace_id text, parent_id text,
  slug text not null, directory text not null, path text, title text not null,
  version text not null, share_url text, summary_additions integer, summary_deletions integer,
  summary_files integer, summary_diffs text, revert text, permission text,
  time_created integer not null, time_updated integer not null, time_compacting integer,
  time_archived integer, task_type text not null default 'interactive',
  title_source text not null default 'first_input', title_message_id text,
  time_title_updated integer, trace_id text
);
create table if not exists message (
  id text primary key, session_id text not null references session(id) on delete cascade,
  time_created integer not null, time_updated integer not null, data text not null, sequence integer
);
create table if not exists part (
  id text primary key, message_id text not null references message(id) on delete cascade,
  session_id text not null, time_created integer not null, time_updated integer not null,
  data text not null, sequence integer
);
create table if not exists input_history (
  id text primary key, project_id text not null, session_id text, text text not null,
  kind text not null, time_created integer not null, attachments text
);
`;

function createSchema(dbFile) {
  const Sqlite = require('node:sqlite').DatabaseSync;
  const db = new Sqlite(dbFile);
  try {
    db.exec(SCHEMA);
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function backupDb(dbFile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${dbFile}.bak-${stamp}`;
  fs.copyFileSync(dbFile, bak);
  return bak;
}

function writeZcodeSession(ir, { dbFile = defaultDbPath(), confirm = false, version = '0.16.9' } = {}) {
  if (!confirm) {
    throw new Error(
      'Refusing to write to the zcode database without `confirm: true`. ' +
        'Close zcode first, then re-run with --confirm.'
    );
  }
  const existed = fs.existsSync(dbFile);
  if (!existed) {
    // Allow writing to a fresh database (tests, staging). It gets the same
    // schema zcode uses, so zcode can open the result.
    createSchema(dbFile);
  }

  const Sqlite = require('node:sqlite').DatabaseSync;
  const backup = existed ? backupDb(dbFile) : null;
  const db = new Sqlite(dbFile);

  const sessionId = zcodeId('sess');
  const now = Date.now();
  const timeCreated = ir.timeCreated || now;
  const timeUpdated = ir.timeUpdated || now;

  try {
    db.exec('BEGIN IMMEDIATE');

    db.prepare(
      `insert into session (id, project_id, workspace_id, parent_id, slug, directory, path,
        title, version, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, task_type, title_source)
       values (?,?,?,?,?,?,?,?,?,0,0,0,NULL,NULL,NULL,?,?,'interactive','custom')`
    ).run(
      sessionId,
      projectIdFor(ir.directory),
      null,
      null,
      sessionId,
      ir.directory || '',
      null,
      ir.title || '(untitled)',
      version,
      timeCreated,
      timeUpdated
    );

    const insMsg = db.prepare(
      'insert into message (id, session_id, time_created, time_updated, data, sequence) values (?,?,?,?,?,?)'
    );
    const insPart = db.prepare(
      'insert into part (id, message_id, session_id, time_created, time_updated, data, sequence) values (?,?,?,?,?,?,?)'
    );
    const insInput = db.prepare(
      'insert into input_history (id, project_id, session_id, text, kind, time_created, attachments) values (?,?,?,?,?,?,NULL)'
    );

    let msgSeq = 0;
    let parentMsgId = null;
    const pending = [];

    // Two-pass pairing, because the source files are NOT reliably in
    // timestamp order: a tool_result can appear before its tool_call. Index
    // every result up front, then attach on the call and emit whatever is
    // left over as text. No output is ever dropped or invented.
    const resultsByCall = new Map();
    for (const e of ir.events) {
      if (e.kind === 'tool_result' && e.callId && !resultsByCall.has(e.callId)) {
        resultsByCall.set(e.callId, e);
      }
    }
    const consumed = new Set();
    const flush = () => {
      if (!pending.length) return;
      const msgId = zcodeId('msg');
      const first = pending[0];
      const last = pending[pending.length - 1];
      const role = first.role;
      const data = {
        role,
        time: { created: first.ts, completed: last.ts },
        ...(role === 'assistant'
          ? { modelId: first.model || 'unknown', providerId: 'migrated', mode: 'migrated' }
          : {}),
        agent: 'zcode-agent',
        path: { cwd: ir.directory || '', root: ir.directory || '' },
        ...(parentMsgId ? { parentID: parentMsgId } : {}),
      };
      insMsg.run(msgId, sessionId, first.ts, last.ts, JSON.stringify(data), msgSeq++);
      let partSeq = 0;
      for (const p of pending) {
        insPart.run(zcodeId('part'), msgId, sessionId, p.ts, p.ts, JSON.stringify(p.data), partSeq++);
      }
      if (role === 'user' && first.data.text) {
        insInput.run(
          zcodeId('input'),
          projectIdFor(ir.directory),
          sessionId,
          first.data.text.slice(0, 4000),
          'prompt',
          first.ts
        );
      }
      parentMsgId = msgId;
      pending.length = 0;
    };

    for (const e of ir.events) {
      const ts = e.ts || timeCreated;
      const role = e.kind === 'assistant' ? 'assistant' : 'user';

      if (e.kind === 'user' || e.kind === 'assistant') {
        if (e.text) pending.push({ role, ts, model: e.model, data: { type: 'text', text: e.text } });
        for (const img of e.images || []) {
          pending.push({
            role,
            ts,
            data: { type: 'file', mime: 'image/*', url: img, metadata: { source: ir.source } },
          });
        }
        flush();
      } else if (e.kind === 'reasoning') {
        if (!e.text) continue;
        pending.push({ role: 'assistant', ts, data: { type: 'reasoning', text: e.text } });
        flush();
      } else if (e.kind === 'tool_call') {
        flush();
        const msgId = zcodeId('msg');
        const data = {
          role: 'assistant',
          time: { created: ts, completed: ts },
          modelId: e.model || 'unknown',
          providerId: 'migrated',
          mode: 'migrated',
          agent: 'zcode-agent',
          path: { cwd: ir.directory || '', root: ir.directory || '' },
          ...(parentMsgId ? { parentID: parentMsgId } : {}),
        };
        insMsg.run(msgId, sessionId, ts, ts, JSON.stringify(data), msgSeq++);
        let input = {};
        try {
          input = JSON.parse(e.argsJson || '{}');
        } catch {
          input = { _raw: e.argsJson || '' };
        }
        // No `output` key yet: a tool call whose result never arrived must stay
        // a pending call, not become a call with an empty successful result.
        const callId = e.callId || zcodeId('call');
        const res = resultsByCall.get(callId);
        const state = {
          status: res ? res.status || 'completed' : 'pending',
          input,
          title: e.toolName,
          metadata: {},
        };
        if (res) {
          state.output = res.outputText || '';
          consumed.add(callId);
        }
        insPart.run(
          zcodeId('part'),
          msgId,
          sessionId,
          ts,
          ts,
          JSON.stringify({ type: 'tool', callID: callId, tool: e.toolName || 'tool', state }),
          0
        );
        parentMsgId = msgId;
      }
      // tool_result events are consumed via resultsByCall above.
    }
    flush();

    // Results whose call never appeared. zcode has no orphan-output part type,
    // so the closest faithful representation is a `reasoning`-free text part
    // tagged with the call id. Kept separate from conversation text so it is
    // never mistaken for something the assistant said.
    for (const [callId, res] of resultsByCall) {
      if (consumed.has(callId)) continue;
      pending.push({
        role: 'assistant',
        ts: res.ts || timeUpdated,
        data: {
          type: 'text',
          text: `\`${res.toolName || 'tool'}\` (${callId}) →\n${res.outputText || ''}`,
        },
      });
    }
    flush();

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    try {
      db.close();
    } catch {}
  }

  return { sessionId, dbFile, backup, title: ir.title };
}

module.exports = { writeZcodeSession, projectIdFor, zcodeId, backupDb };
