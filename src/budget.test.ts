import { expect, test } from "bun:test";

import { Budget } from "./budget.ts";

test("the admission budget is shared across successive recordings", () => {
  const budget = new Budget(0.3);
  budget.reserve(0.1, "first recording");
  budget.reserve(0.2, "second recording");
  expect(() => budget.reserve(0.0001, "third recording")).toThrow(
    "budget exceeded"
  );
});

test("a zero budget admits offline work but blocks paid requests", () => {
  const budget = new Budget(0);
  budget.reserve(0, "offline");
  expect(() => budget.reserve(0.01, "cloud")).toThrow("budget exceeded");
});

test("unknown pricing cannot bypass an explicit budget", () => {
  expect(() => new Budget(5).reserve(null, "token-priced audio")).toThrow(
    "unknown pricing"
  );
});

test("actual reported cost above an estimate reduces future available budget", () => {
  const budget = new Budget(1);
  budget.reserve(0.1, "first recording");
  budget.record(0.9);
  expect(() => budget.reserve(0.2, "second recording")).toThrow(
    "budget exceeded"
  );
});

test("missing usage is unknown rather than free and blocks further budgeted spending", () => {
  const budget = new Budget(1);
  budget.reserve(0.1, "first recording");
  budget.record(null);
  expect(budget.describe()).toContain("costs unknown");
  expect(() => budget.reserve(0.1, "second recording")).toThrow(
    "prior request cost is unknown"
  );
});

test("invalid monetary limits are rejected", () => {
  for (const maximum of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => new Budget(maximum)).toThrow("finite, nonnegative");
  }
});
