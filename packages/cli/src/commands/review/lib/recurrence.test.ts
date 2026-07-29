/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The pre-scan that feeds the performance agent's accumulation lens. The
// properties that matter: the high-precision patterns hit, the obvious noise
// (function-locals, test files, counters) does not, the line numbers are
// NEW-FILE line numbers (that is what the agent opens), and the output is
// capped so the weld cannot drown its own adjudication contract.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scanAccumulationCandidates,
  planRecurrenceField,
  MAX_CANDIDATES,
} from './recurrence.js';

// A realistic multi-file unified diff. New-side line numbers are asserted
// below, so the hunk headers and context lines here are load-bearing.
const FIXTURE = [
  'diff --git a/packages/core/src/chat/session.ts b/packages/core/src/chat/session.ts',
  'index 1111111..2222222 100644',
  '--- a/packages/core/src/chat/session.ts',
  '+++ b/packages/core/src/chat/session.ts',
  '@@ -10,4 +10,8 @@ export class Session {',
  '   record(entry: Entry) {', // new line 10
  '-    stale(entry);',
  '+    this.turns.push(entry);', // new line 11
  '+    this.cache.set(entry.id, entry);', // new line 12
  '+    this.transcript += render(entry);', // new line 13
  '+    this.tokensUsed += 1;', // new line 14 — a counter, not a container
  '+    this.bus.on("tick", this.onTick);', // new line 15
  '     finish(entry);', // new line 16
  '   }', // new line 17
  'diff --git a/packages/cli/src/state.ts b/packages/cli/src/state.ts',
  '--- a/packages/cli/src/state.ts',
  '+++ b/packages/cli/src/state.ts',
  '@@ -1,2 +1,7 @@',
  " import { messagesRef } from './ref.js';", // new line 1
  '+const registry = new Map<string, Entry>();', // new line 2 — module-level
  '+export function remember(id: string, entry: Entry) {', // new line 3
  '+  registry.set(id, entry);', // new line 4
  '+  messagesRef.current.push(entry);', // new line 5
  '+}', // new line 6
  ' export {};', // new line 7
  'diff --git a/packages/cli/src/render.ts b/packages/cli/src/render.ts',
  '--- a/packages/cli/src/render.ts',
  '+++ b/packages/cli/src/render.ts',
  '@@ -3,3 +3,5 @@ export function render(items: Item[]) {',
  '   const parts: string[] = [];', // new line 3 — an INDENTED local
  '+  parts.push(header());', // new line 4 — write to that local
  '+  history.push(entries);', // new line 5 — named like long-lived state
  '   return parts.join("");', // new line 6
  ' }', // new line 7
  'diff --git a/packages/cli/src/render.test.ts b/packages/cli/src/render.test.ts',
  '--- a/packages/cli/src/render.test.ts',
  '+++ b/packages/cli/src/render.test.ts',
  '@@ -1,1 +1,2 @@',
  " describe('render', () => {});",
  '+history.push(sample);', // a hit-shaped line, but in a test file
  '',
].join('\n');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scanAccumulationCandidates — the patterns and their exclusions', () => {
  const candidates = scanAccumulationCandidates(FIXTURE);

  it('finds each long-lived write, with new-file line numbers', () => {
    expect(candidates).toEqual([
      {
        file: 'packages/core/src/chat/session.ts',
        line: 11,
        snippet: 'this.turns.push(entry);',
        receiver: 'this.turns',
        kind: 'push',
      },
      {
        file: 'packages/core/src/chat/session.ts',
        line: 12,
        snippet: 'this.cache.set(entry.id, entry);',
        receiver: 'this.cache',
        kind: 'map-set',
      },
      {
        file: 'packages/core/src/chat/session.ts',
        line: 13,
        snippet: 'this.transcript += render(entry);',
        receiver: 'this.transcript',
        kind: 'append',
      },
      {
        file: 'packages/core/src/chat/session.ts',
        line: 15,
        snippet: 'this.bus.on("tick", this.onTick);',
        receiver: 'this.bus',
        kind: 'listener',
      },
      {
        file: 'packages/cli/src/state.ts',
        line: 4,
        snippet: 'registry.set(id, entry);',
        receiver: 'registry',
        kind: 'map-set',
      },
      {
        file: 'packages/cli/src/state.ts',
        line: 5,
        snippet: 'messagesRef.current.push(entry);',
        receiver: 'messagesRef.current',
        kind: 'push',
      },
      {
        file: 'packages/cli/src/render.ts',
        line: 5,
        snippet: 'history.push(entries);',
        receiver: 'history',
        kind: 'push',
      },
    ]);
  });

  it('excludes a push to a local the hunk itself declares', () => {
    // `const parts: string[] = []` is indented — a function-local, gone when
    // the call returns. Its push is the dominant noise shape.
    expect(candidates.some((c) => c.receiver === 'parts')).toBe(false);
  });

  it('excludes a numeric counter accumulation', () => {
    // `this.tokensUsed += 1` grows a number, not a container.
    expect(candidates.some((c) => c.receiver === 'this.tokensUsed')).toBe(
      false,
    );
  });

  it('excludes test files entirely', () => {
    expect(candidates.some((c) => c.file.endsWith('.test.ts'))).toBe(false);
  });

  it('treats a column-0 declaration as module-level, not local', () => {
    // `const registry = new Map()` at column 0 IS the long-lived container the
    // scan exists to surface; only an indented declaration marks a local.
    expect(candidates.some((c) => c.receiver === 'registry')).toBe(true);
  });
});

describe('scanAccumulationCandidates — the cap', () => {
  it(`keeps the earliest ${MAX_CANDIDATES} candidates`, () => {
    const many = [
      'diff --git a/src/big.ts b/src/big.ts',
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -1,0 +1,15 @@',
      ...Array.from({ length: 15 }, (_, i) => `+    this.q${i}.push(x${i});`),
      '',
    ].join('\n');

    const capped = scanAccumulationCandidates(many);
    expect(capped).toHaveLength(MAX_CANDIDATES);
    expect(capped[0]).toMatchObject({ line: 1, receiver: 'this.q0' });
    expect(capped[MAX_CANDIDATES - 1]).toMatchObject({
      line: MAX_CANDIDATES,
      receiver: `this.q${MAX_CANDIDATES - 1}`,
    });
  });
});

describe('planRecurrenceField — the plan shape', () => {
  it('is `{}` when the scan finds nothing, so the field stays absent', () => {
    const diff = [
      'diff --git a/src/pay.ts b/src/pay.ts',
      '--- a/src/pay.ts',
      '+++ b/src/pay.ts',
      '@@ -0,0 +1,1 @@',
      '+export function pay() {}',
      '',
    ].join('\n');
    expect(planRecurrenceField(diff)).toEqual({});
  });

  it('carries the candidates when the scan finds any', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const field = planRecurrenceField(FIXTURE);
    expect(field.recurrenceCandidates).toHaveLength(7);
  });
});
