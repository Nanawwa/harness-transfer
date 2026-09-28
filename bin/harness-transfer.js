#!/usr/bin/env node
'use strict';

// harness-transfer — move chat sessions between WorkBuddy, zcode, and the
// Codex/DeepSeek harness.
//
// Design rules:
//   1. Dry-run by default. Nothing is written without --commit.
//   2. Every migration is verified by reading the destination back and
//      diffing it against the source. A write that can't be verified is
//      reported as a failure, not a success.

const path = require('path');
const fs = require('fs');
const os = require('os');

const wb = require('../src/adapters/workbuddy');
const wbWrite = require('../src/adapters/workbuddy-write');
const cx = require('../src/adapters/codex');
const cxWrite = require('../src/adapters/codex-write');
const zr = require('../src/adapters/zcode-read');
const zw = require('../src/adapters/zcode-write');
const { compare, summary } = require('../src/verify');

const TARGETS = ['workbuddy', 'zcode', 'codex'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

function usage() {
  return `
harness-transfer — session migration between WorkBuddy, zcode and Codex/DeepSeek

USAGE
  harness-transfer list <source>                        list available sessions
  harness-transfer inspect <source> <id>               show a session's shape
  harness-transfer convert <source> <to> [selector]    convert (dry-run unless --commit)

SOURCES / TARGETS
  workbuddy   ~/.workbuddy/projects/<slug>/<id>.jsonl
  zcode       ~/.zcode/cli/db/db.sqlite
  codex       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

SELECTORS (for convert)
  <id>            one session by id or by path to its .jsonl file
  --all           every session found
  --last N         the N most recently updated
  --limit N        alias for --last N

OPTIONS
  --commit         actually write (default is dry-run)
  --dir <path>     override the workspace directory recorded in the target
  --root <path>    override the destination root directory
  --from-root <path>  override the SOURCE root (default: the live harness dirs)
  --no-verify      skip the read-back verification (not recommended)
  --strict         treat warnings as failures
  --json           machine-readable output
  --help

NOTES
  * Writing to zcode mutates its live SQLite database: close zcode first.
    A timestamped .bak copy is made automatically.
  * Codex replays only 'response_item' records; the tool deliberately does not
    emit duplicate 'event_msg' records, which would double the context.
`.trim();
}

// ---------------------------------------------------------------- source load

function listSource(source, opts) {
  switch (source) {
    case 'workbuddy': {
      const root = opts.fromRoot || wb.DEFAULT_ROOT;
      const items = wb.listWorkBuddySessions(root);
      const rows = items.map((i) => {
        const s = wb.readWorkBuddySession(i.file);
        return { id: s.id, file: i.file, ...summary(s) };
      });
      return rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
    case 'codex': {
      const root = opts.fromRoot || cx.DEFAULT_ROOT;
      const groups = cx.groupCodexSessionsById(root);
      const rows = [];
      for (const [id, files] of groups) {
        const s = cx.readCodexSessionFiles(files);
        rows.push({ id, files: files.map((f) => f.file), ...summary(s) });
      }
      return rows.sort((a, b) => (b.timeUpdated || 0) - (a.timeUpdated || 0));
    }
    case 'zcode': {
      const db = zr.openDb(opts.fromRoot || zr.defaultDbPath());
      try {
        return zr.listZcodeSessions(db);
      } finally {
        try { db.close(); } catch {}
      }
    }
    default:
      throw new Error(`unknown source: ${source} (expected one of ${TARGETS.join(', ')})`);
  }
}

function loadOne(source, idOrPath, opts) {
  if (source === 'zcode') {
    const db = zr.openDb(opts.fromRoot || zr.defaultDbPath());
    try {
      return { ir: zr.readZcodeSession(db, idOrPath), file: null, db };
    } catch (e) {
      try { db.close(); } catch {}
      throw e;
    }
  }
  let file = idOrPath;
  if (source === 'codex') {
    const root = opts.fromRoot || cx.DEFAULT_ROOT;
    const groups = cx.groupCodexSessionsById(root);
    if (groups.has(idOrPath)) return { ir: cx.readCodexSessionFiles(groups.get(idOrPath)), file: null, db: null };
  }
  if (!fs.existsSync(file)) {
    const root = opts.fromRoot || (source === 'workbuddy' ? wb.DEFAULT_ROOT : cx.DEFAULT_ROOT);
    const all = source === 'workbuddy' ? wb.listWorkBuddySessions(root) : cx.listCodexSessions(root);
    const hit = all.find((i) => path.basename(i.file).startsWith(idOrPath) || i.file.includes(idOrPath));
    if (!hit) throw new Error(`no session matched "${idOrPath}" under ${root}`);
    file = hit.file;
  }
  const ir =
    source === 'workbuddy'
      ? wb.readWorkBuddySession(file)
      : cx.readCodexSessionFiles([{ file }]);
  return { ir, file, db: null };
}

function selectSessions(source, selector, opts) {
  if (selector && selector !== true && fs.existsSync(String(selector))) {
    return [loadOne(source, String(selector), opts)];
  }
  if (typeof selector === 'string' && selector !== 'all') {
    return [loadOne(source, selector, opts)];
  }
  let rows = listSource(source, opts);
  if (opts.all || selector === 'all') return rows.map((r) => loadOne(source, r.id, opts));
  const n = Number(opts.last || opts.limit || 0);
  if (n > 0) return rows.slice(0, n).map((r) => loadOne(source, r.id, opts));
  return rows.map((r) => loadOne(source, r.id, opts));
}

// ------------------------------------------------------------------ convert

function writeTarget(dest, ir, opts) {
  switch (dest) {
    case 'workbuddy':
      return wbWrite.writeWorkBuddySession(ir, { root: opts.outRoot, dir: opts.dir || null });
    case 'codex':
      return cxWrite.writeCodexSession(ir, { root: opts.outRoot, dir: opts.dir || null });
    case 'zcode':
      return zw.writeZcodeSession(ir, { dbFile: opts.outRoot || undefined, confirm: !!opts.commit });
    default:
      throw new Error(`unknown target: ${dest} (expected one of ${TARGETS.join(', ')})`);
  }
}

function readBack(dest, result, opts) {
  switch (dest) {
    case 'workbuddy':
      return wb.readWorkBuddySession(result.file);
    case 'codex':
      return cx.readCodexSession(result.file);
    case 'zcode': {
      const db = zr.openDb(opts.outRoot || zr.defaultDbPath());
      try {
        return zr.readZcodeSession(db, result.sessionId);
      } finally {
        try { db.close(); } catch {}
      }
    }
    default:
      return null;
  }
}

function convert(source, dest, selector, opts) {
  if (source === dest) throw new Error('source and target are the same');
  const loaded = selectSessions(source, selector, opts);
  if (!loaded.length) {
    console.log(`No ${source} sessions found.`);
    return [];
  }
  if (dest === 'zcode' && opts.commit) {
    // stderr, so --json output on stdout stays machine-readable
    console.error('! zcode target: its SQLite DB is written directly. Make sure zcode is CLOSED.');
  }

  const results = [];
  for (const { ir, file, db } of loaded) {
    const rec = { source: source, dest: dest, sourceId: ir.id, file, ok: false, issues: [] };
    try {
      if (opts.json) {
        process.stderr.write(`converting ${ir.id} …\n`);
      } else {
        console.log(`\n=== ${ir.id} ===`);
        console.log(`  ${summary(ir).title}`);
      }

      if (opts.commit) {
        const wopts = { ...opts, outRoot: opts.root };
        const out = writeTarget(dest, ir, wopts);
        rec.output = out;
        if (!opts['no-verify']) {
          // zcode is verified by reading the rows back out of the destination
          // database, exactly like the file-based targets.
          const back = readBack(dest, out, wopts);
          rec.report = compare(ir, back);
          rec.ok = rec.report.ok && !opts.strict;
          rec.issues = rec.report.issues;
        }
        if (!opts.json) {
          if (out.file) console.log(`  → wrote ${out.file}`);
          if (out.sessionId) console.log(`  → session id ${out.sessionId}`);
          if (out.backup) console.log(`  → db backup ${out.backup}`);
          if (rec.report) {
            const errs = (rec.report.issues || []).filter((i) => i.level === 'error');
            const warns = (rec.report.issues || []).filter((i) => i.level === 'warn');
            console.log(`  verification: ${errs.length ? 'FAIL' : 'OK'} (${errs.length} errors, ${warns.length} warnings)`);
            for (const i of rec.report.issues || []) console.log(`    [${i.level}] ${i.code}: ${i.detail}`);
          }
        }
      } else {
        const dest2 = dest;
        const would = estimate(dest2, ir);
        rec.preview = would;
        rec.ok = true;
        if (!opts.json) {
          console.log(`  would write ~${would.records} records (${would.user}u/${would.assistant}a/${would.reasoning}r/${would.tool_calls} tool calls)`);
        }
      }
    } catch (err) {
      rec.error = err.message;
      rec.ok = false;
      if (!opts.json) console.log(`  ERROR: ${err.message}`);
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
    results.push(rec);
  }
  return results;
}

function estimate(dest, ir) {
  return {
    records: ir.events.length + 2,
    user: ir.events.filter((e) => e.kind === 'user').length,
    assistant: ir.events.filter((e) => e.kind === 'assistant').length,
    reasoning: ir.events.filter((e) => e.kind === 'reasoning').length,
    tool_calls: ir.events.filter((e) => e.kind === 'tool_call').length,
  };
}

// --------------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];

  if (!cmd || opts.help) {
    console.log(usage());
    return;
  }

  try {
    if (cmd === 'list') {
      const source = opts._[1];
      const rows = listSource(source, opts);
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.log(`${rows.length} ${source} session(s):\n`);
        for (const r of rows) {
          console.log(`  ${(r.id || '').slice(0, 40).padEnd(42)} ${String(r.events ?? '').padStart(5)} ev  ${(r.title || '').slice(0, 50)}`);
        }
      }
      return;
    }

    if (cmd === 'inspect') {
      const source = opts._[1];
      const { ir } = loadOne(source, opts._[2], opts);
      console.log(JSON.stringify({ ...summary(ir), directory: ir.directory, stats: ir.stats }, null, 2));
      return;
    }

    if (cmd === 'convert') {
      const source = opts._[1];
      const dest = opts._[2];
      const selector = opts._[3];
      const results = convert(source, dest, selector, opts);
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        const ok = results.filter((r) => r.ok).length;
        console.log(`\n${ok}/${results.length} session(s) ${opts.commit ? 'migrated' : 'would migrate'}.`);
        if (opts.commit && dest === 'zcode') console.log('Restart zcode to see the imported sessions.');
      }
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      return;
    }

    console.error(`unknown command: ${cmd}\n`);
    console.log(usage());
    process.exitCode = 1;
  } catch (err) {
    console.error(`error: ${err.message}`);
    if (opts.debug) console.error(err.stack);
    process.exitCode = 1;
  }
}

main();
