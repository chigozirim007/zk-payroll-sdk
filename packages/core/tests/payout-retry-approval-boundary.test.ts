/**
 * Payout retry approval boundary tests (Issue #722)
 *
 * Covers: technical eligibility short-circuiting, the approval boundary by
 * attempt count, missing/expired approval requests, and quorum enforcement.
 */

import { evaluatePayoutRetryApprovalBoundary } from "../src/payroll/payoutRetryApprovalBoundary";
import type { FailedPayoutRetryEligibilityInput } from "../src/payroll/retryEligibility";

function retryInput(
  overrides: Partial<FailedPayoutRetryEligibilityInput> = {}
): FailedPayoutRetryEligibilityInput {
  return {
    status: "failed",
    failureCategory: "retryable",
    attemptCount: 1,
    maxAttempts: 5,
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

describe("evaluatePayoutRetryApprovalBoundary", () => {
  it("is eligible with no approval boundary configured", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({ retry: retryInput() });
    expect(decision.isEligible).toBe(true);
    expect(decision.approvalRequired).toBe(false);
  });

  it("short-circuits on a technical blocker without evaluating approval", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({
      retry: retryInput({ status: "confirmed" }),
      approvalRequiredFromAttempt: 1,
    });
    expect(decision.isEligible).toBe(false);
    expect(decision.code).toBe("PAYOUT_ALREADY_CONFIRMED");
    expect(decision.approvalRequired).toBe(false);
  });

  it("does not require approval below the configured attempt boundary", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({
      retry: retryInput({ attemptCount: 1 }), // upcoming attempt = 2
      approvalRequiredFromAttempt: 3,
    });
    expect(decision.isEligible).toBe(true);
    expect(decision.approvalRequired).toBe(false);
  });

  it("requires approval once the upcoming attempt reaches the boundary", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({
      retry: retryInput({ attemptCount: 2 }), // upcoming attempt = 3
      approvalRequiredFromAttempt: 3,
    });
    expect(decision.isEligible).toBe(false);
    expect(decision.code).toBe("APPROVAL_REQUIRED");
    expect(decision.approvalRequired).toBe(true);
  });

  it("rejects when the approval request has expired", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({
      retry: retryInput({ attemptCount: 2 }),
      approvalRequiredFromAttempt: 3,
      approvalRequest: { expiresAt: 1000 },
      now: 2000,
      quorumConfig: { requiredQuorum: 1 },
      approvals: [{ approverId: "alice", approvedAt: 500 }],
    });
    expect(decision.isEligible).toBe(false);
    expect(decision.code).toBe("APPROVAL_EXPIRED");
  });

  it("rejects when no quorumConfig is provided for a boundary-crossing retry", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({
      retry: retryInput({ attemptCount: 2 }),
      approvalRequiredFromAttempt: 3,
      approvalRequest: { expiresAt: 5000 },
      now: 2000,
    });
    expect(decision.isEligible).toBe(false);
    expect(decision.code).toBe("APPROVAL_QUORUM_NOT_MET");
  });

  it("rejects when the collected approvals don't meet quorum", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({
      retry: retryInput({ attemptCount: 2 }),
      approvalRequiredFromAttempt: 3,
      approvalRequest: { expiresAt: 5000 },
      now: 2000,
      quorumConfig: { requiredQuorum: 2 },
      approvals: [{ approverId: "alice", approvedAt: 500 }],
    });
    expect(decision.isEligible).toBe(false);
    expect(decision.code).toBe("APPROVAL_QUORUM_NOT_MET");
    expect(decision.quorum?.quorumMet).toBe(false);
  });

  it("is eligible once quorum is met within an unexpired approval window", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({
      retry: retryInput({ attemptCount: 2 }),
      approvalRequiredFromAttempt: 3,
      approvalRequest: { expiresAt: 5000 },
      now: 2000,
      quorumConfig: { requiredQuorum: 2 },
      approvals: [
        { approverId: "alice", approvedAt: 500 },
        { approverId: "bob", approvedAt: 600 },
      ],
    });
    expect(decision.isEligible).toBe(true);
    expect(decision.approvalRequired).toBe(true);
    expect(decision.quorum?.quorumMet).toBe(true);
  });

  it("treats an approval request with no expiresAt as never expiring", () => {
    const decision = evaluatePayoutRetryApprovalBoundary({
      retry: retryInput({ attemptCount: 2 }),
      approvalRequiredFromAttempt: 3,
      approvalRequest: {},
      quorumConfig: { requiredQuorum: 1 },
      approvals: [{ approverId: "alice", approvedAt: 500 }],
    });
    expect(decision.isEligible).toBe(true);
  });
});
