# Changes

## 0.1.4

- The new entry `@mark1russell7/runner-dispatch/folder` has the folder provider. Each machine is one folder of a store, with the name of the machine.
- `createFolderProvider` writes the record of the machine, the settings of the check and then the configuration. A starter on the host starts the runner from the folder.
- `folderStatus` gives the status of a machine from the marks `started` and `exited` of the starter. A destroy of a runner that operates writes the mark `stop`.
- The port `FolderStore` is the store of the folders. The entry `testing` has `fakeFolders`, a store in memory.
- The dispatcher and the starter share no process. Thus the starter needs no token of the source.

## 0.1.3

- `summarizeMeasures` gives the summary `measure-summary/1` of the records of the machines and of the jobs.
- The summary of a span has the bounds of each quantile at the nearest rank. Each pair of bounds holds the true quantile.
- `summarizeSpans` gives the summary of one span. `SUMMARY_LEVELS` is the default levels: 0.5, 0.9 and 0.99.
- `isMachineMeasure`, `isJobMeasure` and `isMoment` examine a record that comes from a log or from JSON.
- The package depends on `@mark1russell7/rigor-statistics` for the quantiles.

## 0.1.2

- The root entry exports `isRepositoryName`. The entry `github` exports `isOrganizationName`.
- The probe of a credential of `@runner-dispatch/dispatcher` uses them to examine its settings.

## 0.1.1

- The port `JobSource` has the optional method `views`. It gives the views of the repositories of one pass, with one answer for each request.
- The dispatcher uses `views` when the source has it, and `view` for each repository when it does not.
- The GitHub source lists the runners of an organization one time for each pass. Each view of the organization then shows the same list.
- A pass for 40 repositories of an organization sends 201 requests `GET`, not 240.
