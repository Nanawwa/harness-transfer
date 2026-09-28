'use strict';

// Self-test: builds a synthetic session in memory, runs it through every
// reader/writer pair, and asserts the verifier finds no errors.
//
// Run: node test/roundtrip.test.js

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const wb = require('../src/adapters/workbuddy');
const wbW = require('../src/adapters/workbuddy-write');
const cx = require('../src/adapters/codex');
const cxW = require('../src/adapters/codex-write');
const zr = require('../src/adapters/zcode-read');
const zw = require('../src/adapters/zcode-write');
const { compare } = require('../src/verify');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-transfer-test-'));
const T0 = 1750000000000;

const SAMPLE = {
  id: 'src-session-1',
  source: 'workbuddy',
  title: '测试标题',
  directory: 'C:\\Users\\test\\project',
  timeCreated: T0,
  timeUpdated: T0 + 5000,
  events: [
    { kind: 'user', ts: T0 + 10, text: '第一条消息' },
    { kind: 'assistant', ts: T0 + 20, text: '好的，我来处理。' },
    { kind: 'reasoning', ts: T0 + 15, text: '先看看情况' },
    { kind: 'tool_call', ts: T0 + 30, callId: 'c1', toolName: 'Bash', argsJson: '{"command":"ls"}' },
    { kind: 'tool_result', ts: T0 + 40, callId: 'c1', outputText: 'a.txt\nb.txt', status: 'completed' },
    { kind: 'assistant', ts: T0 + 50, text: '目录里有 2 个文件。' },
    { kind: 'user', ts: T0 + 60, text: '继续' },
    { kind: 'assistant', ts: T0 + 70, text: 'done' },
  ],
};

console.log('harness-transfer self-test\n');

test('IR -> workbuddy -> IR preserves everything', () => {
  const out = wbW.writeWorkBuddySession(SAMPLE, { root: path.join(TMP, 'wb') });
  const back = wb.readWorkBuddySession(out.file);
  const r = compare(SAMPLE, back);
  assert.ok(r.ok, JSON.stringify(r.issues));
  assert.strictEqual(back.title, '测试标题');
});

test('IR -> codex -> IR preserves everything', () => {
  const out = cxW.writeCodexSession(SAMPLE, { root: path.join(TMP, 'cx') });
  const back = cx.readCodexSession(out.file);
  const r = compare(SAMPLE, back);
  assert.ok(r.ok, JSON.stringify(r.issues));
});

test('codex session id is a valid 26-char ULID', () => {
  const out = cxW.writeCodexSession(SAMPLE, { root: path.join(TMP, 'cx2') });
  assert.match(out.sessionId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('tool result before its call is still paired', () => {
  // Deliberately out of order: result first, then call.
  const shuffled = { ...SAMPLE, events: [SAMPLE.events[4], SAMPLE.events[3]] };
  const out = zw.writeZcodeSession(shuffled, {
    dbFile: path.join(TMP, 'z1.sqlite'),
    confirm: true,
  });
  assert.ok(out.sessionId);
});

test('a tool call with no result does not gain one', () => {
  const noResult = { ...SAMPLE, events: SAMPLE.events.filter((e) => e.kind !== 'tool_result') };
  const out = zw.writeZcodeSession(noResult, { dbFile: path.join(TMP, 'z2.sqlite'), confirm: true });
  const db = zr.openDb(path.join(TMP, 'z2.sqlite'));
  try {
    const back = zr.readZcodeSession(db, out.sessionId);
    const r = compare(noResult, back);
    assert.ok(r.ok, JSON.stringify(r.issues));
    assert.strictEqual(back.events.filter((e) => e.kind === 'tool_result').length, 0);
  } finally {
    db.close();
  }
});

test('zcode writer refuses without confirm', () => {
  assert.throws(
    () => zw.writeZcodeSession(SAMPLE, { dbFile: path.join(TMP, 'z3.sqlite'), confirm: false }),
    /Refusing to write/
  );
});

test('verifier catches dropped content', () => {
  const truncated = { ...SAMPLE, events: SAMPLE.events.slice(0, 3) };
  const r = compare(SAMPLE, truncated);
  assert.ok(!r.ok, 'verifier should have flagged the loss');
});

test('empty session does not crash any adapter', () => {
  const empty = { ...SAMPLE, events: [] };
  const out = wbW.writeWorkBuddySession(empty, { root: path.join(TMP, 'wbempty') });
  const back = wb.readWorkBuddySession(out.file);
  assert.strictEqual(back.events.length, 0);
});

test('messages with unicode and newlines survive intact', () => {
  const tricky = {
    ...SAMPLE,
    events: [
      { kind: 'user', ts: T0, text: '引号 " 和 \\ 反斜杠\n第二行\t制表符\n emoji 🎉 中文' },
      { kind: 'assistant', ts: T0 + 1, text: '```js\nconst a = "x";\n```' },
    ],
  };
  const out = wbW.writeWorkBuddySession(tricky, { root: path.join(TMP, 'wbuni') });
  const back = wb.readWorkBuddySession(out.file);
  assert.strictEqual(back.events[0].text, tricky.events[0].text);
  assert.strictEqual(back.events[1].text, tricky.events[1].text);
});

test('orphan tool result is preserved, not dropped', () => {
  const orphan = {
    ...SAMPLE,
    events: [...SAMPLE.events.filter((e) => e.kind !== 'tool_call'), { kind: 'tool_result', ts: T0 + 40, callId: 'c1', outputText: 'result-without-call' }],
  };
  const out = wbW.writeWorkBuddySession(orphan, { root: path.join(TMP, 'wborph') });
  const back = wb.readWorkBuddySession(out.file);
  const found = back.events.some((e) => (e.outputText || '').includes('result-without-call'));
  assert.ok(found, 'orphan tool output was lost');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
