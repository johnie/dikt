import { expect, test } from "bun:test";

import { mapLimit } from "./pool.ts";

interface Gate {
  promise: Promise<undefined>;
  open: () => void;
}
const gate = (): Gate => {
  const deferred = Promise.withResolvers<undefined>();
  return { open: () => deferred.resolve(), promise: deferred.promise };
};
const capture = async <T>(promise: Promise<T>): Promise<T | Error> => {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
};

test("failure stops new work but waits for active callbacks before rejecting", async () => {
  const active = gate();
  const started = gate();
  const failure = new Error("provider rejected chunk");
  const visited: number[] = [];
  let settled = false;
  let saved = false;
  const work = mapLimit([0, 1, 2, 3], 2, async (item) => {
    visited.push(item);
    if (item === 0) {
      await active.promise;
      saved = true;
      return item;
    }
    started.open();
    throw failure;
  });
  const outcome = (async () => {
    try {
      return await capture(work);
    } finally {
      settled = true;
    }
  })();
  await started.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(visited).toEqual([0, 1]);
  active.open();
  expect(await outcome).toBe(failure);
  expect(saved).toBe(true);
  expect(visited).toEqual([0, 1]);
});

test("out-of-order workers preserve input order and respect the concurrency bound", async () => {
  const first = gate();
  const second = gate();
  const bothStarted = gate();
  let running = 0;
  let peak = 0;
  const completion: number[] = [];
  const result = mapLimit([0, 1, 2], 2, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    if (item === 1) {
      bothStarted.open();
    }
    if (item === 0) {
      await first.promise;
    }
    if (item === 1) {
      await second.promise;
    }
    completion.push(item);
    running -= 1;
    return item * 10;
  });
  await bothStarted.promise;
  second.open();
  await second.promise;
  await Promise.resolve();
  first.open();
  expect(await result).toEqual([0, 10, 20]);
  expect(completion[0]).toBe(1);
  expect(peak).toBe(2);
});

test("abort prevents later scheduling and waits for an active save", async () => {
  const controller = new AbortController();
  const active = gate();
  const started = gate();
  const visited: number[] = [];
  let saved = false;
  const outcome = capture(
    mapLimit(
      [0, 1],
      1,
      async (item) => {
        visited.push(item);
        started.open();
        await active.promise;
        saved = true;
        return item;
      },
      controller.signal
    )
  );
  await started.promise;
  const reason = new Error("cancelled");
  controller.abort(reason);
  active.open();
  expect(await outcome).toBe(reason);
  expect(saved).toBe(true);
  expect(visited).toEqual([0]);
});

test("invalid concurrency fails before any callback can run", async () => {
  let called = false;
  const callback = () => {
    called = true;
    return Promise.resolve();
  };
  await Promise.all(
    [0, -1, 1.5, Number.POSITIVE_INFINITY].map((limit) =>
      expect(mapLimit([1], limit, callback)).rejects.toThrow("positive integer")
    )
  );
  expect(called).toBe(false);
});
