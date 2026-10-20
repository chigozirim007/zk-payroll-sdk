/**
 * Bulk Employee Edit Concurrency Controls
 *
 * Guards a *batch* of employee edits against two distinct concurrency
 * hazards that {@link createEmployeeVersionConflictResponse} does not cover
 * on its own, because that helper only reasons about a single employee at a
 * time:
 *
 * 1. **Intra-batch collisions** — two edits in the *same* submitted batch
 *    targeting the same employee. Applying both is inherently a race: the
 *    second write silently wins over the first with no conflict ever
 *    surfacing to either caller.
 * 2. **Stale base versions** — an edit whose `baseVersion` no longer matches
 *    the employee's current persisted version, i.e. someone else's update
 *    landed between when the caller read the record and when they submitted
 *    the edit (the classic optimistic-locking check).
 *
 * Edits that pass both checks are returned as the clear-to-apply subset;
 * offending edits are returned as per-employee conflicts so the caller can
 * surface them (via {@link createEmployeeVersionConflictResponse}) without
 * ever applying a write the submitter didn't actually see.
 *
 * ## Privacy
 * Employee identifiers are masked in every message via the same
 * `redactEmpId` convention the version-conflict module uses, by delegating
 * conflict presentation to {@link createEmployeeVersionConflictResponse}.
 *
 * @module
 */

import { ValidationError } from "../core/errors";
import {
  createEmployeeVersionConflictResponse,
  type EmployeeVersionConflictResponse,
} from "./versionConflictResponse";

/** One proposed edit within a bulk batch. */
export interface BulkEmployeeEdit {
  /** Employee the edit targets. */
  employeeId: string;
  /** Version the caller believes is current (read before composing the edit). */
  baseVersion: string | number;
  /** Opaque patch payload; never inspected by this module. */
  patch: unknown;
}

/** The employee's actual current version, as persisted. */
export interface CurrentEmployeeVersion {
  employeeId: string;
  version: string | number;
  timestamp: number;
}

/** Why one edit in the batch was rejected. */
export type BulkEditRejectionCode =
  "DUPLICATE_TARGET_IN_BATCH" | "STALE_BASE_VERSION" | "UNKNOWN_EMPLOYEE";

/** A single rejected edit, with enough context to build a conflict response. */
export interface RejectedBulkEdit {
  edit: BulkEmployeeEdit;
  code: BulkEditRejectionCode;
  /** Index of this edit within the original `edits` array. */
  index: number;
  /** Index of the earlier edit in the batch targeting the same employee, when applicable. */
  conflictsWithIndex?: number;
  /** A ready-to-surface conflict response, built via the shared version-conflict formatter. */
  conflictResponse: EmployeeVersionConflictResponse;
}

/** Result of validating a bulk employee edit batch for concurrency hazards. */
export interface BulkEditConcurrencyResult {
  /** Edits that are safe to apply, in original order. */
  applicable: BulkEmployeeEdit[];
  /** Edits rejected for a concurrency hazard, in original order. */
  rejected: RejectedBulkEdit[];
  /** True only when every edit in the batch is applicable. */
  allApplicable: boolean;
  /** Privacy-safe summary. */
  message: string;
}

/**
 * Validates a batch of employee edits against intra-batch collisions and
 * stale base versions before any of them are applied.
 *
 * Processing is a single left-to-right pass: for each employee, the *first*
 * edit targeting them in the batch is the one considered (and checked
 * against the current persisted version); every subsequent edit for the
 * same employee in the same batch is rejected as a duplicate target,
 * regardless of whether the first edit itself turned out to be stale.
 *
 * @param edits - Proposed edits, typically one call site's entire "bulk
 *   edit" submission.
 * @param currentVersions - The employees' actual current versions, as read
 *   from the registry immediately before applying the batch. An employee
 *   absent from this list is treated as unknown (e.g. deleted or never
 *   existed) and every edit targeting them is rejected.
 * @throws {ValidationError} If `edits` is empty or malformed.
 *
 * @example
 * ```ts
 * const result = validateBulkEmployeeEditConcurrency(edits, currentVersions);
 * if (!result.allApplicable) {
 *   for (const r of result.rejected) console.warn(r.conflictResponse.message);
 * }
 * await applyEdits(result.applicable);
 * ```
 */
export function validateBulkEmployeeEditConcurrency(
  edits: BulkEmployeeEdit[],
  currentVersions: CurrentEmployeeVersion[]
): BulkEditConcurrencyResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new ValidationError(
      "Bulk employee edit batch must be a non-empty array",
      "edits",
      "BULK_EDIT_BATCH_EMPTY"
    );
  }

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (
      typeof edit !== "object" ||
      edit === null ||
      typeof edit.employeeId !== "string" ||
      edit.employeeId.trim() === "" ||
      (typeof edit.baseVersion !== "string" && typeof edit.baseVersion !== "number")
    ) {
      throw new ValidationError(
        `Edit at index ${i} must have a non-empty employeeId and a string/number baseVersion`,
        `edits[${i}]`,
        "BULK_EDIT_INVALID"
      );
    }
  }

  const currentByEmployee = new Map<string, CurrentEmployeeVersion>();
  for (const current of currentVersions) {
    currentByEmployee.set(current.employeeId, current);
  }

  const applicable: BulkEmployeeEdit[] = [];
  const rejected: RejectedBulkEdit[] = [];
  const firstIndexByEmployee = new Map<string, number>();

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const firstIndex = firstIndexByEmployee.get(edit.employeeId);

    if (firstIndex !== undefined) {
      rejected.push({
        edit,
        index: i,
        code: "DUPLICATE_TARGET_IN_BATCH",
        conflictsWithIndex: firstIndex,
        conflictResponse: createEmployeeVersionConflictResponse(
          edit.employeeId,
          "CONCURRENT_UPDATE",
          [
            { versionId: String(edits[firstIndex].baseVersion), timestamp: 0, source: "local" },
            { versionId: String(edit.baseVersion), timestamp: 1, source: "local" },
          ],
          { attemptAutoResolve: false }
        ),
      });
      continue;
    }

    firstIndexByEmployee.set(edit.employeeId, i);
    const current = currentByEmployee.get(edit.employeeId);

    if (!current) {
      rejected.push({
        edit,
        index: i,
        code: "UNKNOWN_EMPLOYEE",
        conflictResponse: createEmployeeVersionConflictResponse(
          edit.employeeId,
          "MISSING_VERSION",
          [{ versionId: String(edit.baseVersion), timestamp: 0, source: "local" }],
          { attemptAutoResolve: false }
        ),
      });
      continue;
    }

    if (String(current.version) !== String(edit.baseVersion)) {
      rejected.push({
        edit,
        index: i,
        code: "STALE_BASE_VERSION",
        conflictResponse: createEmployeeVersionConflictResponse(
          edit.employeeId,
          "STALE_VERSION",
          [
            { versionId: String(edit.baseVersion), timestamp: 0, source: "local" },
            { versionId: String(current.version), timestamp: current.timestamp, source: "remote" },
          ],
          { attemptAutoResolve: true, preferredStrategy: "TAKE_REMOTE" }
        ),
      });
      continue;
    }

    applicable.push(edit);
  }

  const allApplicable = rejected.length === 0;
  const message = allApplicable
    ? `All ${applicable.length} edit(s) in the batch are free of concurrency conflicts`
    : `${rejected.length} of ${edits.length} edit(s) rejected for concurrency conflicts; ${applicable.length} remain applicable`;

  return { applicable, rejected, allApplicable, message };
}
