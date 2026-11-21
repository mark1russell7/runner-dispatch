#!/usr/bin/env node
/**
 * The entry of the command `runner-dispatch-starter`. It gives the arguments and the parts of Node.js to `starterMain`.
 */
import { nodeIo } from "./cli.ts";
import { holdWhile } from "./hold.ts";
import { starterMain } from "./starter-cli.ts";

process.exitCode = await holdWhile(() => starterMain(process.argv.slice(2), nodeIo()));
