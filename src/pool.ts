export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  signal?.throwIfAborted();
  const results: R[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  const execute = async (index: number): Promise<[number, R]> => {
    signal?.throwIfAborted();
    const item = items[index];
    if (item === undefined) {
      throw new Error("Missing work item");
    }
    return [index, await fn(item, index)];
  };
  // Each worker pulls its next task only after the previous promise settles.
  const tasks = function* tasks(): Generator<
    Promise<[number, R]>,
    void,
    undefined
  > {
    while (next < items.length) {
      if (failed) {
        return;
      }
      const index = next;
      next += 1;
      yield execute(index);
    }
  };
  const worker = async () => {
    try {
      for await (const [index, value] of tasks()) {
        results[index] = value;
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  if (failed) {
    throw failure;
  }
  signal?.throwIfAborted();
  return results;
};
