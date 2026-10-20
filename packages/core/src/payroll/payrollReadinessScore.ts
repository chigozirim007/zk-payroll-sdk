/**
 * Payroll Readiness Scoring Signals
 *
 * Aggregates the SDK's independent readiness checks — proof readiness
 * ({@link checkProofReadiness}), funding readiness
 * ({@link checkFundingReadiness}), and employer onboarding readiness
 * ({@link checkEmployerReadiness}) — into a single weighted 0-100 score with
 * a per-signal breakdown.
 *
 * ## Why This Matters
 * Each readiness checker already answers its own narrow "ready?" question,
 * but dashboards and pre-flight tooling want one glanceable number plus an
 * explanation of which signal is dragging the score down — without any one
 * checker needing to know about the others. This module stays a pure
 * aggregator: it accepts already-computed results and never calls the
 * underlying checkers itself, so it has no coupling to Soroban RPC, the
 * filesystem, or snarkjs.
 *
 * ## Scoring Model
 * Every signal contributes `weight` points when fully ready and `0` when
 * blocking (`ready: false`). There is deliberately no partial credit for a
 * "blocking" signal — a payroll run cannot proceed on partial funding or a
 * blocked employer account, so a failing signal must cost its full weight.
 * Missing (not supplied) signals are excluded from both the numerator and
 * the denominator rather than counted as failures, so a caller that only
 * has two of the three signals available still gets a meaningful score
 * over those two.
 *
 * @module
 */

import { ValidationError } from "../core/errors";

/** Stable identifiers for each readiness signal the score can incorporate. */
export type PayrollReadinessSignalId = "proof" | "funding" | "employer";

/** Default relative weight of each signal, out of 100 total when all three are present. */
export const DEFAULT_PAYROLL_READINESS_WEIGHTS: Readonly<Record<PayrollReadinessSignalId, number>> =
  {
    proof: 30,
    funding: 40,
    employer: 30,
  };

/** One signal's contribution, supplied by the caller. */
export interface PayrollReadinessSignalInput {
  /** Whether this signal is currently blocking ("ready") or not. */
  ready: boolean;
  /** Optional short, privacy-safe reason surfaced when the signal is not ready. */
  reason?: string;
}

/** The full set of signals a caller may supply; any subset is accepted. */
export type PayrollReadinessSignals = Partial<
  Record<PayrollReadinessSignalId, PayrollReadinessSignalInput>
>;

/** One signal's resolved contribution to the aggregate score. */
export interface PayrollReadinessScoreSignal {
  id: PayrollReadinessSignalId;
  ready: boolean;
  /** Points this signal contributed toward `score`. */
  pointsEarned: number;
  /** Points this signal could have contributed, i.e. its weight. */
  pointsAvailable: number;
  reason?: string;
}

/** Aggregate payroll readiness score and its contributing signals. */
export interface PayrollReadinessScoreResult {
  /** Weighted score from 0-100 across every *supplied* signal. */
  score: number;
  /** True only when every supplied signal is ready (score === 100). */
  ready: boolean;
  /** Resolved per-signal breakdown, in a fixed, deterministic order. */
  signals: PayrollReadinessScoreSignal[];
  /** Signals that were not ready, ordered by weight (heaviest first). */
  blockingSignals: PayrollReadinessScoreSignal[];
  /** Privacy-safe, human-readable summary. */
  message: string;
}

/** Fixed, deterministic ordering for signal evaluation and display. */
const SIGNAL_ORDER: readonly PayrollReadinessSignalId[] = ["funding", "employer", "proof"];

/**
 * Computes an aggregate payroll readiness score from independently-evaluated
 * readiness signals.
 *
 * @param signals - Any subset of `proof`, `funding`, and `employer` signal
 *   results. Signals that are omitted are excluded from scoring entirely —
 *   they neither help nor hurt the score.
 * @param weights - Relative weight of each signal. Defaults to
 *   {@link DEFAULT_PAYROLL_READINESS_WEIGHTS}. Only the weights for supplied
 *   signals are used; the score is always renormalized to 0-100 over the
 *   signals actually supplied.
 * @returns A deterministic 0-100 score plus a per-signal breakdown.
 * @throws {ValidationError} If no signals are supplied, or if any supplied
 *   weight is not a positive finite number.
 *
 * @example
 * ```ts
 * const result = computePayrollReadinessScore({
 *   funding: { ready: true },
 *   employer: { ready: false, reason: "Employer account not found" },
 *   proof: { ready: true },
 * });
 * result.score;            // 70 — employer's 30 points are withheld
 * result.ready;            // false
 * result.blockingSignals;  // [{ id: "employer", ... }]
 * ```
 */
export function computePayrollReadinessScore(
  signals: PayrollReadinessSignals,
  weights: Readonly<
    Partial<Record<PayrollReadinessSignalId, number>>
  > = DEFAULT_PAYROLL_READINESS_WEIGHTS
): PayrollReadinessScoreResult {
  const suppliedIds = SIGNAL_ORDER.filter((id) => signals[id] !== undefined);

  if (suppliedIds.length === 0) {
    throw new ValidationError(
      "At least one readiness signal (proof, funding, or employer) must be supplied",
      "signals",
      "PAYROLL_READINESS_SIGNALS_EMPTY"
    );
  }

  let totalWeight = 0;
  const resolvedWeights = new Map<PayrollReadinessSignalId, number>();
  for (const id of suppliedIds) {
    const weight = weights[id] ?? DEFAULT_PAYROLL_READINESS_WEIGHTS[id];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      throw new ValidationError(
        `Weight for signal "${id}" must be a positive finite number`,
        `weights.${id}`,
        "PAYROLL_READINESS_WEIGHT_INVALID"
      );
    }
    resolvedWeights.set(id, weight);
    totalWeight += weight;
  }

  const resolvedSignals: PayrollReadinessScoreSignal[] = suppliedIds.map((id) => {
    const input = signals[id] as PayrollReadinessSignalInput;
    const weight = resolvedWeights.get(id)!;
    const pointsAvailable = roundToTwoDecimals((weight / totalWeight) * 100);
    return {
      id,
      ready: input.ready,
      pointsEarned: input.ready ? pointsAvailable : 0,
      pointsAvailable,
      reason: input.ready ? undefined : input.reason,
    };
  });

  const rawScore = resolvedSignals.reduce((sum, signal) => sum + signal.pointsEarned, 0);
  // Guard against floating-point drift (e.g. 29.999999999999996) so an
  // all-ready set always reports exactly 100, never 99.99999999999999.
  const score = resolvedSignals.every((signal) => signal.ready)
    ? 100
    : roundToTwoDecimals(rawScore);

  const blockingSignals = resolvedSignals
    .filter((signal) => !signal.ready)
    .sort((a, b) => b.pointsAvailable - a.pointsAvailable);

  const ready = blockingSignals.length === 0;

  const message = ready
    ? `Payroll readiness score: ${score}/100 — all ${resolvedSignals.length} signal(s) ready`
    : `Payroll readiness score: ${score}/100 — blocked by ${blockingSignals.length} of ${resolvedSignals.length} signal(s): ` +
      blockingSignals.map((signal) => signal.id).join(", ");

  return {
    score,
    ready,
    signals: resolvedSignals,
    blockingSignals,
    message,
  };
}

/** Rounds to two decimal places, avoiding common binary floating-point artifacts. */
function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}
