# Task 1 実装報告

## 変更内容

- `ParadisMobilePcFocusHeartbeat` を追加し、モバイルリレー有効時だけPC focus heartbeatを開始するようにした。
- 無効化・画面ロック状態の変更・disposeで世代を失効させ、遅着したidle time結果を送信しないようにした。
- renderer lease待機後、IPC直前に `stillCurrent()` を再確認するpublish delegateへ結合した。
- contributionの既存focus、visibility、lock、unlock listenerは維持し、controllerを呼ぶ形に置き換えた。
- 初期設定はworkspace provider構築後に適用し、設定変更ではshared processの`setEnabled`呼び出し前にcontrollerへ同期適用するようにした。

## TDD記録

1. RED: fake interval timer、deferred idle time、制御可能なrenderer lease待機を使う4件のcontrollerテストを先に追加した。
2. RED確認: `rtk npm run transpile-client`後に新規テストmoduleをimportし、controller module不在による`ERR_MODULE_NOT_FOUND`（exit 1）を確認した。
3. GREEN: focus専用controllerとcontribution結合を追加した。
4. GREEN確認: focused suiteで4件すべてが成功した（テスト基盤のclean-state確認を含め5 passing）。

## 検証

- `rtk npm run transpile-client` — exit 0
- `rtk ./scripts/test.sh --run vs/paradis/contrib/mobileRelay/test/electron-browser/paradisMobilePcFocusHeartbeat.test.js` — exit 0、5 passing（TTYでも再確認）
- `rtk git diff --check` — 出力なし

## 自己レビュー

- CRITICAL/HIGH/MEDIUM/LOW: 指摘なし。
- 対象外のtimer、connection、protocolは変更していない。
