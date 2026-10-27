import { expect, test } from "vitest";
import { TokenBucket } from "../src/bucket";

test("capacity 20, refills 4/min", () => {
  let t = 0;
  const b = new TokenBucket(20, 4, () => t);
  expect(b.tryTake(20)).toBe(true);
  expect(b.tryTake(1)).toBe(false);
  expect(b.msUntil(1)).toBe(15_000);
  expect(b.msUntil(3)).toBe(45_000);
  t = 15_000;
  expect(b.msUntil(1)).toBe(0);
  expect(b.tryTake(1)).toBe(true);
  expect(b.tryTake(1)).toBe(false);
  t = 60 * 60_000;
  expect(b.tryTake(21)).toBe(false); // never exceeds capacity
  expect(b.tryTake(20)).toBe(true);
});
