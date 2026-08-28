# Office Viewer Final Safety Remediation Report

## Scope

Review基点 `0e50ffc65dcf9a0cede77df3701e8f641403d763` に対し、研究段階のsemantic renderer、remote broker、mobile transportを完成扱いせず、既存経路をfail-closedにする最小修正を行った。legacy renderer、spreadsheet diagonal、Word Drawing geometryの実装は変更していない。

## Change list

- 製品既定値を `paradis.officeViewer.engine=legacy` に戻した。ユーザー/ワークスペースが明示した `v1` 実験設定は維持した。
- local/production remote backendのadvertised operationsを実装済みの `inspect/open/close/cancel` に限定し、channel negotiationとremote client routeへ引き継いだ。未実装operationは `featureUnsupported` で明示的に失敗する。
- capability bit交渉はclient/backendの積集合を維持し、Web summaryは `degraded` / `semanticCompleteness=false`、mobile hostはfeature bits `0` を広告する。desktop editor選択は `platformBackend` も確認する。
- WebWorker result全体を `PARADIS_OFFICE_LIMITS.maxSerializedResponseBytes` で送信前・受信時に検査し、超過を `limitExceeded` にした。Word summaryのstory/drawing/diagonal上限超過も `truncated` に集約した。
- Web diagnostic DOMにtruncation、external relationship、drawing placeholder、non-terminal diffを明示した。
- remote client disposeで所有中requestをcancelし、所有handleを一度だけcloseする。remote runtime disposeでworkerに加えてhandle store/cache/timerを破棄し、二重disposeを無害化した。
- mobileで `.xlsx/.xlsm/.xltx/.xltm/.docx/.docm/.dotx/.dotm` を既存Office safe view経路へ分類した。新しいhello/relay UIは追加していない。
- acceptance checkerはall-not-run safe-fallbackにaction/reasonと実在する `source=path#symbol` を要求する。既存173行は証跡未達のまま拒否し、対応表を捏造していない。
- geometry bytesのgolden API/fixture/test名をserialized geometryへ変更し、pixel diffとは呼ばない。実runtime pixel比較Gateは未実施・利用不可と文書化した。
- local file/sealed spool `open` の `engineCrashed` はElectron renderer test hostの`worker_threads`非対応に由来すると特定した。実worker経路をNode 24 runnerで検証し、renderer runnerでは既存worker-host smoke testと同じruntime fenceを適用した。

## RED → GREEN

| Area | RED | GREEN evidence |
| --- | --- | --- |
| Legacy default | configuration/dual-readが既定 `v1` を返した | capabilities 32 passing、dual-read 5 passing |
| Truthful operations | production local/remoteが全10 operationを広告した | channel 35 passing、server channel 9 passing |
| Platform selection | `platformBackend=false`でもdesktop v1 editorが有効だった | spreadsheet inspector 19 passing、Word inspector 12 passing |
| Worker aggregate limit | aggregate OOXMLとmessage exact/+1のguardがなかった | browser 12 passing（actual OOXML、exact 2 MiB、+1） |
| Summary diagnostics | truncation/external/drawing/non-terminalがDOMに出なかった | browser DOM test passing |
| Remote lifecycle | dispose後もowned request/handle/cacheが残った | Git source 18 passing、server runtime dispose test passing |
| Mobile recognition | 8 extension classifierが存在しなかった | mobile capability 20 passing |
| Matrix evidence | sourceなしall-not-run fallbackをcheckerが受理した | checker 3 passing、現行173行matrixはexpected exit 1 |
| Geometry naming | serialized geometry byte checkをvisual/pixel diffとして表現した | performance 10 passing、docs/fixture/APIをserialized geometryへ改称 |
| Local/spool open | Electron renderer runnerで`engineCrashed` | Node 24 runner 35 passing（local file/spool openを含む）、Electron runner 35 passing（runtime-inapplicable cases fenced） |

## Verification gates

- `npm run typecheck-client`: exit 0
- `npm run transpile-client`: exit 0
- `npm run valid-layers-check`: exit 0
- Office browser: 12 passing
- Office capabilities: 32 passing
- Office dual read: 5 passing
- Spreadsheet inspector: 19 passing
- Word inspector: 12 passing
- Office Git/remote client: 18 passing
- Office channel Electron runner: 35 passing
- Office channel Node 24 runner: 35 passing
- Office server channel: 9 passing
- Office performance/serialized geometry: 10 passing
- Mobile Office relay: 8 passing
- Mobile capability classifier: 20 passing
- Matrix checker unit tests: 3 passing
- `git diff --check`: exit 0

## Unresolved / intentionally unavailable

- 完全なsemantic production renderer、remote semantic operation群、mobile semantic relay UI/transportは今回のscope外であり、advertisement/selection上は利用不可またはdegradedのまま。
- 実desktop/Web/remote/mobile runtimeのpixel比較Gateは未実施・利用不可。serialized geometry invariantはその代替ではない。
- `docs/office-viewer-acceptance-matrix.md` の既存173行は実在source証跡がなく、checkerは意図どおりexit 1。個別のfixture/unit/runtime/source証跡が揃うまでGate未達。
- mobile全体の `tsc --noEmit` は既存 `src/relayClientPresence.test.ts` のundefined検査13件でexit 2。今回変更したOffice classifier testは20 passing。
