# Para Code Fork Regression Tests Design

## 目的

前回の fork テスト棚卸し完了点 `acdd702de2cb` 以降に追加された Para Code 固有機能について、利用者影響が大きい回帰を製品ロジックへの直接テストで保護する。テスト追加後は対象スイートと関連スイートを実行し、実行可能性も確認する。

## 対象範囲

第1弾では、次の高リスク領域を扱う。

1. Session Resume の履歴列挙、preview、検索、パス境界、競合
2. Mobile 音声通知の購読、停止、期限切れ、送信中の重複抑止
3. Remote SSH の hook retry、gateway port 変更、設定保持、dispose
4. Relay APNs の PC 主導送信契約
5. Relay 障害報告の再接続回数閾値、理由保持、復旧・無効化時の取消
6. Process-gone 診断の正常終了除外、process 名、秘匿化
7. Webview Service Worker 監視の timeout、回復、上限、dispose
8. Heap snapshot の多重実行防止、保存先、失敗 cleanup、結果 metadata
9. Windows updater の同一 pending version 再提示時の overwrite loop 防止

前回から残る Terminal Grid、PDF/DOCX、WebRTC、bookmark schema、release artifact などは、第1弾の検証完了後に第2弾として扱う。

## テスト方針

- 製品 API または製品ロジックを直接呼び、実装をテスト内へ複製しない。
- 外部境界だけを fake にする。対象は時刻、ファイルシステム、child process、Electron event、IPC、network とする。
- private method を型キャストで直接呼ぶテストは増やさない。直接テストできない場合は、挙動を変えない純粋関数の抽出または依存注入を最小限行う。
- DOM・Electron 全体を模倣せず、固有の状態判断と lifecycle を小さな単位へ分離して検証する。
- test-first で追加し、新規抽出が必要な場合は missing API または期待する振る舞いによる失敗を先に確認する。
- 既存挙動を保護する characterization test は、一時的な mutation で失敗を確認し、元へ戻した後に再度成功させる。
- 既存の利用者作業、未追跡 HTML、無関係な upstream ファイルを変更しない。

## 領域別設計

### Session Resume

Node 側サービスを一時ディレクトリ上の Claude/Codex transcript に対して呼ぶ。正常な list/preview/search に加え、catalog 外 ID、許可 root 外、symlink 越境、巨大 transcript の切り詰め、古い検索 revision の破棄を確認する。renderer 側は resume request の組み立てを純粋な判断へ分離し、workspace switch の要否、dangerous flag、terminal 準備待ちを検証する。

### Mobile 音声通知

Relay 側の購読状態と clip 配信判断を、session sender を注入可能な小さな状態機械として直接検証する。開始、同一 SID の更新、異なる SID の停止拒否、期限切れ、offline、前回送信中、送信失敗後の解放を対象にする。Mobile 側は reconnect generation と stop 後 callback 無効化を、時刻と native bridge を差し替えて確認する。

### Remote SSH

hook 導入処理の channel、時刻、gateway endpoint を注入し、段階的 retry、成功後停止、port 変更時のみ再導入、dispose 後に再試行しないことを確認する。設定ファイル生成は既存 JSON を保持しつつ Para 固有キーだけを更新することを確認する。tunnel core の既存テストは重複せず、renderer contribution の ensure/close 配線を補う。

### Relay APNs と障害報告

APNs は online socket の存在に関係なく、PC から `push-notify` が届けば登録済み token へ送る現在の契約へ陳腐化テストを修正する。障害報告は fake clock と reporter を使い、閾値未満、閾値到達、最初の理由保持、接続復旧、機能無効化を確認する。

### Process-gone 診断

Electron event から診断 payload を作る処理を純粋化し、clean exit は生成しないこと、child process 名は `name`、`serviceName`、`type` の順で選ぶこと、renderer payload に URL・title が入らないことを確認する。event registration 自体は小さな fake app で配線を確認する。

### Webview Service Worker 監視

session event source、clock、diagnostic reporter を注入する。`starting` が猶予を超えた場合だけ報告し、`running`・削除・対象外 source で timer を解除すること、監視件数を上限内に保つこと、dispose 後に報告しないことを確認する。

### Heap snapshot

保存先、uptime、heap statistics、writer、stat、unlink を依存として分離する。多重実行拒否、Linux と他 OS の保存先、write 失敗時の部分ファイル削除、stat 失敗時 `bytes: -1`、finally による lock 解放、channel 登録を確認する。

### Windows updater

同一 pending version の判定を小さな純粋関数として抽出し、Overwriting 状態で同じ version のときだけ loop を止めることを確認する。異なる version、Ready/Idle、payload 欠損は既存 update flow を維持する。

## 並列化

ファイル競合を避けるため、次の作業単位へ分割する。

- A: Session Resume
- B: Mobile 音声通知
- C: Remote SSH
- D: Relay APNs と障害報告
- E: Process-gone と Webview Service Worker 診断
- F: Heap snapshot と Windows updater

各 subagent は担当ファイル以外を編集せず、対象テストの red/green 証跡と実行コマンドを報告する。主担当は全差分をレビューし、重複 import、layer 違反、既存変更との競合を確認してから統合検証する。

## 検証

- `app` 配下は対象 package の `pnpm` typecheck と Vitest を実行する。
- `src` 配下は変更を含む one-shot transpile または必要な typecheck の後、`scripts/test.sh` / Node Mocha の対象 selector を実行する。
- Electron main 固有テストは既存の Electron test runner を使う。環境制約で実行できない場合は、純粋化した Node test と typecheck を必須とし、未実行理由を分離して報告する。
- 最後に `git diff --check`、変更ファイル一覧、追加した全対象テスト、関連スイートを再実行する。
- コミット、push、PR 作成は行わない。

## 完了条件

- 第1弾9領域に、固有の失敗条件を直接保護する回帰テストがある。
- 追加したテストは red/green または一時 mutation によって検出能力を確認済みである。
- 対象 typecheck と対象テストの実行結果が記録されている。
- 製品コードの変更はテスト容易性のための最小限の抽出・依存注入に限定されている。
- 既存の利用者変更、コミット履歴、未追跡 HTML は変更されていない。
