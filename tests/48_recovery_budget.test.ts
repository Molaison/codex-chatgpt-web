import { tmpdir } from "node:os";
import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {join} from "node:path";
import {DurableOperation,OperationJournal,type OperationRecord} from "../src/adapters/chatgpt-web/operation-journal";
function fixture(){
  mkdirSync((process.env.Q39_TEST_ROOT ?? tmpdir()),{recursive:true});const root=mkdtempSync(join((process.env.Q39_TEST_ROOT ?? tmpdir()),"budget-"));
  const journal=new OperationJournal(root);const record:OperationRecord={version:1,operationId:"op_budget",executionKey:"budget",traceId:"budget_trace",requestIds:[],
    submission:"prepared",generation:"not_started",delivery:"attached",recovery:"none",seq:0,attempt:1,updatedAt:1000,startedAt:1000,rounds:{}};
  return {root,journal,record,operation:new DurableOperation(journal,record)};
}
test("one durable budget spans transport, context and HTTP retry without replacement-runtime reset",()=>{
  const f=fixture();try{
    f.operation.freezeRecoveryBudget();f.operation.reserveRecovery("transport_retry",1100);
    const restored=new DurableOperation(new OperationJournal(f.root),new OperationJournal(f.root).read<OperationRecord>("budget")!);
    restored.freezeRecoveryBudget(999999);restored.reserveRecovery("context_recovery",1200);restored.reserveRecovery("http_retry",1300);
    expect(restored.record.recoveryBudget!.used).toBe(3);expect(restored.record.recoveryBudget!.deadlineAt).toBeUndefined();
    expect(()=>restored.reserveRecovery("observer_reconnect",1400)).toThrow("exhausted");
    expect(restored.record.recoveryBudget!.attempts.map(a=>a.reason)).toEqual(["transport_retry","context_recovery","http_retry"]);
    expect(restored.record.submission).toBe("prepared");expect(restored.record.generation).toBe("not_started");
    const freshRecord={...f.record,operationId:"op_new",executionKey:"new",attempt:1,recoveryBudget:undefined};
    const fresh=new DurableOperation(f.journal,freshRecord);fresh.freezeRecoveryBudget();expect(fresh.record.recoveryBudget!.used).toBe(0);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("configured absolute deadline never renews; explicit cancellation/final cannot recover",()=>{
  const f=fixture();try{
    f.operation.freezeRecoveryBudget(500);expect(f.record.recoveryBudget!.deadlineAt).toBe(1500);
    f.operation.freezeRecoveryBudget(50000);expect(f.record.recoveryBudget!.deadlineAt).toBe(1500);
    f.operation.reserveRecovery("transport_retry",1499);
    expect(()=>f.operation.reserveRecovery("context_recovery",1500)).toThrow("exhausted");
    f.record.error={code:"client_cancelled"};expect(()=>f.operation.reserveRecovery("transport_retry",1200)).toThrow("exhausted");
    delete f.record.error;f.record.generation="final";expect(()=>f.operation.reserveRecovery("transport_retry",1200)).toThrow("exhausted");
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("reconnecting/resumed notice IDs persist without repeated publications or model text",()=>{
  const f=fixture();try{
    const notices:string[]=[];f.operation.observeNotices(n=>notices.push(n.kind));
    const first=f.operation.notice("reconnecting");for(let i=0;i<40;i++)f.operation.notice("tool_waiting");
    expect(f.operation.notice("reconnecting").id).toBe(first.id);expect(notices.filter(n=>n==="reconnecting")).toHaveLength(1);
    const resumed=f.operation.notice("resumed");expect(f.operation.notice("resumed").id).toBe(resumed.id);
    const restored=new DurableOperation(f.journal,f.journal.read<OperationRecord>("budget")!);expect(restored.notice("reconnecting").id).toBe(first.id);
    expect(f.record.rounds).toEqual({});
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test("an expired operation retains its prepared input and never activates Send", () => {
  const f = fixture();
  try {
    f.operation.freezeRecoveryBudget(500);
    expect(() => f.operation.beforeSend()).toThrow("deadline");
    expect(f.record.submission).toBe("prepared");
    expect(f.record.generation).toBe("not_started");
    expect(f.record.recoveryBudget!.used).toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy mutable checkpoints cannot manufacture an original recovery deadline", () => {
  const f = fixture();
  try {
    delete f.record.startedAt;
    f.record.updatedAt = Date.now();
    expect(() => f.operation.freezeRecoveryBudget(500)).toThrow("unproven");
    expect(f.record.recoveryBudget).toBeUndefined();
    expect(f.record.submission).toBe("prepared");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
