import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("the home page", () => {
  it("names the package and gives the install command", () => {
    expect(page).toContain("<title>runner-dispatch</title>");
    expect(page).toContain("pnpm add @mark1russell7/runner-dispatch");
  });

  it("links to the pages of site-pages and to the repository", () => {
    expect(page).toContain('href="./releases/"');
    expect(page).toContain('href="./status/"');
    expect(page).toContain('href="https://github.com/mark1russell7/runner-dispatch"');
  });

  it("has the elements of the two demos", () => {
    for (const id of ["scenarios", "run-form", "rules", "verdict", "checks", "states", "timer-text", "delay", "events", "wait", "restart", "log", "times"]) {
      expect(page).toContain(`id="${id}"`);
    }
    for (const field of ["repository", "event", "headRepository", "actor", "triggeringActor", "attempt"]) {
      expect(page).toContain(`<label for="f-${field}">`);
      expect(page).toContain(`id="f-${field}"`);
    }
  });
});
