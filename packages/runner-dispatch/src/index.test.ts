import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the functions and the constants of the records and of the policy", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "OUTSIDE_INPUT_EVENTS",
      "TRUST_RULES_FORMAT",
      "decide",
      "foldName",
      "isId",
      "parseRunLabel",
      "parseTrustRules",
      "runLabel",
      "sameName",
      "sameRun",
    ]);
  });
});
