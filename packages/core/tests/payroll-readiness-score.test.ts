/**
 * Payroll readiness scoring signal tests (Issue #720)
 *
 * Covers: full-ready scoring, partial blocking with correct point
 * withholding, custom weights, missing-signal exclusion, and validation.
 */

import {
  computePayrollReadinessScore,
  DEFAULT_PAYROLL_READINESS_WEIGHTS,
} from "../src/payroll/payrollReadinessScore";
import { ValidationError } from "../src/core/errors";

describe("computePayrollReadinessScore", () => {
  it("returns 100 when every supplied signal is ready", () => {
    const result = computePayrollReadinessScore({
      proof: { ready: true },
      funding: { ready: true },
      employer: { ready: true },
    });
    expect(result.score).toBe(100);
    expect(result.ready).toBe(true);
    expect(result.blockingSignals).toHaveLength(0);
  });

  it("withholds exactly one signal's weight when it is not ready", () => {
    const result = computePayrollReadinessScore({
      proof: { ready: true },
      funding: { ready: true },
      employer: { ready: false, reason: "Employer account not found" },
    });
    // employer weight 30 / total 100 => 30 points withheld
    expect(result.score).toBe(70);
    expect(result.ready).toBe(false);
    expect(result.blockingSignals.map((s) => s.id)).toEqual(["employer"]);
    expect(result.blockingSignals[0].reason).toBe("Employer account not found");
  });

  it("returns 0 when every supplied signal is blocking", () => {
    const result = computePayrollReadinessScore({
      proof: { ready: false },
      funding: { ready: false },
      employer: { ready: false },
    });
    expect(result.score).toBe(0);
    expect(result.ready).toBe(false);
    expect(result.blockingSignals).toHaveLength(3);
  });

  it("renormalizes to 100 over only the signals supplied", () => {
    const result = computePayrollReadinessScore({
      funding: { ready: true },
      employer: { ready: true },
    });
    expect(result.score).toBe(100);
    expect(result.signals).toHaveLength(2);
  });

  it("orders blocking signals heaviest-first", () => {
    const result = computePayrollReadinessScore({
      proof: { ready: false },
      funding: { ready: false },
      employer: { ready: true },
    });
    // funding (40) should be listed before proof (30)
    expect(result.blockingSignals.map((s) => s.id)).toEqual(["funding", "proof"]);
  });

  it("respects custom weights and renormalizes to 100", () => {
    const result = computePayrollReadinessScore(
      {
        proof: { ready: true },
        funding: { ready: false },
      },
      { proof: 1, funding: 1 }
    );
    expect(result.score).toBe(50);
  });

  it("falls back to default weight for a signal missing from a partial weights object", () => {
    const result = computePayrollReadinessScore(
      {
        funding: { ready: true },
        employer: { ready: false },
      },
      { funding: DEFAULT_PAYROLL_READINESS_WEIGHTS.funding }
    );
    // funding(40)+employer(30) default weights => funding share = 40/70 ≈ 57.14
    expect(result.score).toBeCloseTo((40 / 70) * 100, 1);
  });

  it("includes a human-readable message naming blocking signals", () => {
    const result = computePayrollReadinessScore({
      proof: { ready: false },
      employer: { ready: true },
    });
    expect(result.message).toContain("proof");
  });

  it("throws a ValidationError when no signals are supplied", () => {
    expect(() => computePayrollReadinessScore({})).toThrow(ValidationError);
  });

  it("throws a ValidationError for a non-positive weight", () => {
    expect(() => computePayrollReadinessScore({ proof: { ready: true } }, { proof: 0 })).toThrow(
      ValidationError
    );
  });

  it("throws a ValidationError for a non-finite weight", () => {
    expect(() =>
      computePayrollReadinessScore({ proof: { ready: true } }, { proof: Number.NaN })
    ).toThrow(ValidationError);
  });
});
