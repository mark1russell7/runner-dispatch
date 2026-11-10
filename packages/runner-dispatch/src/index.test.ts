import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the functions and the constants of the records, of the policy, of the check and of the life of a machine", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "CHECK_SETTINGS_FORMAT",
      "MACHINE_ACTIONS",
      "MACHINE_EVENTS",
      "MACHINE_LIFECYCLE",
      "MACHINE_STATES",
      "MACHINE_TIMES_FORMAT",
      "MACHINE_TIME_MAX",
      "OUTSIDE_INPUT_EVENTS",
      "TRUST_RULES_FORMAT",
      "advance",
      "checkJob",
      "decide",
      "due",
      "foldName",
      "isId",
      "jobStarted",
      "longestLife",
      "parseCheckSettings",
      "parseMachineTimes",
      "parseRunLabel",
      "parseTrustRules",
      "readJobRun",
      "runLabel",
      "sameName",
      "sameRun",
      "startLife",
      "waitOf",
    ]);
  });
});
