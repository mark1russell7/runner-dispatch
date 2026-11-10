import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the functions and the constants of the records, of the policy and of the check", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "CHECK_SETTINGS_FORMAT",
      "OUTSIDE_INPUT_EVENTS",
      "TRUST_RULES_FORMAT",
      "checkJob",
      "decide",
      "foldName",
      "isId",
      "jobStarted",
      "parseCheckSettings",
      "parseRunLabel",
      "parseTrustRules",
      "readJobRun",
      "runLabel",
      "sameName",
      "sameRun",
    ]);
  });
});
