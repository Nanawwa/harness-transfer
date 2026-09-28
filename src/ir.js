'use strict';

// Intermediate representation for a chat transcript, normalized from any of the
// three supported session formats. Every adapter produces and consumes this, so
// adding a fourth harness means writing one reader and one writer, not N^2 pairs.

/**
 * @typedef {Object} IrSession
 * @property {string} id                 stable id in the SOURCE format
 * @property {string} source             'workbuddy' | 'zcode' | 'codex'
 * @property {string} title
 * @property {string} directory          workspace root the session ran in
 * @property {number} timeCreated        epoch ms
 * @property {number} timeUpdated
 * @property {IrEvent[]} events          ordered, deduplicated
 */

/**
 * A single conversational event. Deliberately minimal: the union of what all
 * three formats can express, so nothing is lost in a round trip.
 *
 * @typedef {Object} IrEvent
 * @property {'user'|'assistant'|'reasoning'|'tool_call'|'tool_result'} kind
 * @property {number} ts                 epoch ms
 * @property {string} [text]             text body (user/assistant/reasoning)
 * @property {string} [toolName]
 * @property {string} [callId]           links tool_call to tool_result
 * @property {string} [argsJson]         raw JSON string of the tool input
 * @property {string} [outputText]       flattened tool output
 * @property {string} [status]           'completed' | 'error' | 'running'
 * @property {string[]} [images]         image references (workbuddy image_blob_ref)
 * @property {string} [model]            model id if the source recorded one
 */

function makeSession(partial = {}) {
  return {
    id: partial.id || '',
    source: partial.source || 'unknown',
    title: partial.title || '(untitled)',
    directory: partial.directory || '',
    timeCreated: partial.timeCreated || Date.now(),
    timeUpdated: partial.timeUpdated || partial.timeCreated || Date.now(),
    events: [],
  };
}

function textOf(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(
      (p) =>
        p &&
        (p.type === 'input_text' || p.type === 'output_text' || p.type === 'reasoning_text' || p.type === 'text')
    )
    .map((p) => p.text || '')
    .join('');
}

module.exports = { makeSession, textOf };
