/**
 * @fileoverview tests/helpers/linear-cpu-time.ts — Thread-CPU scaling harness for
 * text-handling functions: asserts a synchronous function runs in linear time as
 * its input grows 64×.
 * @module tests/helpers/linear-cpu-time
 */

import { expect } from 'vitest';

/** This thread's CPU time per call, in microseconds, across `calls` back-to-back runs. */
function cpuMicrosPerCall(run: () => void, calls: number): number {
  const start = process.threadCpuUsage();
  for (let i = 0; i < calls; i++) run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / calls;
}

/** Calls per baseline measurement; a larger size runs as many as keep the characters per measurement equal. */
const BASE_CALLS = 64;
const PAIRS = 5;
/** CPU ceiling per call at any size; the slowest shape tested takes well under 5 ms at its largest. */
const MAX_CALL_MICROS = 50_000;

/**
 * Expect `run` to scale linearly over `shape`, doubling the input from `base` to
 * 64 × `base` characters. At each size the baseline is timed again beside it,
 * PAIRS times, and the least of those growth ratios must stay under four times
 * the size ratio (256 across the full 64×) before the next size runs, so
 * growth beyond linear fails within a few doublings. CPU time, never wall clock.
 */
export function expectLinear(
  base: number,
  shape: (chars: number) => string,
  run: (input: string) => void,
): void {
  const baseline = shape(base);
  for (let chars = base * 2; chars <= base * 64; chars *= 2) {
    const input = shape(chars);
    const calls = Math.max(1, Math.round((BASE_CALLS * base) / chars));
    let growth = Number.POSITIVE_INFINITY;
    let cost = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < PAIRS; pair++) {
      const small = cpuMicrosPerCall(() => run(baseline), BASE_CALLS);
      const sized = cpuMicrosPerCall(() => run(input), calls);
      growth = Math.min(growth, sized / Math.max(small, 0.01));
      cost = Math.min(cost, sized);
    }
    expect(growth, `growth at ${chars} characters`).toBeLessThan((4 * chars) / base);
    expect(cost, `CPU µs per call at ${chars} characters`).toBeLessThan(MAX_CALL_MICROS);
  }
}
