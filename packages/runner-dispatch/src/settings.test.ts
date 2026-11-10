import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { runLabel } from "./records.ts";
import {
  DISPATCH_CAPACITY_MAX,
  DISPATCH_SETTINGS_FORMAT,
  machineName,
  parseDispatchSettings,
  parseMachineName,
  runnerLabels,
  settingsProblems,
  sizeOfLabels,
  type DispatchSettings,
} from "./settings.ts";

const SETTINGS: DispatchSettings = { prefix: "rd", capacity: 4, sizes: ["small", "large"], standard: "small" };
const DOC = { format: DISPATCH_SETTINGS_FORMAT, ...SETTINGS };
const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const prefix = fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/);
const suffix = fc.stringMatching(/^[0-9a-f]{8}$/);

describe("parseDispatchSettings", () => {
  it("reads a valid document, and the settings do not change after it", () => {
    const sizes = ["small", "large"];
    const result = parseDispatchSettings({ ...DOC, sizes });
    expect(result).toEqual({ ok: true, settings: SETTINGS });
    sizes.push("huge");
    if (!result.ok) throw new Error("The document is valid.");
    expect(result.settings.sizes).toEqual(["small", "large"]);
    expect(Object.isFrozen(result.settings)).toBe(true);
    expect(Object.isFrozen(result.settings.sizes)).toBe(true);
  });

  it("reads the limits of each field", () => {
    const limits = { format: DISPATCH_SETTINGS_FORMAT, prefix: "a234567890123456", capacity: DISPATCH_CAPACITY_MAX, sizes: [`s${"-".repeat(31)}`], standard: `s${"-".repeat(31)}` };
    expect(parseDispatchSettings(limits).ok).toBe(true);
    expect(parseDispatchSettings({ ...DOC, prefix: "a", capacity: 1 }).ok).toBe(true);
  });

  const bad: readonly (readonly [string, unknown, readonly string[]])[] = [
    ["a value that is not an object", [DOC], ["The document is not an object."]],
    ["no value", null, ["The document is not an object."]],
    ["a different format", { ...DOC, format: "dispatch-settings/2" }, ['The field format is not "dispatch-settings/1".']],
    ["an unknown field", { ...DOC, sizeDefault: "small" }, ['The document has the unknown field "sizeDefault".']],
    ["a prefix with a capital letter", { ...DOC, prefix: "Rd" }, ['The field prefix is not a small letter, then 15 small letters or digits at most: "Rd".']],
    ["a prefix with a hyphen", { ...DOC, prefix: "r-d" }, ['The field prefix is not a small letter, then 15 small letters or digits at most: "r-d".']],
    ["a prefix of 17 characters", { ...DOC, prefix: "a2345678901234567" }, ['The field prefix is not a small letter, then 15 small letters or digits at most: "a2345678901234567".']],
    ["a prefix that starts with a digit", { ...DOC, prefix: "1rd" }, ['The field prefix is not a small letter, then 15 small letters or digits at most: "1rd".']],
    ["a capacity of 0", { ...DOC, capacity: 0 }, ["The field capacity is not a whole number from 1 to 1000: a value of the type number."]],
    ["a capacity above the limit", { ...DOC, capacity: DISPATCH_CAPACITY_MAX + 1 }, ["The field capacity is not a whole number from 1 to 1000: a value of the type number."]],
    ["a capacity that is a text", { ...DOC, capacity: "4" }, ['The field capacity is not a whole number from 1 to 1000: "4".']],
    ["no size", { ...DOC, sizes: [] }, ["The field sizes is not a list with an entry.", 'The field standard is not a size of the list sizes: "small".']],
    ["sizes that are not a list", { ...DOC, sizes: "small" }, ["The field sizes is not a list with an entry.", 'The field standard is not a size of the list sizes: "small".']],
    ["a size that is a run label", { ...DOC, sizes: ["small", "run-1-1"] }, ['The entry 1 of sizes is not the name of a size, or it is a run label: "run-1-1".']],
    ["a size with a capital letter", { ...DOC, sizes: ["small", "Large"] }, ['The entry 1 of sizes is not the name of a size, or it is a run label: "Large".']],
    ["a size of 33 characters", { ...DOC, sizes: ["small", `s${"-".repeat(32)}`] }, [`The entry 1 of sizes is not the name of a size, or it is a run label: "s${"-".repeat(32)}".`]],
    ["a size that starts with a digit", { ...DOC, sizes: ["small", "2xlarge"] }, ['The entry 1 of sizes is not the name of a size, or it is a run label: "2xlarge".']],
    ["a size two times", { ...DOC, sizes: ["small", "large", "small"] }, ['The entry 2 of sizes is in the list two times: "small".']],
    ["a standard size that is not in the list", { ...DOC, standard: "huge" }, ['The field standard is not a size of the list sizes: "huge".']],
    ["no standard size", { format: DOC.format, prefix: "rd", capacity: 4, sizes: ["small"] }, ["The field standard is not a size of the list sizes: a value of the type undefined."]],
  ];
  for (const [name, value, problems] of bad) {
    it(`gives the problems of a document with ${name}`, () => {
      expect(parseDispatchSettings(value)).toEqual({ ok: false, problems });
    });
  }

  it("gives each problem of a document, not only the first", () => {
    const result = parseDispatchSettings({ format: "x", prefix: 1, capacity: 1.5, sizes: [1], standard: 2, more: true });
    expect(result.ok ? [] : result.problems).toHaveLength(6);
  });

  it("gives the same problems for a record of settings, with no format", () => {
    expect(settingsProblems(SETTINGS)).toEqual([]);
    expect(settingsProblems({ ...SETTINGS, capacity: 0 })).toEqual(["The field capacity is not a whole number from 1 to 1000: a value of the type number."]);
    expect(settingsProblems("rd")).toEqual(["The settings are not an object."]);
  });
});

