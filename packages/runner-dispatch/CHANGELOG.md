# Changes

## 0.1.1

- The port `JobSource` has the optional method `views`. It gives the views of the repositories of one pass, with one answer for each request.
- The dispatcher uses `views` when the source has it, and `view` for each repository when it does not.
- The GitHub source lists the runners of an organization one time for each pass. Each view of the organization then shows the same list.
- A pass for 40 repositories of an organization sends 201 requests `GET`, not 240.
