import { expect, test } from "bun:test";
import { AsyncEventQueue } from "../src/event-queue";

test("a full queue delivers one failure instead of its undelivered backlog", async () => {
  const queue = new AsyncEventQueue<string>(1);
  queue.push("undelivered partial output");
  expect(() => queue.push("overflow")).toThrow("Adapter event backlog exceeded");
  queue.fail("failed");
  queue.fail("second failure");
  queue.close();
  queue.push("late completion");
  expect(await queue.collect()).toEqual(["failed"]);
});

test("failure releases waiting consumers with one terminal value", async () => {
  const queue = new AsyncEventQueue<string>();
  const first = queue[Symbol.asyncIterator]().next();
  const second = queue[Symbol.asyncIterator]().next();
  queue.fail("failed");
  expect(await first).toEqual({ value: "failed", done: false });
  expect(await second).toEqual({ value: undefined, done: true });
});

test("normal close drains accepted values and releases idle waiters", async () => {
  const queue = new AsyncEventQueue<string>();
  queue.push("first"); queue.push("second"); queue.close();
  expect(await queue.collect()).toEqual(["first", "second"]);
  const idle = new AsyncEventQueue<string>();
  const next = idle[Symbol.asyncIterator]().next();
  idle.close();
  expect(await next).toEqual({ value: undefined, done: true });
});

test("return discards undelivered output and closes every waiter", async () => {
  const queue = new AsyncEventQueue<string>();
  queue.push("unused");
  const iterator = queue[Symbol.asyncIterator]();
  await iterator.return!();
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
  queue.push("late");
  expect(await queue.collect()).toEqual([]);
});
