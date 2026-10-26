import { createHash } from "node:crypto";
import { notifyLauncherTurn, type NativeWatchDurableReceipt } from "../../launcher-browser-host";
import { nativeExecutionDigest, type NativeReleaseReceipt, type NativeResultReady } from "./native-execution";
import { parseBrowserObservation, type BrowserObservationCheckpoint } from "./observation-recovery";
import { nativeSubmissionDescendsFrom, nativeSubmissionDigest, parseNativeSubmission,
  submissionIdentityUnproven, type NativeSubmissionRecord } from "./submission-identity";

/** Finish an already durable result on the original Host, without acquiring browser write rights. */
export async function finalizeObservedNativeResult(options: {
  descriptorPath: string;
  checkpoint: BrowserObservationCheckpoint;
  submission: NativeSubmissionRecord;
  ready: NativeResultReady;
  onRelease(receipt: NativeReleaseReceipt): void | Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
}, control = notifyLauncherTurn): Promise<NativeReleaseReceipt> {
  const checkpoint = parseBrowserObservation(options.checkpoint);
  const submission = parseNativeSubmission(options.submission);
  const ready = options.ready;
  if (checkpoint.version !== 2 || !checkpoint.submission.native || submission.phase !== "completed"
    || !nativeSubmissionDescendsFrom(checkpoint.submission.native, submission)
    || ready.sendId !== submission.sendId || ready.completedDigest !== nativeSubmissionDigest(submission)
    || ready.answerSha256 !== createHash("sha256").update(ready.answer).digest("hex")
    || ready.version !== 1 || !Number.isSafeInteger(ready.readyAt) || ready.readyAt < submission.completion!.observedAt
    || Object.entries({ ...checkpoint.identity, traceId: checkpoint.traceId }).some(([key, value]) =>
      ready.scope[key as keyof typeof ready.scope] !== value)) {
    throw submissionIdentityUnproven("recovered terminal does not match the original accepted generation");
  }
  const { answer: _answer, ...metadata } = ready;
  const result = await control(options.descriptorPath, {
    phase: "observe-complete",
    traceId: checkpoint.traceId,
    helperPid: process.pid,
    surfaceId: checkpoint.lease.surfaceId,
    observation: checkpoint,
    receipt: {
      record: submission as NativeWatchDurableReceipt["record"],
      acknowledgement: { sendId: submission.sendId, revision: submission.revision,
        digest: nativeSubmissionDigest(submission) },
    },
    resultReady: { ...metadata, digest: nativeExecutionDigest(ready) },
  }, options.timeoutMs ?? 10_000, options.signal);
  if (!result.nativeRelease) throw submissionIdentityUnproven("observed completion has no physical release receipt");
  await options.onRelease(result.nativeRelease);
  return result.nativeRelease;
}
