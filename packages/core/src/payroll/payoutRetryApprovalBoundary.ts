/**
 * Payout Retry Approval Boundaries
 *
 * Combines {@link evaluateFailedPayoutRetryEligibility} (is this failed
 * payout technically safe to resubmit?) with an **approval boundary**: past
 * a configured attempt count, a retry additionally requires a fresh,
 * unexpired quorum of approvals before it may be resubmitted — the same way
 * a first-time payout does via {@link validatePayrollApprovalQuorum}.
 *
 * ## Why This Matters
 * `evaluateFailedPayoutRetryEligibility` is deliberately narrow: it only
 * reasons about the payout's own technical state (status, failure category,
 * attempt count, idempotency key). It has no concept of authorization. Left
 * on its own, an automated retry loop could keep resubmitting a payout
 * indefinitely up to `maxAttempts` with no human back in the loop. This
 * module adds that boundary: once a retry's attempt number reaches
 * `approvalRequiredFromAttempt`, eligibility additionally requires a live,
 * unexpired approval quorum — closing the gap between "technically
 * resubmittable" and "authorized to resubmit again."
 *
 * @module
 */

import { isApprovalExpired } from "../authorization/approvalExpiry";
import type { AuthorizationRequest } from "../authorization/types";
import {
  evaluateFailedPayoutRetryEligibility,
  type FailedPayoutRetryEligibility,
  type FailedPayoutRetryEligibilityInput,
} from "./retryEligibility";
import {
  validatePayrollApprovalQuorum,
  type PayrollApproverRecord,
  type QuorumConfig,
  type QuorumValidationResult,
} from "./payrollApprovalQuorumValidator";

/** Extended set of denial/eligibility codes layered on top of the base retry codes. */
export type PayoutRetryApprovalBoundaryCode =
  | FailedPayoutRetryEligibility["code"]
  | "APPROVAL_REQUIRED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_QUORUM_NOT_MET";

/** Input for a boundary-aware retry decision. */
export interface PayoutRetryApprovalBoundaryInput {
  /** Base technical retry eligibility input. */
  retry: FailedPayoutRetryEligibilityInput;
  /**
   * Attempt number (1-indexed, matching `retry.attemptCount + 1` — the
   * attempt about to be made) at and after which a fresh approval quorum is
   * required. `undefined` means approval is never required by attempt count.
   */
  approvalRequiredFromAttempt?: number;
  /** The approval request covering this retry, when one has been raised. */
  approvalRequest?: Pick<AuthorizationRequest, "expiresAt">;
  /** Approvals collected so far against `approvalRequest`, if any. */
  approvals?: PayrollApproverRecord[];
  /** Quorum configuration to apply to `approvals`, if an approval is required. */
  quorumConfig?: QuorumConfig;
  /** Reference time for expiry checks. Defaults to the current time. */
  now?: number;
}

/** Decision for one payout retry, inclusive of any approval boundary. */
export interface PayoutRetryApprovalBoundaryDecision {
  isEligible: boolean;
  code: PayoutRetryApprovalBoundaryCode;
  reason: string;
  suggestedFix?: string;
  /** Whether this attempt crossed the configured approval boundary. */
  approvalRequired: boolean;
  /** Present only when `approvalRequired` is true and approvals were supplied. */
  quorum?: QuorumValidationResult;
}

/**
 * Evaluates whether a failed payout retry is eligible, including any
 * approval-quorum boundary configured for higher attempt counts.
 *
 * Evaluation order:
 * 1. Base technical eligibility via {@link evaluateFailedPayoutRetryEligibility}.
 *    Any technical blocker short-circuits immediately — an unapproved retry
 *    that's also technically unsafe is reported for the technical reason.
 * 2. If the upcoming attempt (`attemptCount + 1`) is at or past
 *    `approvalRequiredFromAttempt`, an approval boundary applies:
 *    - No `approvalRequest` supplied → `APPROVAL_REQUIRED`.
 *    - `approvalRequest` expired → `APPROVAL_EXPIRED`.
 *    - Supplied approvals don't satisfy `quorumConfig` → `APPROVAL_QUORUM_NOT_MET`.
 *
 * @param input - Retry technical state plus optional approval-boundary context.
 *
 * @example
 * ```ts
 * const decision = evaluatePayoutRetryApprovalBoundary({
 *   retry: { status: "failed", failureCategory: "retryable", attemptCount: 2, maxAttempts: 5, idempotencyKey: "idem-1" },
 *   approvalRequiredFromAttempt: 3,
 *   approvalRequest: { expiresAt: Date.now() + 60_000 },
 *   approvals: [{ approverId: "alice", approvedAt: Date.now() }],
 *   quorumConfig: { requiredQuorum: 2 },
 * });
 * decision.isEligible; // false — quorum of 2 not met with only 1 approval
 * decision.code;       // "APPROVAL_QUORUM_NOT_MET"
 * ```
 */
export function evaluatePayoutRetryApprovalBoundary(
  input: PayoutRetryApprovalBoundaryInput
): PayoutRetryApprovalBoundaryDecision {
  const baseDecision = evaluateFailedPayoutRetryEligibility(input.retry);

  if (!baseDecision.isEligible) {
    return { ...baseDecision, approvalRequired: false };
  }

  const upcomingAttempt =
    typeof input.retry.attemptCount === "number" ? input.retry.attemptCount + 1 : undefined;

  const boundaryApplies =
    input.approvalRequiredFromAttempt !== undefined &&
    upcomingAttempt !== undefined &&
    upcomingAttempt >= input.approvalRequiredFromAttempt;

  if (!boundaryApplies) {
    return { ...baseDecision, approvalRequired: false };
  }

  if (!input.approvalRequest) {
    return {
      isEligible: false,
      code: "APPROVAL_REQUIRED",
      reason: `This retry attempt requires approval (attempt reaches the configured boundary of ${input.approvalRequiredFromAttempt}), but no approval request was provided.`,
      suggestedFix: "Raise an approval request and collect quorum before resubmitting.",
      approvalRequired: true,
    };
  }

  const now = input.now ?? Date.now();
  if (isApprovalExpired(input.approvalRequest, now)) {
    return {
      isEligible: false,
      code: "APPROVAL_EXPIRED",
      reason: "The approval request covering this retry has expired.",
      suggestedFix: "Raise a new approval request and collect quorum before resubmitting.",
      approvalRequired: true,
    };
  }

  if (!input.quorumConfig) {
    return {
      isEligible: false,
      code: "APPROVAL_QUORUM_NOT_MET",
      reason: "This retry requires an approval quorum, but no quorum configuration was provided.",
      suggestedFix: "Provide a quorumConfig describing the required approvals for this retry.",
      approvalRequired: true,
    };
  }

  const quorum = validatePayrollApprovalQuorum(input.approvals ?? [], input.quorumConfig);
  if (!quorum.quorumMet) {
    return {
      isEligible: false,
      code: "APPROVAL_QUORUM_NOT_MET",
      reason: quorum.reason ?? "Approval quorum for this retry has not been met.",
      suggestedFix: "Collect the remaining required approvals before resubmitting.",
      approvalRequired: true,
      quorum,
    };
  }

  return {
    ...baseDecision,
    approvalRequired: true,
    quorum,
  };
}
