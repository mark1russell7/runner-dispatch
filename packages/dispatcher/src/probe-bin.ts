#!/usr/bin/env node
/**
 * The entry of the command `runner-dispatch-probe`. It gives the arguments and the parts of Node.js to `probeMain`.
 * The first Ctrl+C stops the steps of the probe. The probe still removes its runner and its group.
 */
import { nodeIo } from "./cli.ts";
import { probeMain } from "./probe-cli.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.exitCode = await probeMain(process.argv.slice(2), nodeIo(), { signal: controller.signal });
