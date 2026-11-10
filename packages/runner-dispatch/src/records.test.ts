import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldName, isId, parseRunLabel, runLabel, sameName, sameRun, type RunKey } from "./records.ts";

const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const notAnId = fc.constantFrom<unknown>(0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", null, undefined, 1n);

/** A second, slow statement of the rule of GitHub names: only the 26 ASCII capital letters change. */
function foldSlow(name: string): string {
  let result = "";
  for (const character of name) {
    const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(character);
    result += index === -1 ? character : "abcdefghijklmnopqrstuvwxyz".charAt(index);
  }
  return result;
}

describe("isId", () => {
  it("accepts each whole number from 1 that JavaScript keeps exactly", () => {
    fc.assert(fc.property(id, (value) => isId(value)));
  });

  it("refuses each other value", () => {
    fc.assert(fc.property(notAnId, (value) => !isId(value)));
  });
});

describe("foldName and sameName", () => {
  it("changes only the ASCII capital letters", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (name) => {
        expect(foldName(name)).toBe(foldSlow(name));
      }),
    );
  });

  it("compares two names without the case of ASCII letters", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1 }), fc.string({ unit: "grapheme", minLength: 1 }), (a, b) => {
        expect(sameName(a, b)).toBe(foldSlow(a) === foldSlow(b));
      }),
    );
  });

  it("finds a name equal to each change of its case", () => {
    fc.assert(
      fc.property(fc.mixedCase(fc.constantFrom("octo/app", "mark-1", "renovate[bot]")), (name) => {
        expect(sameName(name, name.toLowerCase())).toBe(true);
        expect(sameName(name.toUpperCase(), name)).toBe(true);
      }),
    );
  });

  it("does not make a letter from a character that only looks like the letter", () => {
    // U+212A is the Kelvin sign. The full lower case of JavaScript changes it to the letter k.
    expect("K".toLowerCase()).toBe("k");
    expect(sameName("marK", "mark")).toBe(false);
    expect(sameName("marK", "marK")).toBe(false);
    // U+FF4F is the full-width small letter o.
    expect(sameName("octo/app", "ｏcto/app")).toBe(false);
  });

  it("finds an empty name and a value that is not text equal to nothing", () => {
    expect(sameName("", "")).toBe(false);
    expect(sameName(null, null)).toBe(false);
    expect(sameName(undefined, undefined)).toBe(false);
    expect(sameName(1, 1)).toBe(false);
    expect(sameName("a", null)).toBe(false);
  });
});

describe("runLabel and parseRunLabel", () => {
  it("reads each label that it gives", () => {
    fc.assert(
      fc.property(id, id, (runId, runAttempt) => {
        expect(parseRunLabel(runLabel({ runId, runAttempt }))).toEqual({ runId, runAttempt });
      }),
    );
  });

  it("gives the label of a real run", () => {
    expect(runLabel({ runId: 12345678901, runAttempt: 1 })).toBe("run-12345678901-1");
    expect(parseRunLabel("run-12345678901-2")).toEqual({ runId: 12345678901, runAttempt: 2 });
  });

  it("reads only a label that runLabel gives", () => {
    const near = fc.oneof(
      fc.string(),
      fc.stringMatching(/^run-[0-9]{1,18}-[0-9]{1,18}$/),
      fc.stringMatching(/^[ rR]?run-[0-9]{1,6}-[0-9]{1,6}[ \n-]?[0-9]?$/),
    );
    fc.assert(
      fc.property(near, (label) => {
        const parts = parseRunLabel(label);
        if (parts !== null) expect(runLabel(parts)).toBe(label);
      }),
    );
  });

  it("refuses a label with a zero at the start, a number that is too large, and other text", () => {
    for (const label of [
      "run-0-1",
      "run-1-0",
      "run-01-1",
      "run-1-01",
      "run-9007199254740992-1",
      "run-1-9999999999999999",
      "run-1",
      "run-1-1-1",
      "Run-1-1",
      " run-1-1",
      "run-1-1\n",
      "run--1-1",
      "run-1.5-1",
      "run-1e3-1",
      "home-small",
      "",
    ]) {
      expect(parseRunLabel(label), label).toBeNull();
    }
    expect(parseRunLabel("run-9007199254740991-1")).toEqual({ runId: Number.MAX_SAFE_INTEGER, runAttempt: 1 });
    expect(parseRunLabel(7 as unknown as string)).toBeNull();
  });

  it("throws for an id that is not a whole number from 1", () => {
    fc.assert(
      fc.property(notAnId, id, (bad, good) => {
        expect(() => runLabel({ runId: bad as number, runAttempt: good })).toThrow(RangeError);
        expect(() => runLabel({ runId: good, runAttempt: bad as number })).toThrow(RangeError);
      }),
    );
  });
});

describe("sameRun", () => {
  const key = fc.record({
    repository: fc.mixedCase(fc.constantFrom("octo/app", "octo/lib", "other/app")),
    runId: fc.oneof(fc.constantFrom(1, 2), id),
    runAttempt: fc.constantFrom(1, 2, 3),
  });

  it("is true for a record and itself, and for each case of the repository", () => {
    fc.assert(
      fc.property(key, (a) => {
        expect(sameRun(a, a)).toBe(true);
        expect(sameRun(a, { ...a, repository: a.repository.toUpperCase() })).toBe(true);
      }),
    );
  });

  it("is true only when the repository, the id and the number of the try are the same", () => {
    fc.assert(
      fc.property(key, key, (a, b) => {
        const expected =
          a.repository.toLowerCase() === b.repository.toLowerCase() && a.runId === b.runId && a.runAttempt === b.runAttempt;
        expect(sameRun(a, b)).toBe(expected);
        expect(sameRun(b, a)).toBe(expected);
      }),
    );
  });

  it("is false for a record with a bad id, also against itself", () => {
    fc.assert(
      fc.property(key, notAnId, (a, bad) => {
        const broken = { ...a, runId: bad } as unknown as RunKey;
        expect(sameRun(broken, broken)).toBe(false);
        expect(sameRun(a, broken)).toBe(false);
        const brokenTry = { ...a, runAttempt: bad } as unknown as RunKey;
        expect(sameRun(brokenTry, brokenTry)).toBe(false);
      }),
    );
  });
});
