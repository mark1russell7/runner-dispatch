#!/usr/bin/env node
/**
 * The entry of the command `runner-dispatch-measures`. It gives the arguments and the parts of Node.js to `measuresMain`.
 */
import { nodeIo } from "./cli.ts";
import { holdWhile } from "./hold.ts";
import { measuresMain } from "./measures-cli.ts";

process.exitCode = await holdWhile(() => measuresMain(process.argv.slice(2), nodeIo()));
