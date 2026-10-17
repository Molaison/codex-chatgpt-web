import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RemoteTurnBroker,
  TurnBroker,
  type BrokerToolResult,
  type callTurnBroker,
} from "../src/adapters/chatgpt-web/turn-broker";

type Request = Parameters<typeof callTurnBroker>[1];
type Response = { id: string; result?: unknown; error?: string };
type Internals = {
  startPromise: Promise<void>;
  dispatch(request: Request): Promise<unknown>;
  handleSocket(socket: Socket): void;
  writeSocketResponse(socket: Socket, response: Response): void;
};

const acceptedResult: BrokerToolResult = {
  content: [{ type: "text", text: "simulated result" }],
  structuredContent: { completed: true },
  isError: false,
  _meta: { fixture: "ack-recovery" },
};

async function fixture() {
  const broker = TurnBroker.forSocket(join(tmpdir(), `mol185-ack-${randomUUID()}.sock`));
  const internal = broker as unknown as Internals;
  const dispatch = internal.dispatch.bind(internal);
  let toolInvocations = 0;
  internal.dispatch = request => {
    if (request.method === "invoke") toolInvocations += 1;
    return dispatch(request);
  };
  // Exercise the real registration, dispatch, and completion state machine without
  // creating a Unix endpoint. Only the transport startup is replaced in this fixture.
  internal.startPromise = Promise.resolve();
  const token = await broker.register({
    cwd: tmpdir(), roots: [tmpdir()], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
  }, undefined, "mol185-tool-ack");
  const activityId = "activity_mol185_ack_recovery_00001";
  const { bindingId } = await internal.dispatch({ method: "claim", token, activityId }) as { bindingId: string };
  let resultsResolved = 0;
  const invocation = internal.dispatch({
    method: "invoke", bindingId, wireName: "fixture_tool", arguments: { fixture: true },
  }).then(result => { resultsResolved += 1; return result; });
  // Attach a handler before any failing assertion can retire the pending invocation.
  void invocation.catch(() => {});
  const [request] = await broker.nextToolBatch(token);
  if (!request) throw new Error("Fixture did not deliver the simulated invocation");
  return { broker, internal, token, activityId, request, invocation,
    resultsResolved: () => resultsResolved, toolInvocations: () => toolInvocations };
}

test("MOL185: an exact completion replay after a lost ACK is accepted only once", async () => {
  const f = await fixture();
  try {
    f.broker.completeTool(f.token, f.request.callId, acceptedResult);
    expect(await f.invocation).toEqual(acceptedResult);
    expect(() => f.broker.completeTool(f.token, f.request.callId, structuredClone(acceptedResult)))
      .not.toThrow();
    expect(f.resultsResolved()).toBe(1);
  } finally { await f.broker.close(); }
});

test("MOL185: an accepted completion does not authorize conflicting result replays", async () => {
  const f = await fixture();
  try {
    f.broker.completeTool(f.token, f.request.callId, acceptedResult);
    expect(await f.invocation).toEqual(acceptedResult);
    for (const conflicting of [
      { ...acceptedResult, content: [{ type: "text", text: "different" }] },
      { ...acceptedResult, structuredContent: { completed: false } },
      { ...acceptedResult, isError: true },
      { ...acceptedResult, _meta: { fixture: "different" } },
    ]) {
      expect(() => f.broker.completeTool(f.token, f.request.callId, conflicting)).toThrow();
    }
    expect(f.resultsResolved()).toBe(1);
  } finally { await f.broker.close(); }
});

test("MOL185: an accepted completion receipt cannot survive turn revocation", async () => {
  const f = await fixture();
  try {
    f.broker.completeTool(f.token, f.request.callId, acceptedResult);
    await f.invocation;
    f.broker.revoke(f.token);
    expect(() => f.broker.completeTool(f.token, f.request.callId, acceptedResult)).toThrow("invalid or expired");
    expect(f.resultsResolved()).toBe(1);
  } finally { await f.broker.close(); }
});

