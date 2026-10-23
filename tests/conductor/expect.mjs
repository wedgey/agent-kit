import assert from "node:assert/strict";
import { it } from "node:test";
import { format } from "node:util";

/** The few `expect` matchers these tests use, on node:assert. */
export function expect(actual) {
  return {
    toBe: (expected) => assert.ok(Object.is(actual, expected), `expected ${format("%o", actual)} to be ${format("%o", expected)}`),
    toBeNull: () => assert.equal(actual, null),
    toBeUndefined: () => assert.equal(actual, undefined),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected),
    toMatchObject: (expected) => assert.partialDeepStrictEqual(actual, expected),
    toMatch: (re) => assert.match(actual, re),
    toContain: (part) => assert.ok(actual.includes(part), `expected ${format("%o", actual)} to contain ${format("%o", part)}`),
    toHaveLength: (n) => assert.equal(actual.length, n),
    toBeGreaterThan: (n) => assert.ok(actual > n, `expected ${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n) => assert.ok(actual >= n, `expected ${actual} >= ${n}`),
    toBeLessThan: (n) => assert.ok(actual < n, `expected ${actual} < ${n}`),
    not: { toMatch: (re) => assert.doesNotMatch(actual, re) },
  };
}

/** One test per row, named with printf placeholders filled from the row. */
export const each = (rows) => (name, fn) => {
  for (const row of rows) {
    const args = Array.isArray(row) ? row : [row];
    it(format(name, ...args), () => fn(...args));
  }
};
