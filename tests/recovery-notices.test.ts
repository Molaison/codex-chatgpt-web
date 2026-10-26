import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableOperation, OperationJournal, type OperationRecord } from "../src/adapters/chatgpt-web/operation-journal";

test("recovery notices preserve distinct stages and later episodes without duplicating a reconnect", () => {
  const directory = mkdtempSync(join(tmpdir(), "recovery-notices-"));
  const startedAt = Date.now();
  const record: OperationRecord = {
    version: 1, operationId: "notice-operation", executionKey: "notice-execution", traceId: "notice-trace",
    requestIds: [], submission: "prepared", generation: "not_started", delivery: "attached", recovery: "none",
    seq: 0, attempt: 1, startedAt, updatedAt: startedAt, rounds: {},
  };
  const journal = new OperationJournal(directory);
  const operation = new DurableOperation(journal, record);
  try {
    operation.freezeRecoveryBudget();
    operation.reserveRecovery("transport_retry", startedAt + 1);
    const waiting = operation.notice("reconnecting", "Waiting for the connector");
    const refresh = operation.notice("reconnecting", "Refreshing the connector");
    expect(refresh.id).not.toBe(waiting.id);
    expect(operation.notice("reconnecting", "Refreshing the connector").id).toBe(refresh.id);
    operation.confirmRecovery(1, startedAt + 2);
    const resumed = operation.notice("resumed");

    const restored = new DurableOperation(new OperationJournal(directory), journal.read<OperationRecord>(record.executionKey)!);
    expect(restored.notice("resumed").id).toBe(resumed.id);
    expect(restored.notice("reconnecting", "Waiting for the connector").id).toBe(waiting.id);
    restored.reserveRecovery("transport_retry", startedAt + 3);
    const second = restored.notice("reconnecting", "Waiting for the connector");
    expect(second.id).not.toBe(waiting.id);
    expect(second.seq).toBeGreaterThan(resumed.seq);
    expect(restored.record.rounds).toEqual({});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
