'use strict';

// zcode reader. Transcripts are NOT jsonl — they live in the SQLite database
// at ~/.zcode/cli/db/db.sqlite in an OpenCode-style message/part model:
//
//   session(id, project_id, directory, title, version, time_created, ...)
//   message(id, session_id, sequence, time_created, data)   data = {role, time, ...}
//   part(id, message_id, sequence, time_created, data)      data = {type, text, tool, ...}
//
// `part.data.type` is the discriminator: text | reasoning | tool | step-start |
// step-finish | file | timeline | compaction. A zcode message is the union of
// its ordered parts, so we flatten message+parts into IR events.
//
// NOTE: this opens the db read-only. zcode may be running; never write here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSession } = require('../ir');

function defaultDbPath() {
  return path.join(process.env.USERPROFILE || os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

function openDb(dbFile = defaultDbPath(), { DatabaseSync } = {}) {
  if (!fs.existsSync(dbFile)) throw new Error(`zcode db not found: ${dbFile}`);
  const Sqlite = DatabaseSync || require('node:sqlite').DatabaseSync;
  return new Sqlite(dbFile, { readOnly: true });
}

function readZcodeSession(db, sessionId) {
  const stats = { unknown: {}, skipped: 0, badLines: 0, images: 0 };
  const s = makeSession({ id: sessionId, source: 'zcode' });

  const sess = db.prepare('select * from session where id = ?').get(sessionId);
  if (!sess) throw new Error(`session not found: ${sessionId}`);
  s.title = sess.title || '(untitled)';
  s.directory = sess.directory || '';
  s.timeCreated = sess.time_created;
  s.timeUpdated = sess.time_updated;

  const msgs = db
    .prepare('select * from message where session_id = ? order by coalesce(sequence, time_created)')
    .all(sessionId);

  for (const m of msgs) {
    let md = {};
    try {
      md = JSON.parse(m.data);
    } catch {
      stats.badLines++;
      continue;
    }
    const role = md.role === 'assistant' ? 'assistant' : 'user';
    const ts = (md.time && md.time.created) || m.time_created;

    const parts = db
      .prepare('select * from part where message_id = ? order by coalesce(sequence, time_created)')
      .all(m.id);

    let emitted = false;
    {
      // A single message's text and attachment parts describe ONE message, so
      // they are collected together and emitted as a single event. Emitting a
      // separate event per part would inflate the message count on round trip.
      const msgTexts = [];
      const msgImages = [];
      const collect = (p) => {
        switch (p.type) {
          case 'text':
            if (p.text) msgTexts.push(p.text);
            break;
          case 'file':
            if (!p.url) {
              stats.skipped++;
              break;
            }
            stats.images++;
            msgImages.push(p.url);
            break;
          case 'reasoning':
            if (p.text) s.events.push({ kind: 'reasoning', ts, text: p.text });
            break;
          case 'tool': {
            const st = p.state || {};
            s.events.push({
              kind: 'tool_call',
              ts,
              callId: p.callID,
              toolName: p.tool,
              argsJson: JSON.stringify(st.input || {}),
            });
            // A tool part with no `output` key is a call that never returned
            // (session ended mid-call, or the run was aborted). Emitting a
            // result for it would invent output that never existed.
            const hasOutput = st.output !== undefined && st.output !== null && st.output !== '';
            if (hasOutput) {
              s.events.push({
                kind: 'tool_result',
                ts,
                callId: p.callID,
                toolName: p.tool,
                outputText:
                  typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? st.error ?? ''),
                status: st.status === 'error' ? 'error' : 'completed',
              });
            }
            break;
          }
          case 'step-start':
          case 'step-finish':
          case 'timeline':
          case 'compaction':
            stats.skipped++;
            break;
          default: {
            const k = p.type || '(no type)';
            stats.unknown[k] = (stats.unknown[k] || 0) + 1;
          }
        }
      };

      for (const pr of parts) {
        let pd;
        try {
          pd = JSON.parse(pr.data);
        } catch {
          stats.badLines++;
          continue;
        }
        collect(pd);
      }

      const msgText = msgTexts.join('\n');
      if (msgText || msgImages.length) {
        s.events.push({ kind: role, ts, text: msgText, images: msgImages, model: md.modelId });
        emitted = true;
      }
    }

    // A user message can legitimately have no parts (bare prompt with metadata only).
    if (!parts.length && md.text) {
      s.events.push({ kind: role, ts, text: md.text, model: md.modelId });
      emitted = true;
    }
    if (!emitted && !parts.length) stats.skipped++;
  }

  s.events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  s.stats = stats;
  return s;
}

function listZcodeSessions(db) {
  return db
    .prepare('select id, title, directory, time_created, time_updated from session order by time_updated desc')
    .all()
    .map((r) => ({ id: r.id, title: r.title, directory: r.directory, ts: r.time_updated }));
}

module.exports = { openDb, readZcodeSession, listZcodeSessions, defaultDbPath };
