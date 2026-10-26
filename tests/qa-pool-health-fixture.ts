import { afterEach, beforeEach, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { QaHealthAdmission, type HostAssignmentAdmission } from "../src/qa-health";

/** Protocol tests supply an already healthy synthetic runtime. Health proof
 * authentication and rejection are exercised separately by 43b/43c fixtures. */
export function syntheticQaHealthAdmission(accountId: string, sessionHash: string): HostAssignmentAdmission {
  const observedAt = Date.now();
  return { version: 1, assignment: { admissionId: randomUUID(), sessionHash }, admittedAt: observedAt,
    runtime: { instanceId: "fixture-runtime", pid: process.pid, version: "fixture", bundleId: "a".repeat(64), accountId, mode: "browser-only" },
    host: { version: 1, accountId, principalDigest: "b".repeat(64), revision: 1, cookieRevision: 1,
      observedAt, expiresAt: observedAt + 60_000, state: "ready",
      host: { instanceId: "fixture-host", pid: process.pid, profile: "development", partition: "fixture", version: "fixture", closureDigest: "c".repeat(64) } },
  };
}

export function installReadyQaHealthFixture(): void {
  const mocks: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    mocks.push(spyOn(QaHealthAdmission.prototype, "check").mockResolvedValue(true));
    mocks.push(spyOn(QaHealthAdmission.prototype, "eligibleNow").mockReturnValue(true));
    mocks.push(spyOn(QaHealthAdmission.prototype, "authorizeSelected").mockImplementation(async (account, hash) => {
      let consumed = false;
      return () => {
        if (consumed) return;
        consumed = true;
        return syntheticQaHealthAdmission(account.id, hash);
      };
    }));
  });
  afterEach(() => { for (const mock of mocks.splice(0).reverse()) mock.mockRestore(); });
}