describe("machineName and parseMachineName", () => {
  it("gives the prefix, the run, the try and the suffix", () => {
    expect(machineName("rd", { runId: 100, runAttempt: 2 }, "0000abcd")).toBe("rd-100-2-0000abcd");
    expect(parseMachineName("rd", "rd-100-2-0000abcd")).toEqual({ runId: 100, runAttempt: 2 });
  });

  it("reads each name that it gives, and the name is not longer than a runner name of GitHub", () => {
    fc.assert(
      fc.property(prefix, id, id, suffix, (first, runId, runAttempt, last) => {
        const name = machineName(first, { runId, runAttempt }, last);
        expect(name.length).toBeLessThanOrEqual(64);
        expect(parseMachineName(first, name)).toEqual({ runId, runAttempt });
      }),
    );
  });

  it("gives each name that it reads", () => {
    const part = fc.oneof(fc.constantFrom("rd", "100", "2", "0000abcd", "run", "01", "0", "ABCDEF00", "rd2"), fc.string({ maxLength: 12 }));
    fc.assert(
      fc.property(fc.array(part, { minLength: 1, maxLength: 6 }), (parts) => {
        const name = parts.join("-");
        const read = parseMachineName("rd", name);
        if (read === null) return;
        expect(machineName("rd", read, name.slice(-8))).toBe(name);
      }),
      { numRuns: 2000 },
    );
  });

  const notNames: readonly string[] = [
    "rd-100-2",
    "rd-100-2-0000abcd-1",
    "rdx-100-2-0000abcd",
    "RD-100-2-0000abcd",
    "rd-0-2-0000abcd",
    "rd-100-0-0000abcd",
    "rd-0100-2-0000abcd",
    "rd-100-2-0000ABCD",
    "rd-100-2-0000abc",
    "rd-100-2-0000abcde",
    "rd-1e2-2-0000abcd",
    "rd--2-0000abcd",
    "run-100-2",
    "",
  ];
  for (const name of notNames) {
    it(`does not read the name ${JSON.stringify(name)}`, () => {
      expect(parseMachineName("rd", name)).toBeNull();
    });
  }

  it("does not read the name of a different dispatcher, or a value that is not a text", () => {
    expect(parseMachineName("ci", "rd-100-2-0000abcd")).toBeNull();
    expect(parseMachineName("r", "rd-100-2-0000abcd")).toBeNull();
    expect(parseMachineName("Rd", "Rd-100-2-0000abcd")).toBeNull();
    expect(parseMachineName("rd", 5 as unknown as string)).toBeNull();
    expect(parseMachineName(5 as unknown as string, "rd-100-2-0000abcd")).toBeNull();
  });

  it("refuses a part that is not valid, with the part in the message", () => {
    const run = { runId: 100, runAttempt: 2 };
    expect(() => machineName("Rd", run, "0000abcd")).toThrow(new RangeError("The prefix of a machine name is not valid."));
    expect(() => machineName("r-d", run, "0000abcd")).toThrow(new RangeError("The prefix of a machine name is not valid."));
    const ids = new RangeError("A machine name needs the id of the run and the number of its try, each a whole number from 1.");
    expect(() => machineName("rd", { runId: 0, runAttempt: 2 }, "0000abcd")).toThrow(ids);
    expect(() => machineName("rd", { runId: 100, runAttempt: 1.5 }, "0000abcd")).toThrow(ids);
    const digits = new RangeError("The suffix of a machine name is not 8 digits of base 16 in small letters.");
    expect(() => machineName("rd", run, "0000ABCD")).toThrow(digits);
    expect(() => machineName("rd", run, "abc")).toThrow(digits);
    expect(() => machineName("rd", run, "0000abcd-")).toThrow(digits);
  });
});

