/**
 * Historical payroll access authorization tests (Issue #719)
 *
 * Covers: scope sufficiency, grant-vs-period ordering (no backdated access),
 * lookback window enforcement, and masking of grantee identifiers.
 */

import {
  authorizeHistoricalPayrollAccess,
  type HistoricalPeriodRequest,
} from "../src/audit/historicalPayrollAccessAuthorization";
import { ValidationError } from "../src/core/errors";
import type { AuditGrantRecord } from "../src/audit/grantScope";

const GRANTEE = "GAUDITOR000000000000000000000000000000000000000000000";
const NOW = new Date("2026-06-01T00:00:00Z");

function grant(overrides: Partial<AuditGrantRecord> = {}): AuditGrantRecord {
  return {
    grantId: "grant-1",
    grantee: GRANTEE,
    scope: "read-only",
    grantedBy: "GADMIN0000000000000000000000000000000000000000000000",
    grantedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-12-31T00:00:00Z",
    ...overrides,
  };
}

function period(overrides: Partial<HistoricalPeriodRequest> = {}): HistoricalPeriodRequest {
  return {
    periodStartMs: Date.parse("2026-02-01T00:00:00Z"),
    periodEndMs: Date.parse("2026-02-28T00:00:00Z"),
    ...overrides,
  };
}

describe("authorizeHistoricalPayrollAccess", () => {
  it("authorizes access when a live grant covers the period and scope", () => {
    const decision = authorizeHistoricalPayrollAccess([grant()], GRANTEE, period(), { now: NOW });
    expect(decision.authorized).toBe(true);
    expect(decision.effectiveScope).toBe("read-only");
    expect(decision.denialCode).toBeUndefined();
  });

  it("denies access when the auditor has no live grant", () => {
    const decision = authorizeHistoricalPayrollAccess([], GRANTEE, period(), { now: NOW });
    expect(decision.authorized).toBe(false);
    expect(decision.denialCode).toBe("NO_LIVE_GRANT");
  });

  it("denies access when the auditor's grant has expired", () => {
    const decision = authorizeHistoricalPayrollAccess(
      [grant({ expiresAt: "2026-03-01T00:00:00Z" })],
      GRANTEE,
      period(),
      { now: NOW }
    );
    expect(decision.authorized).toBe(false);
    expect(decision.denialCode).toBe("NO_LIVE_GRANT");
  });

  it("denies access when the auditor's grant was revoked", () => {
    const decision = authorizeHistoricalPayrollAccess(
      [grant({ revokedAt: "2026-02-15T00:00:00Z" })],
      GRANTEE,
      period(),
      { now: NOW }
    );
    expect(decision.authorized).toBe(false);
    expect(decision.denialCode).toBe("NO_LIVE_GRANT");
  });

  it("denies access when effective scope is narrower than required", () => {
    const decision = authorizeHistoricalPayrollAccess(
      [grant({ scope: "read-only" })],
      GRANTEE,
      period(),
      {
        now: NOW,
        requiredScope: "full-audit",
      }
    );
    expect(decision.authorized).toBe(false);
    expect(decision.denialCode).toBe("INSUFFICIENT_SCOPE");
  });

  it("denies backdated access when the grant was issued after the period ended", () => {
    const decision = authorizeHistoricalPayrollAccess(
      [grant({ grantedAt: "2026-03-15T00:00:00Z" })],
      GRANTEE,
      period(),
      { now: NOW }
    );
    expect(decision.authorized).toBe(false);
    expect(decision.denialCode).toBe("PERIOD_BEFORE_GRANT");
  });

  it("allows access when the grant predates the period, even if issued long before", () => {
    const decision = authorizeHistoricalPayrollAccess(
      [grant({ grantedAt: "2025-01-01T00:00:00Z" })],
      GRANTEE,
      period(),
      { now: NOW }
    );
    expect(decision.authorized).toBe(true);
  });

  it("denies access when the period falls outside the configured lookback window", () => {
    const decision = authorizeHistoricalPayrollAccess(
      [grant({ grantedAt: "2025-01-01T00:00:00Z" })],
      GRANTEE,
      period({
        periodStartMs: Date.parse("2025-01-10T00:00:00Z"),
        periodEndMs: Date.parse("2025-01-20T00:00:00Z"),
      }),
      { now: NOW, maxLookbackMs: 30 * 24 * 60 * 60 * 1000 }
    );
    expect(decision.authorized).toBe(false);
    expect(decision.denialCode).toBe("PERIOD_OUTSIDE_LOOKBACK_WINDOW");
  });

  it("allows access when the period is within the configured lookback window", () => {
    const decision = authorizeHistoricalPayrollAccess(
      [grant({ grantedAt: "2025-01-01T00:00:00Z" })],
      GRANTEE,
      period(),
      { now: NOW, maxLookbackMs: 180 * 24 * 60 * 60 * 1000 }
    );
    expect(decision.authorized).toBe(true);
  });

  it("ignores grants belonging to other grantees", () => {
    const decision = authorizeHistoricalPayrollAccess(
      [grant({ grantee: "GOTHER00000000000000000000000000000000000000000000000" })],
      GRANTEE,
      period(),
      { now: NOW }
    );
    expect(decision.authorized).toBe(false);
    expect(decision.denialCode).toBe("NO_LIVE_GRANT");
  });

  it("masks the grantee identifier in every reason message", () => {
    const decision = authorizeHistoricalPayrollAccess([], GRANTEE, period(), { now: NOW });
    expect(decision.reason).not.toContain(GRANTEE);
  });

  it("throws a ValidationError for a non-finite period", () => {
    expect(() =>
      authorizeHistoricalPayrollAccess([grant()], GRANTEE, {
        periodStartMs: Number.NaN,
        periodEndMs: 1,
      })
    ).toThrow(ValidationError);
  });

  it("throws a ValidationError when periodEndMs precedes periodStartMs", () => {
    expect(() =>
      authorizeHistoricalPayrollAccess([grant()], GRANTEE, {
        periodStartMs: 2000,
        periodEndMs: 1000,
      })
    ).toThrow(ValidationError);
  });
});
