# CI record

## dc61098 carries a change its message does not describe

That commit is titled for the `.gitmodules` fix and says nothing about the seven lines it also
adds to `.github/workflows/deploy-client.yml`: a `timeout-minutes: 30` on the build job.

The omission was mechanical and it is worth writing down because the project's rules name this
exact failure. Both files were staged together; the message was then written for one of them and
`git commit` took the whole index. The rule that would have caught it -- re-read the file against
your own message before committing -- was not applied, and the commit was pushed before the
discrepancy was noticed, so the message cannot be amended without rewriting published history.

### What the undescribed change is, and why

Run 34809351297 (2026-09-14, `feature/remote-assets`) sat in the `Test` step from 05:22:53 to
11:21:46 and was killed by the platform's six-hour maximum. `Build`, `configure-pages` and
`upload-pages-artifact` never ran, so that push produced no deployment and the failure took six
hours to become visible. Install, typecheck and test measured about two minutes on the same run
before it stalled, so thirty minutes is an order of magnitude of headroom.

This does not fix whatever hung. `yarn test` already runs with `CI: true` and `--watchAll=false`,
which is the watch-mode trap this project has recorded twice, so the likelier shape is a jest run
that finishes its tests and does not exit -- the local suite has printed "Jest did not exit one
second after the test run has completed" in this tree. The timeout is what makes the next run's log
arrive in minutes instead of a morning.
