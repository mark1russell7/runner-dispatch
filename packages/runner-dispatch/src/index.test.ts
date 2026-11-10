import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the functions and the constants of the records, of the policy, of the check, of the life of a machine and of the dispatcher", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "CHECK_SETTINGS_FORMAT",
      "DISPATCH_CAPACITY_MAX",
      "DISPATCH_SETTINGS_FORMAT",
      "EMPTY_STATE",
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
      "createDispatcher",
      "decide",
      "due",
      "foldName",
      "isId",
      "jobStarted",
      "longestLife",
      "machineName",
      "parseCheckSettings",
      "parseDispatchSettings",
      "parseMachineName",
      "parseMachineTimes",
      "parseRunLabel",
      "parseTrustRules",
      "plan",
      "readJobRun",
      "runLabel",
      "runnerLabels",
      "sameName",
      "sameRun",
      "sizeOfLabels",
      "startLife",
      "waitOf",
    ]);
  });
});
