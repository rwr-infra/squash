import { afterAll, beforeAll, expect, it } from 'vitest';

export type Declared = string | { readonly label: string; readonly skip: boolean };
type CheckResult = { readonly ok: boolean; readonly detail: string };

/** Thrown by a flow to stop at a failed check, as the smoke stopped there. */
export class CheckFailed extends Error {}

export type FlowHooks = {
  /** The flow's own limit, its cleanup included. */
  readonly timeoutMs: number;
  /**
   * Stops and removes what the flow started; returns what went wrong, if
   * anything. Runs once: after the flow, or — when the flow overran its
   * timeout and is still going (`timedOut`) — from an afterAll. `failed`:
   * the flow threw, a failed check included.
   */
  readonly cleanup: (state: { readonly failed: boolean; readonly timedOut: boolean }) => Promise<string | undefined>;
  /** Diagnostics for a flow that threw (a failed check included), before cleanup. */
  readonly onError?: (error: unknown) => Promise<void> | void;
};

// The afterAll's limit: cleanup enumerates processes, and a cold WMI query on
// a Windows runner alone can take 30 s.
const CLEANUP_TIMEOUT_MS = 90_000;

/**
 * For a smoke moved over as one flow whose observations are timing-sensitive:
 * the flow runs once, as it did in the script, in a beforeAll, and records
 * each check the moment it reaches it; then every declared label is one test,
 * named by it, of what was recorded. A label never recorded fails as "not
 * recorded" (the flow stopped before it, or never makes it). `skip`: not
 * checked on this platform — recording it anyway, recording an undeclared
 * label or one label twice is an error.
 *
 * The flow may stop at a failed check by throwing CheckFailed. Any other error
 * it throws — an exception the smoke would have died of — and any problem its
 * cleanup reports fail the last test, "the flow ends without an error" (the
 * flow's own error first).
 *
 * Call at the top level of a test file, while tests are collected; `check`
 * records and returns `ok`.
 */
export const recordedChecks = (labels: readonly Declared[]) => {
  const declared = labels.map((entry) => (typeof entry === 'string' ? { label: entry, skip: false } : entry));
  const skipped = new Map<string, boolean>();
  for (const { label, skip } of declared) {
    if (skipped.has(label)) throw new Error(`label "${label}" is declared twice`);
    skipped.set(label, skip);
  }
  const results = new Map<string, CheckResult>();
  let flowError: unknown;

  const check = (label: string, ok: boolean, detail = ''): boolean => {
    const skip = skipped.get(label);
    if (skip === undefined) throw new Error(`check "${label}" is not declared`);
    if (skip) throw new Error(`check "${label}" is declared as skipped on this platform`);
    if (results.has(label)) throw new Error(`check "${label}" recorded twice`);
    results.set(label, { ok, detail });
    return ok;
  };

  const run = (flow: () => Promise<void>, hooks: FlowHooks) => {
    let cleanup: Promise<string | undefined> | undefined;
    // Set once the beforeAll is done; until then its tests cannot report.
    let settled = false;
    const cleanupOnce = (state: { readonly failed: boolean; readonly timedOut: boolean }) =>
      (cleanup ??= hooks.cleanup(state).catch((error: unknown) => `Cleanup failed: ${(error as Error).stack ?? error}`));

    beforeAll(async () => {
      let thrown: { readonly error: unknown } | undefined;
      try {
        await flow();
      } catch (error) {
        thrown = { error };
        try { await hooks.onError?.(error); } catch { /* keep the flow's own error */ }
      }
      const problem = await cleanupOnce({ failed: thrown !== undefined, timedOut: false });
      if (thrown && !(thrown.error instanceof CheckFailed)) {
        flowError = thrown.error;
        if (problem) console.error(problem);
      } else if (problem) {
        flowError = new Error(problem);
      }
      settled = true;
    }, hooks.timeoutMs);

    // The flow overran its timeout and is still going (or its cleanup is):
    // stop what it started. Never throws — a throwing afterAll skips the
    // hooks after it.
    afterAll(async () => {
      if (settled) return;
      // Joins the cleanup the flow's beforeAll may have begun before it timed
      // out; nothing reports what it returns but this.
      const problem = await cleanupOnce({ failed: true, timedOut: true });
      if (problem) console.error(problem);
    }, CLEANUP_TIMEOUT_MS);

    for (const { label, skip } of declared) {
      it.skipIf(skip)(label, () => {
        const result = results.get(label);
        expect(result, 'not recorded: the flow stopped before this check (see the failures above), or never makes it').toBeDefined();
        expect(result!.ok, result!.detail || 'failed').toBe(true);
      });
    }
    it('the flow ends without an error', () => {
      if (flowError !== undefined) throw flowError;
    });
  };

  return { check, run };
};
