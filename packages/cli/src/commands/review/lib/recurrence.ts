/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Deterministic pre-scan for recurring writes into long-lived containers.
//
// A live dogfood missed a real blocker: the diff added a per-tool-turn append of
// a bounded string into the outgoing request, and one hop away that request was
// pushed verbatim into conversation history nothing reclaims — unbounded,
// quadratic-in-turns accumulation. Every dimension agent read the diff
// hunk-locally; no lens asked "this write recurs — what bounds the CONTAINER it
// flows into, and who reclaims old entries?" Same medicine as script-lint:
// enumerate deterministically here, and REQUIRE the performance agent to
// adjudicate each site (see the weld in agent-prompt.ts). False negatives are
// acceptable; noise is not — the patterns are high-precision and the output is
// capped.

import { classifyPath } from './diff-plan.js';
import { writeStderrLine } from '../../../utils/stdioHelpers.js';

export type AccumulationKind = 'push' | 'map-set' | 'append' | 'listener';

export interface AccumulationCandidate {
  /** New-side path of the file holding the write. */
  file: string;
  /** New-file line number of the added line. */
  line: number;
  /** The trimmed added line (truncated for display). */
  snippet: string;
  /** The receiver expression being written into. */
  receiver: string;
  kind: AccumulationKind;
}

/**
 * Hard cap on candidates. The list is welded into one agent's prompt; a diff
 * that trips the patterns fifty times would drown the adjudication contract in
 * its own enumeration. Earliest sites win — only production source is scanned,
 * so the cap never spends a slot on a test file.
 */
export const MAX_CANDIDATES = 12;

const SNIPPET_MAX_CHARS = 200;

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A property-access chain: `this.history`, `messagesRef.current`, `queue`. */
const CHAIN = String.raw`(?:this|[A-Za-z_$][\w$]*)(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*`;
const NOT_MID_CHAIN = String.raw`(?<![\w$.])`;

