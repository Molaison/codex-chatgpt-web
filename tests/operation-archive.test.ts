import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableOperation, OperationJournal, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";

function record(key: string, completed: boolean): OperationRecord {
  return {
    version: 1, operationId: key, executionKey: key, traceId: "archive-test", ownerKey: key,
    requestIds: [], submission: "accepted", generation: completed ? "final" : "unknown",
    delivery: "unknown", recovery: completed ? "none" : "retained", seq: 0, attempt: 1,
    startedAt: Date.now(), updatedAt: Date.now(), physicalSettled: completed, rounds: {},
    ...(completed ? { final: { answer: key, events: [], reasoning: [] } } : {}),
  };
}

test("terminal archival preserves old replay identities without exhausting active journal capacity", () => {
  const directory = mkdtempSync(join(tmpdir(), "operation-archive-"));
  const journal = new OperationJournal(directory);
  try {
    new DurableOperation(journal, record("unknown-original", false)).checkpoint();
    for (let index = 0; index < 4096; index++) {
      new DurableOperation(journal, record(`completed-${index}`, true)).checkpoint();
    }
    expect(readdirSync(journal.directory).filter(name => name.endsWith(".json"))).toHaveLength(1);
    expect(journal.read<OperationRecord>("completed-0")?.final?.answer).toBe("completed-0");
    expect(journal.unresolvedOwner("unknown-original", "next")?.executionKey).toBe("unknown-original");
    const restored = new DurableOperation(new OperationJournal(directory), journal.read<OperationRecord>("completed-0")!);
    restored.notice("observer_detached");
    expect(journal.read<OperationRecord>("completed-0")?.notices).toHaveLength(1);
    expect(readdirSync(journal.directory).filter(name => name.endsWith(".json"))).toHaveLength(1);
    expect([...journal.readAll<OperationRecord>()]).toHaveLength(4097);
    expect(existsSync(journal.path("unknown-original"))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("logical finals with an unreleased original owner stay active", () => {
  const directory = mkdtempSync(join(tmpdir(), "operation-unreleased-"));
  const journal = new OperationJournal(directory);
  try {
    const original = record("unreleased", true);
    original.physicalSettled = false;
    new DurableOperation(journal, original).checkpoint();
    expect(readdirSync(journal.directory).filter(name => name.endsWith(".json"))).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a full pre-upgrade journal archives only proven terminal owners before admitting a new operation", () => {
  const directory = mkdtempSync(join(tmpdir(), "operation-archive-upgrade-"));
  const journal = new OperationJournal(directory);
  try {
    const unknown = record("legacy-unknown", false);
    journal.write(unknown.executionKey, unknown);
    const nativeUnknown = record("native-unknown", true);
    nativeUnknown.nativeScope = { operationId: nativeUnknown.operationId, executionKey: nativeUnknown.executionKey,
      roundKey: "original", traceId: nativeUnknown.traceId, turnId: "original" };
    journal.write(nativeUnknown.executionKey, nativeUnknown);
    for (let index = 2; index < 4096; index++) journal.write(`legacy-${index}`, record(`legacy-${index}`, true));
    expect(readdirSync(journal.directory).filter(name => name.endsWith(".json"))).toHaveLength(4096);
    const upgraded = new OperationJournal(directory);
    new DurableOperation(upgraded, record("new-original", false)).checkpoint();
    expect(readdirSync(journal.directory).filter(name => name.endsWith(".json"))).toHaveLength(3);
    expect(upgraded.read<OperationRecord>("legacy-2")?.final?.answer).toBe("legacy-2");
    expect(upgraded.read<OperationRecord>("legacy-unknown")).toEqual(unknown);
    expect(upgraded.read<OperationRecord>("native-unknown")).toEqual(nativeUnknown);
    expect(upgraded.unresolvedOwner("native-unknown", "next")?.executionKey).toBe("native-unknown");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
