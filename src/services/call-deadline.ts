/**
 * @fileoverview One deadline per tool or resource call. An MCP SDK client gives up
 * on a request after 60 s by default, so every upstream request a call makes — each
 * attempt, each backoff, each chained read, and each wait on a shared load, across
 * services — spends one budget whose instant is fixed when the call starts. The
 * instant rides on the call's context; an attempt's timeout is whatever the instant
 * leaves, and expiry is one typed `Timeout` naming the upstream and how to recover.
 * Caller cancellation always outranks it.
 * @module services/call-deadline
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, type RetryOptions, withRetry } from '@cyanheads/mcp-ts-core/utils';

/**
 * Budget of one tool or resource call. It sits under the MCP SDK client's 60 s
 * default request timeout with room left for formatting and transport, so the
 * client is still waiting when the typed expiry arrives.
 */
export const CALL_DEADLINE_MS = 50_000;

/**
 * A remainder this small cannot carry a request: a request that would start on
 * its deadline sends nothing.
 */
const SPENT_MS = 1;

/**
 * The upstreams a call spends its deadline on: the name the expiry and the retry
 * label carry, and the recovery its expiry offers. Each hint claims only what is
 * true of that upstream.
 */
const UPSTREAMS = {
  /** Measured: the API finishes and caches (24 h) a read the client abandoned, keyed by the exact URL. */
  indicators: {
    name: 'World Bank Indicators API',
    hint: 'The request is valid. Repeat the same call unchanged after about a minute: the World Bank Indicators API finishes a request after this server stops waiting and caches the answer, so the repeat is usually served from that cache. A changed call starts a new computation.',
  },
  /** True by construction: PIP requests run as shared loads that outlive the call that started them. */
  pip: {
    name: 'World Bank Poverty and Inequality Platform (PIP) API',
    hint: 'The request is valid. Repeat the same call: this server keeps the PIP request running after the deadline and answers the repeat from its result.',
  },
  /** Unmeasured, so no cache claim. */
  projects: {
    name: 'World Bank Projects API',
    hint: 'Retry the call shortly, or narrow the request so the World Bank Projects API has less to return.',
  },
} as const;

/** An upstream a call's deadline can expire on. */
export type Upstream = keyof typeof UPSTREAMS;

/** Where a call's deadline instant (epoch ms) rides on its context. */
const DEADLINE = Symbol('call deadline');

type DeadlineCarrier = { [DEADLINE]?: number | undefined };

/** Log bindings `withRetry` accepts; the handler `Context` is safe to pass (see `RetryOptions.context`). */
type RetryContext = Context & Record<string, unknown>;

/**
 * `ctx` carrying a call deadline {@link CALL_DEADLINE_MS} from now — or `ctx`
 * itself when it already carries one, so a tool handler and the service method it
 * calls share the earlier instant. Never mutates `ctx`.
 */
export function withCallDeadline<C extends Context>(ctx: C): C {
  if ((ctx as DeadlineCarrier)[DEADLINE] !== undefined) return ctx;
  return { ...ctx, [DEADLINE]: Date.now() + CALL_DEADLINE_MS };
}

/**
 * `ctx` without a call deadline: the context a shared load runs under, which keeps
 * its own bound so it can finish and cache after every waiter's deadline passed.
 */
export function withoutCallDeadline<C extends Context>(ctx: C): C {
  return { ...ctx, [DEADLINE]: undefined };
}

/** Milliseconds left on `ctx`'s call deadline, never negative; `undefined` when it carries none. */
export function callDeadlineRemainingMs(ctx: Context): number | undefined {
  const expiresAt = (ctx as DeadlineCarrier)[DEADLINE];
  return expiresAt === undefined ? undefined : Math.max(0, expiresAt - Date.now());
}

/**
 * The typed expiry of a call deadline spent on `upstream`: `Timeout`,
 * `reason: 'upstream_timeout'`, `retryable: true` (the request itself is valid),
 * the budget in the message and in `budgetMs`, and the upstream's recovery hint.
 */