const PUSH_RE = new RegExp(`${NOT_MID_CHAIN}(${CHAIN})\\.(?:push|unshift)\\(`);
const SET_RE = new RegExp(`${NOT_MID_CHAIN}(${CHAIN})\\.set\\(`);
const APPEND_RE = new RegExp(`${NOT_MID_CHAIN}(${CHAIN})\\.append\\w*\\(`);
const APPEND_FILE_RE = /\bappendFileSync\s*\(/;
/** Registrations that pair with a remover — only on `this.*` receivers. */
const LISTENER_RE = new RegExp(
  `${NOT_MID_CHAIN}(this(?:\\.[A-Za-z_$][\\w$]*)+)\\.(?:on|once|add(?:Event)?Listener)\\(`,
);
const PLUS_EQ_RE = new RegExp(`^\\s*(${CHAIN})\\s*\\+=\\s*(.+)$`);

/**
 * An INDENTED `const`/`let`/`var` declaration — a function-local. A column-0
 * declaration is module-level state and deliberately does not match: a
 * module-level `const history = []` added by the same hunk is exactly the
 * long-lived container this scan exists to surface.
 */
const LOCAL_DECL_RE = /^\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** The chain's root identifier: `this.a.b` → `this`, `queue?.items` → `queue`. */
function rootOf(receiver: string): string {
  return receiver.replace(/\?/g, '').split('.', 1)[0];
}

/** A receiver `.push`/`.unshift` treats as long-lived unless proven local. */
function pushEligible(receiver: string, locals: Set<string>): boolean {
  if (rootOf(receiver) === 'this') return true;
  if (receiver.endsWith('.current')) return true;
  if (/history/i.test(receiver)) return true;
  // A bare or dotted receiver whose root the diff shows as a function-local is
  // an obvious local; anything else could be module-level or an outer-scope
  // field the hunk does not show — when unsure, INCLUDE (the agent adjudicates).
  return !locals.has(rootOf(receiver));
}

/**
 * The narrower gate for `.set(` / `.append*(` / `+=`: `this.*`, or a bare
 * identifier not visibly local. Dotted non-`this` receivers (`headers.set`,
 * `url.searchParams.append`) are the dominant noise source for these patterns
 * and are excluded — a false negative is fine, noise is the enemy.
 */
function stateEligible(receiver: string, locals: Set<string>): boolean {
  if (rootOf(receiver) === 'this') return true;
  return !receiver.includes('.') && !locals.has(receiver);
}

/** RHS shapes that cannot grow a container: numeric counters. */
function isNumericAccumulation(rhs: string): boolean {
  return /^[+-]?\d+(?:\.\d+)?\s*;?\s*$/.test(rhs.trim());
}

function candidateFor(
  content: string,
  locals: Set<string>,
): { receiver: string; kind: AccumulationKind } | null {
  const push = PUSH_RE.exec(content);
  if (push && pushEligible(push[1], locals)) {
    return { receiver: push[1], kind: 'push' };
  }
  const set = SET_RE.exec(content);
  if (set && stateEligible(set[1], locals)) {
    return { receiver: set[1], kind: 'map-set' };
  }
  if (APPEND_FILE_RE.test(content)) {
    return { receiver: 'appendFileSync', kind: 'append' };
  }
  const append = APPEND_RE.exec(content);
  if (append && stateEligible(append[1], locals)) {
    return { receiver: append[1], kind: 'append' };
  }
  const listener = LISTENER_RE.exec(content);
  if (listener) {
    return { receiver: listener[1], kind: 'listener' };
  }
  const plusEq = PLUS_EQ_RE.exec(content);
  if (
    plusEq &&
    stateEligible(plusEq[1], locals) &&
    !isNumericAccumulation(plusEq[2])
  ) {
    return { receiver: plusEq[1], kind: 'append' };
  }
  return null;
}

/**
 * Scan a unified diff's ADDED lines in production source files for writes into
 * long-lived containers. Test, docs and generated files are excluded with the
 * same classification the diff plan uses, so the review judges these sites by
 * the same map it chunks by.
 */
export function scanAccumulationCandidates(
  diffText: string,
): AccumulationCandidate[] {
  const lines = diffText.split('\n');
  const out: AccumulationCandidate[] = [];

  let path = '';
  let isSource = false;
  let inHunk = false;
  /** New-side line number of the next body line of the current hunk. */
  let newCursor = 0;
  /**
   * Names the diff shows declared as function-locals in this FILE's hunks.
   * Declaration precedes use, so a forward walk has seen the `const parts = []`
   * by the time it reaches `parts.push(...)`.
   */
  let locals = new Set<string>();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      path = '';
      isSource = false;
      inHunk = false;
      locals = new Set<string>();
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') {
        path = p.startsWith('b/') ? p.slice(2) : p;
        isSource = classifyPath(path) === 'source';
      }
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      inHunk = true;
      newCursor = Number(hunk[1]);
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      const content = line.slice(1);
      const decl = LOCAL_DECL_RE.exec(content);
      if (decl) locals.add(decl[1]);
      if (isSource && path && out.length < MAX_CANDIDATES) {
        const hit = candidateFor(content, locals);
        if (hit) {
          out.push({
            file: path,
            line: newCursor,
            snippet: content.trim().slice(0, SNIPPET_MAX_CHARS),
            receiver: hit.receiver,
            kind: hit.kind,
          });
        }
      }
      newCursor++;
    } else if (line === '' || line.startsWith(' ')) {
      // Context: present on the new side. A local declared in a context line
      // still classifies a later added write to it.
      const decl = LOCAL_DECL_RE.exec(line === '' ? '' : line.slice(1));
      if (decl) locals.add(decl[1]);
      newCursor++;
    }
    // `-` lines: old side only — no new-side line, and a removed declaration
    // does not exist in the file the write lands in.
  }

  return out;
}

/**
 * The scan shaped for spreading into a capture command's plan, mirroring
 * `planEffortField`: `{ recurrenceCandidates }` when the scan found any,
 * `{}` otherwise — the field is present only when non-empty, so consumers
 * key on its presence.
 */
export function planRecurrenceField(diffText: string): {
  recurrenceCandidates?: AccumulationCandidate[];
} {
  const candidates = scanAccumulationCandidates(diffText);
  if (candidates.length === 0) return {};
  writeStderrLine(
    `recurrence: ${candidates.length} accumulation candidate(s) recorded for ` +
      `the performance agent to adjudicate`,
  );
  return { recurrenceCandidates: candidates };
}