async function loopbackOwner(f: Awaited<ReturnType<typeof fixture>>, onResponse: (socket: Socket, response: Response, original: () => void) => void) {
  const original = f.internal.writeSocketResponse.bind(f.internal);
  f.internal.writeSocketResponse = (socket, response) => onResponse(socket, response, () => original(socket, response));
  const peers = new Set<Socket>();
  const server = createServer(socket => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    f.internal.handleSocket(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not start loopback adapter");
  // Node's createConnection accepts this explicit loopback endpoint. The production
  // broker protocol and RemoteTurnBroker client remain unchanged and unmocked.
  const endpoint = { host: "127.0.0.1", port: address.port } as unknown as string;
  return {
    remote: new RemoteTurnBroker(endpoint),
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      f.internal.writeSocketResponse = original;
    },
  };
}

test("MOL185: remote completion recovers a dropped ACK without re-executing the tool", async () => {
  const f = await fixture();
  let acknowledgements = 0;
  let serializationCount = 0;
  const mutableResult = { content: [{ type: "text", text: "original snapshot" }] };
  const outgoingResult = {
    content: [],
    toJSON() { serializationCount += 1; return mutableResult; },
  };
  const expectedResult = structuredClone(mutableResult);
  const owner = await loopbackOwner(f, (socket, response, original) => {
    if ((response.result as { completed?: boolean } | undefined)?.completed === true) {
      acknowledgements += 1;
      if (acknowledgements === 1) {
        mutableResult.content[0]!.text = "caller changed the original after acceptance";
        socket.destroy();
        return;
      }
    }
    original();
  });
  try {
    const started = performance.now();
    const completion = owner.remote.completeTool(f.token, f.request.callId, outgoingResult);
    void completion.catch(() => {});
    // Crucial evidence: the tool result has already crossed the authoritative broker
    // boundary even though the owner has not received its completion ACK.
    expect(await f.invocation).toEqual(expectedResult);
    // Bun 1.4 Windows: an async matcher can re-enter libuv while its socket callback
    // is still active (oven-sh/bun#44025). Await normally, then keep the same assertion.
    expect(await completion).toBeUndefined();
    expect(acknowledgements).toBe(2);
    expect(f.resultsResolved()).toBe(1);
    expect(serializationCount).toBe(1);
    expect(f.toolInvocations()).toBe(1);
    console.info("MOL185_TOOL_ACK_RECOVERY", JSON.stringify({
      recoveryElapsedMs: Math.round((performance.now() - started) * 100) / 100,
      simulatedToolInvocations: f.toolInvocations(), acceptedResultResolutions: f.resultsResolved(),
      completionAcknowledgements: acknowledgements, resultSerializations: serializationCount,
    }));
  } finally { await owner.close(); await f.broker.close(); }
});

test("MOL185: remote completion rejects malformed success ACKs", async () => {
  const f = await fixture();
  const owner = await loopbackOwner(f, (socket, response, original) => {
    if ((response.result as { completed?: boolean } | undefined)?.completed === true) {
      socket.end(JSON.stringify({ id: response.id, result: { completed: false } }) + "\n");
      return;
    }
    original();
  });
  try {
    await expect(owner.remote.completeTool(f.token, f.request.callId, acceptedResult)).rejects.toThrow();
    expect(await f.invocation).toEqual(acceptedResult);
    expect(f.resultsResolved()).toBe(1);
  } finally { await owner.close(); await f.broker.close(); }
});

test("MOL185: repeated lost completion ACKs stop after one safe replay", async () => {
  const f = await fixture();
  let acknowledgements = 0;
  const owner = await loopbackOwner(f, (socket, response, original) => {
    if ((response.result as { completed?: boolean } | undefined)?.completed === true) {
      acknowledgements += 1;
      socket.destroy();
      return;
    }
    original();
  });
  try {
    await expect(owner.remote.completeTool(f.token, f.request.callId, acceptedResult)).rejects.toThrow();
    expect(await f.invocation).toEqual(acceptedResult);
    expect(acknowledgements).toBe(2);
    expect(f.resultsResolved()).toBe(1);
  } finally { await owner.close(); await f.broker.close(); }
}, 15_000);

test.each([
  [{ completed: false }, undefined],
  [undefined, "fixture completion rejected"],
] as const)("MOL185: a definitive negative completion frame does not retry while FIN is withheld (%j, %s)", async (result, error) => {
  const f = await fixture();
  let requests = 0;
  const owner = await loopbackOwner(f, (socket, response) => {
    requests += 1;
    socket.write(JSON.stringify({ id: response.id, ...(error ? { error } : { result }) }) + "\n");
  });
  try {
    await expect(owner.remote.completeTool(f.token, f.request.callId, acceptedResult)).rejects.toThrow(
      error ?? "invalid tool completion result",
    );
    expect(requests).toBe(1);
    expect(await f.invocation).toEqual(acceptedResult);
  } finally { await owner.close(); await f.broker.close(); }
}, 7_000);

test.each([
  { protocolVersion: 5, acceptingExternalOwners: true },
  { protocolVersion: 5, toolCompletionReplay: "true" },
  { protocolVersion: 4, toolCompletionReplay: true },
  null,
])("MOL185: unsupported or malformed replay capability fails closed (%j)", async status => {
  const f = await fixture();
  let completions = 0;
  let capabilityQueries = 0;
  const owner = await loopbackOwner(f, (socket, response, original) => {
    if ((response.result as { completed?: boolean } | undefined)?.completed === true) {
      completions += 1;
      socket.destroy();
      return;
    }
    if ((response.result as { protocolVersion?: number } | undefined)?.protocolVersion !== undefined) {
      capabilityQueries += 1;
      socket.end(JSON.stringify({ id: response.id, result: status }) + "\n");
      return;
    }
    original();
  });
  try {
    await expect(owner.remote.completeTool(f.token, f.request.callId, acceptedResult)).rejects.toThrow("closed the connection");
    expect(completions).toBe(1);
    expect(capabilityQueries).toBe(1);
    expect(await f.invocation).toEqual(acceptedResult);
  } finally { await owner.close(); await f.broker.close(); }
});