export function callDeadlineExceeded(upstream: Upstream, cause?: unknown): McpError {
  const { name, hint } = UPSTREAMS[upstream];
  return timeout(
    `The ${name} did not complete the request within the call's ${CALL_DEADLINE_MS / 1000} s deadline.`,
    { reason: 'upstream_timeout', retryable: true, budgetMs: CALL_DEADLINE_MS, recovery: { hint } },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * True for {@link callDeadlineExceeded}'s error, told by its `budgetMs` from another
 * `upstream_timeout` — a shared PIP request that ran out of its own bound, which a
 * caller that joined it late sees with its own deadline still running.
 */
export function isCallDeadlineExceeded(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    error.data?.reason === 'upstream_timeout' &&
    error.data?.budgetMs === CALL_DEADLINE_MS
  );
}

/** What one attempt of {@link retryWithinCallDeadline} bounds its single request with. */
export interface CallAttempt {
  /** The caller's signal composed with the deadline clock; thread it into the request. */
  readonly signal: AbortSignal;
  /**
   * The request's timeout, body read included: what the call deadline leaves, or
   * {@link CallRetryOptions.attemptTimeoutMs} when the context carries no deadline.
   */
  readonly timeoutMs: number;
}

/** Retry tuning for {@link retryWithinCallDeadline}; everything else is fixed by the call deadline. */
export interface CallRetryOptions
  extends Pick<RetryOptions, 'baseDelayMs' | 'isTransient' | 'maxRetries'> {
  /**
   * Per-attempt timeout when the context carries no call deadline — inside a
   * shared load, which runs under a bounded signal of its own. On a caller's path
   * every attempt gets what the deadline leaves instead.
   */
  readonly attemptTimeoutMs: number;
}

/** `withRetry`'s own expiry of `deadlineMs`, which never reaches a caller as such. */
function isRetryDeadlineExpiry(error: unknown): boolean {
  return error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded';
}

/**
 * Run `attempt` under the framework's `withRetry`, bounded by the call deadline
 * `ctx` carries. Each attempt's timeout is what the deadline leaves, so one attempt
 * can hold until the deadline, while failures that return early (5xx, network
 * errors, anything `isTransient` accepts) are still retried inside it. A request
 * that would start with no more than 1 ms left sends nothing. Expiry — mid-attempt,
 * mid-backoff, or before dispatch — throws {@link callDeadlineExceeded} for
 * `upstream`; a caller abort is rethrown untouched and outranks it.
 *
 * With no deadline on `ctx` (a shared load), each attempt gets
 * `attemptTimeoutMs` and the ladder is bounded only by the load's own signal.
 */
export async function retryWithinCallDeadline<T>(
  ctx: Context,
  upstream: Upstream,
  attempt: (handle: CallAttempt) => Promise<T>,
  { attemptTimeoutMs, isTransient, ...tuning }: CallRetryOptions,
): Promise<T> {
  const options = {
    ...tuning,
    operation: `${UPSTREAMS[upstream].name} request`,
    context: ctx as RetryContext,
    signal: ctx.signal,
  };
  const remainingMs = callDeadlineRemainingMs(ctx);
  if (remainingMs === undefined) {
    return withRetry(({ signal }) => attempt({ signal, timeoutMs: attemptTimeoutMs }), {
      ...options,
      ...(isTransient && { isTransient }),
    });
  }

  const spent = (leftMs: number) => leftMs <= SPENT_MS && !ctx.signal.aborted;
  if (spent(remainingMs)) throw callDeadlineExceeded(upstream);
  try {
    return await withRetry(
      ({ signal, remainingMs: leftMs }) => {
        if (spent(leftMs)) throw callDeadlineExceeded(upstream);
        return attempt({ signal, timeoutMs: leftMs });
      },
      {
        ...options,
        deadlineMs: remainingMs,
        isTransient: (error) =>
          !isCallDeadlineExceeded(error) && (isTransient ?? defaultIsTransient)(error),
      },
    );
  } catch (error) {
    if (!ctx.signal.aborted && isRetryDeadlineExpiry(error)) {
      throw callDeadlineExceeded(upstream, error);
    }
    throw error;
  }
}
