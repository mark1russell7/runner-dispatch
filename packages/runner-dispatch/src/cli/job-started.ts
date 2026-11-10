#!/usr/bin/env node
// The job-started program of a machine. The job-started script of the runner starts it with one argument,
// the path of the settings file of the machine:
//   node job-started.ts /etc/runner-dispatch/check.json
// The exit code 0 lets the job start. Each other code fails the job before its first step.
import { readFileSync } from "node:fs";
import { jobStarted } from "../job-started.ts";

const result = jobStarted(process.argv.slice(2), process.env, (path) => readFileSync(path, "utf8"));
for (const line of result.lines) console.log(line);
process.exitCode = result.code;
