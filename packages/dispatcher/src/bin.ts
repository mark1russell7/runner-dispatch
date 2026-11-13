#!/usr/bin/env node
/**
 * The entry of the command `runner-dispatch`. It gives the arguments and the parts of Node.js to `main`.
 * After a run, the service ends the process. After a check or a problem, the exit code of `main` ends it.
 */
import { main, nodeIo } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2), nodeIo());
