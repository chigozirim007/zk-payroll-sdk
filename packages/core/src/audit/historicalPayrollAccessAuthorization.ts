/**
 * Historical Payroll Access Authorization
 *
 * Authorizes whether an auditor's effective grant scope ({@link
 * readEffectiveAuditGrantScope}) permits access to a *specific historical
 * payroll period*. A live audit grant alone is not enough: the grant must
 * also have been live *during* the period being requested, and the request
 * must not reach further back than the grant's configured history window.
 *
 * ## Why This Matters
 * `readEffectiveAuditGrantScope` answers "is this auditor's access live
 * right now?" but integrations also need "may this auditor see *this*
 * period's payroll history?" A grant issued today should not retroactively
 * unlock periods from before it existed, and a grant scoped to a limited
 * look-back window should not be used to reach further into the past than
 * that window allows.
 *
 * ## Privacy
 * Like the rest of the `audit` module, this reader is metadata-only.
 * Grantee identifiers are masked via `redactAuditorId` in every message.
 *
 * @module
 */

import { ValidationError } from "../core/errors";
import { redactAuditorId } from "./accessExpiry";
import {
  readEffectiveAuditGrantScope,
  auditScopeSatisfies,
  type AuditGrantRecord,
} from "./grantScope";
import type { ViewKeyScope } from "./viewKeyHelpers";

/** Why a historical access request was denied. */
export type HistoricalAccessDenialCode =
  | "NO_LIVE_GRANT"
  | "INSUFFICIENT_SCOPE"
  | "PERIOD_BEFORE_GRANT"
  | "PERIOD_OUTSIDE_LOOKBACK_WINDOW"
  | "INVALID_PERIOD_RANGE";

/** Result of authorizing access to one historical payroll period. */
export interface HistoricalPayrollAccessDecision {
  /** Whether the auditor may access this period's payroll history. */
  authorized: boolean;
  /** Effective scope that produced the decision, or `null` if none is live. */
  effectiveScope: ViewKeyScope | null;
  /** Present when `authorized` is false. */
  denialCode?: HistoricalAccessDenialCode;
  /** Privacy-safe, human-readable explanation. */
  reason: string;
}

/** Describes the historical payroll period being requested. */
export interface HistoricalPeriodRequest {
  /** Start of the period, inclusive (epoch ms). */
  periodStartMs: number;
  /** End of the period, inclusive (epoch ms). Must be >= periodStartMs. */
  periodEndMs: number;
}

/** Options bounding how far back a grant may be used to look. */
export interface HistoricalPayrollAccessOptions {
  /** Minimum scope required to view this period. Defaults to "read-only". */
  requiredScope?: ViewKeyScope;
  /**
   * Maximum distance into the past (ms, measured from `now`) that any grant
   * may be used to authorize, regardless of how early the grant was issued.
   * `undefined` means unbounded (limited only by grant issuance time).
   */
  maxLookbackMs?: number;
  /** Reference "now". Defaults to the current time. */
  now?: Date;
}

/**
 * Authorizes an auditor's access to a specific historical payroll period.
 *
 * A request is authorized only when:
 * 1. The auditor's effective grant scope (at `now`) satisfies `requiredScope`.
 * 2. At least one currently-active grant was already granted (`grantedAt`) at
 *    or before the period's end — a grant cannot retroactively unlock
 *    periods that predate it.
 * 3. The period's end is within `maxLookbackMs` of `now`, when configured.
 *
 * @param grants - The auditor's persisted audit grants (all grantees may be
 *   mixed in; only grants for `grantee` are considered).
 * @param grantee - The auditor requesting access.
 * @param period - The historical payroll period being requested.
 * @param options - Scope requirement, lookback bound, and reference time.
 * @throws {ValidationError} If `period` is malformed (non-finite timestamps,
 *   or `periodEndMs < periodStartMs`).
 *
 * @example
 * ```ts
 * const decision = authorizeHistoricalPayrollAccess(
 *   grants,
 *   "GAB...",
 *   { periodStartMs: periodStart, periodEndMs: periodEnd },
 *   { requiredScope: "full-audit", maxLookbackMs: 90 * 24 * 60 * 60 * 1000 }
 * );
 * if (!decision.authorized) {
 *   console.warn(decision.reason);
 * }
 * ```
 */
export function authorizeHistoricalPayrollAccess(
  grants: AuditGrantRecord[],
  grantee: string,
  period: HistoricalPeriodRequest,
  options: HistoricalPayrollAccessOptions = {}
): HistoricalPayrollAccessDecision {
  if (
    typeof period?.periodStartMs !== "number" ||
    typeof period?.periodEndMs !== "number" ||
    !Number.isFinite(period.periodStartMs) ||
    !Number.isFinite(period.periodEndMs)
  ) {
    throw new ValidationError(
      "Historical period must specify finite periodStartMs and periodEndMs",
      "period",
      "HISTORICAL_PERIOD_INVALID"
    );
  }
  if (period.periodEndMs < period.periodStartMs) {
    throw new ValidationError(
      "periodEndMs must not be before periodStartMs",
      "period.periodEndMs",
      "HISTORICAL_PERIOD_RANGE_INVALID"
    );
  }

  const now = options.now ?? new Date();
  const requiredScope = options.requiredScope ?? "read-only";
  const who = redactAuditorId(grantee);

  const report = readEffectiveAuditGrantScope(grants, now);
  const effective = report.grantees.find((entry) => entry.grantee === grantee);
  const effectiveScope = effective?.scope ?? null;

  if (!effective || effective.state !== "active" || effectiveScope === null) {
    return {
      authorized: false,
      effectiveScope: null,
      denialCode: "NO_LIVE_GRANT",
      reason: `Auditor ${who} has no live audit grant; historical access cannot be authorized.`,
    };
  }

  if (!auditScopeSatisfies(effectiveScope, requiredScope)) {
    return {
      authorized: false,
      effectiveScope,
      denialCode: "INSUFFICIENT_SCOPE",
      reason: `Auditor ${who}'s effective scope "${effectiveScope}" does not satisfy the required scope "${requiredScope}" for this period.`,
    };
  }

  // A grant can only authorize periods it could have observed: the grant
  // must have existed (grantedAt) at or before the period's end, and must
  // currently be active (checked above via `readEffectiveAuditGrantScope`).
  const activeGrantIds = new Set(effective.activeGrantIds);
  const coveringGrant = effective.grants.find(
    (grant) =>
      activeGrantIds.has(grant.grantId) && Date.parse(grant.grantedAt) <= period.periodEndMs
  );

  if (!coveringGrant) {
    return {
      authorized: false,
      effectiveScope,
      denialCode: "PERIOD_BEFORE_GRANT",
      reason: `Auditor ${who}'s active grant(s) were issued after the requested period ended; access cannot be backdated.`,
    };
  }

  if (options.maxLookbackMs !== undefined) {
    const periodAgeMs = now.getTime() - period.periodEndMs;
    if (periodAgeMs > options.maxLookbackMs) {
      return {
        authorized: false,
        effectiveScope,
        denialCode: "PERIOD_OUTSIDE_LOOKBACK_WINDOW",
        reason: `The requested period is outside the ${Math.round(
          options.maxLookbackMs / (24 * 60 * 60 * 1000)
        )}-day lookback window permitted for this grant.`,
      };
    }
  }

  return {
    authorized: true,
    effectiveScope,
    reason: `Auditor ${who} is authorized to view this period under the "${effectiveScope}" scope.`,
  };
}
