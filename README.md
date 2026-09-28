<h1 align="center">harness-transfer</h1>

[English](README.md) | [简体中文](README.zh-CN.md)

<p align="center">
  Move AI coding-assistant sessions between <b>WorkBuddy</b>, <b>zcode</b>, and the <b>Codex / DeepSeek</b> harness — with read-back verification on every write.
</p>

<p align="center">
  <a href="#why">Why</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#the-problem">The problem</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#verification">Verification</a> •
  <a href="#commands">Commands</a> •
  <a href="#safety">Safety</a> •
  <a href="#limitations">Limitations</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license">
  <img src="https://img.shields.io/badge/node-%3E%3D22.5-5fa04e" alt="node >=22.5">
</p>

---

## Why

You have a conversation with an AI coding assistant in one tool. You want to continue it in another. There is no supported way to do that, because the three harnesses store transcripts in three completely different ways.

`harness-transfer` reads any of them, converts to a neutral intermediate form, writes it into any other, and then **reads the result back and diffs it against the source** — so you find out if something was lost instead of finding out three turns later, mid-task, when the context is already wrong.

```bash
git clone https://github.com/Nanawwa/harness-transfer.git
cd harness-transfer
node bin/harness-transfer.js --help      # no install step, no dependencies
```

---

## Quick start

```bash
# What sessions exist?
node bin/harness-transfer.js list workbuddy

# Inspect one before touching anything
node bin/harness-transfer.js inspect workbuddy 0b65e4c4-db66-4788-99cb-8de225485a14

# Dry run — prints what would be written, writes nothing
node bin/harness-transfer.js convert workbuddy zcode 0b65e4c4-db66-4788-99cb-8de225485a14

# Commit for real, then verify
node bin/harness-transfer.js convert workbuddy zcode 0b65e4c4-db66-4788-99cb-8de225485a14 --commit

# Migrate everything — all six directions supported
node bin/harness-transfer.js convert zcode codex --all --commit
```

---

## The problem

These three tools agree on nothing. Reverse-engineered from real session data:

| | Where it lives | Medium | What a "session" is |
|---|---|---|---|
| **WorkBuddy** | `~/.workbuddy/projects/<slug>/<uuid>.jsonl` | JSONL, one record per line | one `.jsonl` file |
| **zcode** | `~/.zcode/cli/db/db.sqlite` | **SQLite** — `message` + `part` tables | one `session` row |
| **Codex / DeepSeek** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL, event stream | **a group of files sharing one `session_id`** |

The incompatibilities that actually bite:

- **zcode is not JSONL at all.** A transcript is rows in a SQLite database, where one *message* is a row plus an ordered set of *parts*, and the part's `type` field is the discriminator (`text`, `reasoning`, `tool`, `file`, `step-start`, `compaction`, …).
- **Codex sessions span multiple files.** A resumed session appends to a new `rollout-*.jsonl` that keeps the same `session_id`. Read one file and you get a fragment, not the conversation.
- **Codex logs everything twice.** `response_item` records are what the model actually sees; `event_msg` records are UI duplicates. Copy both and every turn appears twice in the replayed context — wasted tokens and a confused transcript.
- **zcode folds tool output into the tool part.** There are no standalone result records; the output lives in `state.output` on the tool part itself.
- **Only zcode is a database.** Everything else is append-only files you can drop into a folder.

---

## How it works

### A neutral intermediate form

Six event kinds — the intersection of what all three formats can express, so nothing is lost in a round trip:

```
user · assistant · reasoning · tool_call · tool_result
```

N×N conversion between three formats is six paths. Going through an IR makes it three readers and three writers, and adding a fourth harness means writing one reader and one writer instead of touching everything.

```
   workbuddy ─┐                        ┌─ workbuddy
   zcode     ─┼─▶  IR  (src/ir.js)  ─▶ ─┼─ zcode
   codex     ─┘                        └─ codex
```

### Order-independent pairing

WorkBuddy's JSONL is **not guaranteed to be in chronological order** — a `function_call_result` can appear before the `function_call` it belongs to. So the zcode writer indexes every result up front, then back-fills the output when it reaches the matching call. It never patches rows in place with `UPDATE … json_set(…)`; an early version did exactly that and silently corrupted part data.

### Faithful translation rules

