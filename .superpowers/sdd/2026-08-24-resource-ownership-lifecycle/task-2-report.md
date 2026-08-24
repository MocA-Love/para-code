# Task 2 report

- Commit: `b139f6e3 fix: terminate timed out CLI process trees before wrapper exit`
- ccusage、rtk、limitsMonitor の `execFile` を `ParadisChildProcessTreeTracker` に接続した。
- Node の `timeout` option と callback 後の tree-kill を撤去し、同期 callback race、callback disposal、timeout classification、service disposal を扱う。
- ccusage の既存 failure-suppression fixture は明示 deadline を再現するよう更新した。

Verified:

- `rtk npm run transpile-client`
- `rtk xvfb-run -a env ELECTRON_DISABLE_SANDBOX=1 ./scripts/test.sh --run src/vs/paradis/test/node/paradisKillChildProcess.test.ts --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts --run src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorCodexRemoval.test.ts` (50 passing)
- `rtk npm run typecheck-client`
- `rtk npm run eslint -- <7 task files>`
- `rtk npm run valid-layers-check`
- `rtk git diff --check -- <7 task files>`

## Review fix round 1

Changes:

- ccusage と rtk は tracker deadline 後の成功 callback も timeout failure として終端し、通常 TTL cache へ保存しない。ccusage はこの経路を `timedOut` として分類し、実際の `err` がある場合だけ `spawnFailed` を設定するため、offline retry を行わない。
- limitsMonitor の環境解決後の execFile 実行を async boundary の内側へ移し、注入した execFile の同期 throw が実行 Promise を reject して source error・inflight cleanup まで到達するようにした。
- consumer 実結線の回帰テストを追加し、同期 callback、通常 callback 後の deadline、複数 active child の dispose、ccusage/limitsMonitor probe、limitsMonitor の同期 throw と遅延環境解決×dispose を固定した。

RED evidence:

- `rtk npm run transpile-client && rtk xvfb-run -a env ELECTRON_DISABLE_SANDBOX=1 ./scripts/test.sh --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts --run src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts` — expected failure: ccusage/rtk の deadline 後 `callback(null, validStdout, '')` が `Missing expected rejection`、limitsMonitor の同期 throw が `getSnapshot` を pending のままにした（`timeout !== error`）。

GREEN / verification:

- `rtk npm run transpile-client && rtk xvfb-run -a env ELECTRON_DISABLE_SANDBOX=1 ./scripts/test.sh --run src/vs/paradis/test/node/paradisKillChildProcess.test.ts --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageChannel.test.ts --run src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts --run src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts --run src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorCodexRemoval.test.ts` — 60 passing.
- `rtk npm run typecheck-client` — pass.
- `rtk npm run eslint -- src/vs/paradis/contrib/ccusage/node/paradisCcusageChannel.ts src/vs/paradis/contrib/ccusage/test/node/paradisCcusageProcessLifecycle.test.ts src/vs/paradis/contrib/rtk/node/paradisRtkChannel.ts src/vs/paradis/contrib/rtk/test/node/paradisRtkProcessLifecycle.test.ts src/vs/paradis/contrib/limitsMonitor/node/paradisLimitsMonitorChannel.ts src/vs/paradis/contrib/limitsMonitor/test/node/paradisLimitsMonitorProcessLifecycle.test.ts` — pass.
- `rtk npm run valid-layers-check` — pass.
- `rtk git diff --check` — pass.
