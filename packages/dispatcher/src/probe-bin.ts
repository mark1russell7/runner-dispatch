#!/usr/bin/env node
/**
 * The entry of the command `runner-dispatch-probe`. It gives the arguments and the parts of Node.js to `probeMain`.
 * The first Ctrl+C stops the steps of the probe. The probe still removes its runner and its group.
 */
import { writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { nodeIo } from "./cli.ts";
import { holdWhile } from "./hold.ts";
import { probeMain } from "./probe-cli.ts";

/** This function reads all of stdin. A terminal on stdin is a mistake: the token comes through a pipe or a file. */
const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY === true) throw new Error("stdin is a terminal. Send the token to stdin through a pipe or a file.");
  return text(process.stdin);
};

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.exitCode = await holdWhile(() =>
  probeMain(
    process.argv.slice(2),
    { ...nodeIo(), readStdin, writeText: (path, content) => writeFile(path, content, "utf8") },
    { signal: controller.signal },
  ),
);
