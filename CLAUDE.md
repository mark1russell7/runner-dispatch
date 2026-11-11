# Instructions for Claude

## Writing style

Write all prose of this repository in the style of ASD-STE100 Simplified Technical English (STE). This prose is the README files, this file, the TSDoc comments and the text that the site shows. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it.

- After a change to prose, start `pnpm lint:ste` and correct each finding. CI fails when there is an error.
- Keep each instruction to 20 words or fewer, and each description to 25 words or fewer.
- Do not use the modal verbs (`should`, `may`, `might`, `would`), semicolons or Latin abbreviations (`e.g.`, `i.e.`, `etc.`).
- Use the active voice. Start each sentence of a doc comment with its subject: "This function returns the value", not "Returns the value".
- Put code, file names and commands in code font. The linter counts each code span as one word.
- Add a word to the glossary in `ste.config.json` only if it is a real technical term of the project.

## Where code lives

- Each area of code has one home package. Before you write a helper, find its home with `pnpm exec conventions map <words>`.
- If the home does not have the function, add the function to the home in a pull request. Do not make a local copy.
- Do not make a new package for an area that has a home. Ask the maintainer first.
- In a review, report each new function that belongs in another home.

## Packages

- Make a new package with `pnpm package add <name> --preset=<preset>`. Do not write `package.json` or `tsconfig.json` by hand.
- Make a server package with `--preset=service`. Only its entry `src/main.ts` uses `run()` of `@mark1russell7/service`.
- A package is a source package. Its `main` is `src/index.ts`, so other packages import its source.
- Each package has a `tsconfig.test.json`. `pnpm typecheck` checks the source and the tests.
- Each public package has a report of its API in `test/api/public-api.txt`. CI fails when the report is not current.
- After a change of a public API, build, start `pnpm exec api-report update`, and commit the report with the change.
- `pnpm check:conventions` examines the rules of this file that a script can examine. CI fails on a break. `pnpm exec conventions --list` shows the rules.
- To keep an exception to a rule, write it with its reason in the field `conventions` of the root `package.json`.

## CI

- The workflows use the shared workflows and actions of the template. `CI.md` tells their inputs.
- Change a shared workflow only in `~/git/template`. A repository changes only the inputs of its callers.

## npm releases

- Do not publish to npm, and do not change npm settings. The owner and one named Claude session do all npm work.
- Do not edit `.github/workflows/release.yml` or `scripts/release/`.
- Is a package that is not on npm a block? Use `workspace:*`, or a `github:` specifier pinned to a commit.
- `RELEASING.md` tells how a release and a new package work.