| Situation | Handling |
|---|---|
| Tool call that never returned | written with **no** `output` key — never a fabricated empty result |
| Tool result whose call is missing | preserved as tagged text, not silently dropped |
| `developer` / `system` messages (Codex) | dropped — injected system prompt, not conversation |
| `<system-reminder>` (WorkBuddy) | kept in the body, excluded from the title |
| `<environment_context>` (Codex) | kept in the body, excluded from the title |
| `event_msg` (Codex) | dropped — duplicates `response_item` |
| `step-*`, `timeline`, `compaction` | dropped — UI separators and runtime markers |

---

## Verification

This is the part that matters. After every write, the tool re-parses the output **using the destination format's own reader** and diffs it against the source:

- event counts per kind (user / assistant / reasoning / tool_call / tool_result)
- every text block compared individually
- total text volume drift (fails above 0.1%)
- tool calls matched to their results — orphans reported on **both** sides, so pre-existing gaps aren't mistaken for migration loss
- image reference counts

It is not decoration. During development it caught four bugs that no amount of eyeballing the output would have surfaced:

1. **`textOf()` ignored `reasoning_text`** — 226 reasoning traces silently vanished from one test session.
2. **Empty output was fabricated** for calls that never returned, turning a pending call into a phantom completed one.
3. **A failed attachment became a ghost message** — zcode stores unreadable attachments as a `file` part with `url: ''`, which read back as an empty user message.
4. **One message was split in two** — a message with both text and an image was written as two parts and read back as two messages.

---

## Commands

```
harness-transfer list <source>                     list all source sessions
harness-transfer inspect <source> <id>            show one session's composition
harness-transfer convert <source> <to> [selector] convert
```

| Selector | Meaning |
|---|---|
| `<id>` | one session by id, or a path to its `.jsonl` |
| `all` | every session found |
| `--last N` | the N most recently updated |

| Option | Effect |
|---|---|
| `--commit` | actually write (default is dry-run) |
| `--dir <path>` | override the workspace directory recorded in the target |
| `--root <path>` | override the destination root |
| `--from-root <path>` | override the source root |
| `--json` | machine-readable output (all progress goes to stderr) |
| `--strict` | treat warnings as failures |
| `--no-verify` | skip read-back verification (not recommended) |

---

## Safety

- **Dry-run by default.** Without `--commit`, not one byte is written.
- **The zcode database is backed up automatically** before any write, and the whole insert runs in a single transaction that rolls back on failure.
- **File-based targets are append-only** — existing sessions are never modified.
- **The source id is recorded** in the target's metadata (`migratedFrom` / `sourceSessionId`), so every migrated session stays traceable.
- Close zcode before migrating into it: it holds the database WAL open.

---

## Testing

```bash
npm test
```

Ten cases covering: lossless round-trips through every adapter, ULID validity, a result arriving before its call, calls without results not gaining one, the write being refused without confirmation, the verifier catching deliberate truncation, empty sessions, Chinese/emoji/quotes/backslashes/fenced code blocks, and orphan tool output surviving.

Verified against real data — all six directions, 220 migrations, zero content loss:

```
workbuddy → codex    34/34        codex → workbuddy    8/8
workbuddy → zcode    34/34        codex → zcode        8/8
zcode     → workbuddy 68/68       zcode → codex       68/68
```

---

## Extending it

Adding a fourth harness means writing one reader and one writer:

- a reader that yields an IR (see `src/adapters/workbuddy.js` — it is the simplest, ~200 lines)
- a writer that consumes an IR

If your harness shares a format with one of the three, reuse the existing adapter. Tool names are currently **not** translated between harnesses, so you may need a rename map for your target.

---

## Limitations

- **Images move by reference, not by content.** WorkBuddy stores pictures as blobs under `~/.workbuddy/blobs/`; only the `blob_id` survives. A target harness that doesn't recognise that id won't display the image. Real image transfer would need blob copying plus target-format attachment upload.
- **No binaries, no checkpoints, no todo state.** Only conversational content: messages, reasoning, and tool calls with their inputs and outputs.
- **Codex `encrypted_content` cannot be decrypted** into plaintext.
- **Tool names are not translated.** A `Bash` call stays `Bash`; a target harness expecting `shell_command` will still work for most tools, but tool-specific adapters may need a rename map.
- Session metadata that only one harness understands (permission rules, thread settings, world state) is not carried across.

---

## License

MIT © 2026 [Nanawwa](https://github.com/Nanawwa)

---

<p align="center">
  <sub>阅读中文版本：<a href="README.zh-CN.md">简体中文</a></sub>
</p>
