/**
 * Bulk employee edit concurrency control tests (Issue #721)
 *
 * Covers: intra-batch duplicate targets, stale base versions, unknown
 * employees, happy path, and input validation.
 */

import {
  validateBulkEmployeeEditConcurrency,
  type BulkEmployeeEdit,
  type CurrentEmployeeVersion,
} from "../src/employees/bulkEditConcurrencyControl";
import { ValidationError } from "../src/core/errors";

describe("validateBulkEmployeeEditConcurrency", () => {
  const currentVersions: CurrentEmployeeVersion[] = [
    { employeeId: "emp-1", version: "v3", timestamp: 1000 },
    { employeeId: "emp-2", version: "v1", timestamp: 2000 },
  ];

  it("accepts every edit when versions match and targets are unique", () => {
    const edits: BulkEmployeeEdit[] = [
      { employeeId: "emp-1", baseVersion: "v3", patch: { salary: 1 } },
      { employeeId: "emp-2", baseVersion: "v1", patch: { salary: 2 } },
    ];
    const result = validateBulkEmployeeEditConcurrency(edits, currentVersions);
    expect(result.allApplicable).toBe(true);
    expect(result.applicable).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects the second edit targeting the same employee in one batch", () => {
    const edits: BulkEmployeeEdit[] = [
      { employeeId: "emp-1", baseVersion: "v3", patch: { salary: 1 } },
      { employeeId: "emp-1", baseVersion: "v3", patch: { salary: 5 } },
    ];
    const result = validateBulkEmployeeEditConcurrency(edits, currentVersions);
    expect(result.allApplicable).toBe(false);
    expect(result.applicable).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("DUPLICATE_TARGET_IN_BATCH");
    expect(result.rejected[0].conflictsWithIndex).toBe(0);
    expect(result.rejected[0].index).toBe(1);
  });

  it("rejects an edit whose baseVersion is stale against the current persisted version", () => {
    const edits: BulkEmployeeEdit[] = [{ employeeId: "emp-1", baseVersion: "v2", patch: {} }];
    const result = validateBulkEmployeeEditConcurrency(edits, currentVersions);
    expect(result.allApplicable).toBe(false);
    expect(result.rejected[0].code).toBe("STALE_BASE_VERSION");
    expect(result.rejected[0].conflictResponse.conflict.conflictType).toBe("STALE_VERSION");
  });

  it("rejects an edit targeting an employee with no known current version", () => {
    const edits: BulkEmployeeEdit[] = [{ employeeId: "emp-404", baseVersion: "v1", patch: {} }];
    const result = validateBulkEmployeeEditConcurrency(edits, currentVersions);
    expect(result.rejected[0].code).toBe("UNKNOWN_EMPLOYEE");
  });

  it("only rejects the duplicate when the first edit for an employee is otherwise valid", () => {
    const edits: BulkEmployeeEdit[] = [
      { employeeId: "emp-2", baseVersion: "v1", patch: {} },
      { employeeId: "emp-2", baseVersion: "v1", patch: {} },
      { employeeId: "emp-1", baseVersion: "v3", patch: {} },
    ];
    const result = validateBulkEmployeeEditConcurrency(edits, currentVersions);
    expect(result.applicable).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].index).toBe(1);
  });

  it("masks employee identifiers in rejection messages", () => {
    const edits: BulkEmployeeEdit[] = [
      { employeeId: "employee-secret-12345", baseVersion: "stale", patch: {} },
    ];
    const result = validateBulkEmployeeEditConcurrency(edits, [
      { employeeId: "employee-secret-12345", version: "current", timestamp: 0 },
    ]);
    expect(result.rejected[0].conflictResponse.message).not.toContain("employee-secret-12345");
  });

  it("produces a deterministic summary message", () => {
    const edits: BulkEmployeeEdit[] = [{ employeeId: "emp-1", baseVersion: "v3", patch: {} }];
    const result = validateBulkEmployeeEditConcurrency(edits, currentVersions);
    expect(result.message).toContain("1");
  });

  it("throws a ValidationError for an empty batch", () => {
    expect(() => validateBulkEmployeeEditConcurrency([], currentVersions)).toThrow(ValidationError);
  });

  it("throws a ValidationError for a malformed edit", () => {
    expect(() =>
      validateBulkEmployeeEditConcurrency(
        [{ employeeId: "", baseVersion: "v1", patch: {} }] as BulkEmployeeEdit[],
        currentVersions
      )
    ).toThrow(ValidationError);
  });

  it("throws a ValidationError when baseVersion is neither string nor number", () => {
    expect(() =>
      validateBulkEmployeeEditConcurrency(
        [{ employeeId: "emp-1", baseVersion: undefined as unknown as string, patch: {} }],
        currentVersions
      )
    ).toThrow(ValidationError);
  });
});