describe("sizeOfLabels and runnerLabels", () => {
  const label = runLabel({ runId: 100, runAttempt: 1 });
  const rows: readonly (readonly [readonly string[], string | null])[] = [
    [[label], "small"],
    [[label, label], "small"],
    [[label, "small"], "small"],
    [[label, "large"], "large"],
    [["large", label, "large"], "large"],
    [[label, "small", "large"], null],
    [[label, "Large"], null],
    [[label, "gpu"], null],
    [[label, "run-100-2"], null],
    [["large"], null],
    [["run-100-2"], null],
    [[], null],
  ];
  for (const [labels, size] of rows) {
    it(`gives ${String(size)} for the labels ${JSON.stringify(labels)}`, () => {
      expect(sizeOfLabels(SETTINGS, label, labels)).toBe(size);
    });
  }

  it("gives the standard size to a job that names no size, also when it is not the first size", () => {
    expect(sizeOfLabels({ ...SETTINGS, standard: "large" }, label, [label])).toBe("large");
  });

  it("gives no size for labels that are not a list", () => {
    expect(sizeOfLabels(SETTINGS, label, label as unknown as string[])).toBeNull();
    expect(sizeOfLabels(SETTINGS, label, [label, 5 as unknown as string])).toBeNull();
  });

  it("gives the run label and the size as the labels of the runner", () => {
    expect(runnerLabels(label, "large")).toEqual([label, "large"]);
  });

  it("serves a job only when a runner of the size has each label of the job", () => {
    const pool = [label, "small", "large", "gpu", "run-100-2"];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...pool), { maxLength: 4 }), fc.constantFrom(...SETTINGS.sizes), (labels, size) => {
        const runner = runnerLabels(label, size);
        const takes = labels.includes(label) && labels.every((each) => runner.includes(each));
        const served = sizeOfLabels(SETTINGS, label, labels);
        const names = labels.filter((each) => each !== label);
        expect(takes).toBe(served !== null && (names.length === 0 || served === size));
      }),
      { numRuns: 1000 },
    );
  });
});
