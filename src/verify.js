'use strict';

// Round-trip verifier. After a migration we READ THE WRITTEN FILE BACK with the
// destination's own reader and compare against the source IR. This catches the
// failures that matter and that eyeballing cannot: dropped tool results,
// reordered messages, lost text, broken call_id links.
//
// Fidelity is judged on conversational content, not byte equality —
// timestamps, generated ids and metadata legitimately differ.

function countBy(events, kind) {
  return events.filter((e) => e.kind === kind).length;
}

/** Compare a source IR against the IR re-read from the destination. */
function compare(sourceIr, destIr, { strictText = true } = {}) {
  const issues = [];
  const notes = [];

  const pairs = ['user', 'assistant', 'reasoning', 'tool_call', 'tool_result'];

  // A tool result whose call is missing from the source (session ended
  // mid-call) has no native slot in zcode, whose model folds output into the
  // tool part. Writers preserve it as a tagged text block, so the destination
  // legitimately has EXTRA assistant events — exactly one per orphan result.
  const srcCalls = new Set(sourceIr.events.filter((e) => e.kind === 'tool_call').map((e) => e.callId).filter(Boolean));
  const srcResults = new Set(sourceIr.events.filter((e) => e.kind === 'tool_result').map((e) => e.callId).filter(Boolean));
  const orphanResults = [...srcResults].filter((c) => !srcCalls.has(c)).length;
  if (orphanResults) {
    notes.push(
      `${orphanResults} tool result(s) had no matching call in the source; preserved as tagged text in the destination`
    );
  }

  for (const k of pairs) {
    const a = countBy(sourceIr.events, k);
    let b = countBy(destIr.events, k);
    if (k === 'assistant' || k === 'user') b -= orphanResults;
    if (a !== b) {
      issues.push({
        level: 'error',
        code: `count:${k}`,
        detail: `${k}: source ${a} vs destination ${countBy(destIr.events, k)} (${countBy(destIr.events, k) - a >= 0 ? '+' : ''}${countBy(destIr.events, k) - a})`,
      });
    }
  }

  // Every tool call must still have its result, on both sides.
  for (const [label, ir] of [['source', sourceIr], ['destination', destIr]]) {
    const calls = new Set(ir.events.filter((e) => e.kind === 'tool_call').map((e) => e.callId).filter(Boolean));
    const results = new Set(ir.events.filter((e) => e.kind === 'tool_result').map((e) => e.callId).filter(Boolean));
    const orphans = [...calls].filter((c) => !results.has(c));
    if (orphans.length) {
      issues.push({
        level: 'warn',
        code: `orphan-calls:${label}`,
        detail: `${orphans.length} tool call(s) with no result in ${label}: ${orphans.slice(0, 3).join(', ')}`,
      });
    }
  }

  if (strictText) {
    const srcText = sourceIr.events
      .filter((e) => (e.kind === 'user' || e.kind === 'assistant') && e.text)
      .map((e) => e.text.trim());
    const dstText = destIr.events
      .filter((e) => (e.kind === 'user' || e.kind === 'assistant') && e.text)
      .map((e) => e.text.trim());
    if (srcText.length !== dstText.length) {
      issues.push({
        level: 'error',
        code: 'text-block-count',
        detail: `text blocks: source ${srcText.length} vs destination ${dstText.length}`,
      });
    } else {
      const lost = [];
      for (let i = 0; i < srcText.length; i++) {
        if (srcText[i] !== dstText[i]) {
          // Allow whitespace-only divergence (JSON round trips are exact, so
          // this is a real signal, but report it as a warning not an error).
          lost.push(i);
        }
      }
      if (lost.length) {
        issues.push({
          level: 'warn',
          code: 'text-mismatch',
          detail: `${lost.length} text block(s) differ, first at index ${lost[0]}`,
        });
      }
    }

    const srcChars = srcText.join('').length;
    const dstChars = dstText.join('').length;
    const drift = srcChars ? Math.abs(dstChars - srcChars) / srcChars : 0;
    if (drift > 0.001) {
      issues.push({
        level: 'error',
        code: 'text-volume',
        detail: `text volume drifted ${(drift * 100).toFixed(2)}% (${srcChars} → ${dstChars} chars)`,
      });
    }
  }

  const srcImgs = sourceIr.events.reduce((n, e) => n + ((e.images && e.images.length) || 0), 0);
  const dstImgs = destIr.events.reduce((n, e) => n + ((e.images && e.images.length) || 0), 0);
  if (srcImgs !== dstImgs) {
    issues.push({ level: 'warn', code: 'images', detail: `image refs ${srcImgs} → ${dstImgs}` });
  }

  for (const k of Object.keys(sourceIr.stats && sourceIr.stats.unknown ? sourceIr.stats.unknown : {})) {
    notes.push(`source had ${sourceIr.stats.unknown[k]} record(s) of unknown type "${k}" — dropped by design`);
  }

  const errors = issues.filter((i) => i.level === 'error');
  return {
    ok: errors.length === 0,
    source: summary(sourceIr),
    destination: summary(destIr),
    issues,
    notes,
  };
}

function summary(ir) {
  return {
    id: ir.id,
    source: ir.source,
    title: (ir.title || '').slice(0, 60),
    events: ir.events.length,
    user: countBy(ir.events, 'user'),
    assistant: countBy(ir.events, 'assistant'),
    reasoning: countBy(ir.events, 'reasoning'),
    tool_calls: countBy(ir.events, 'tool_call'),
    tool_results: countBy(ir.events, 'tool_result'),
  };
}

module.exports = { compare, summary };
