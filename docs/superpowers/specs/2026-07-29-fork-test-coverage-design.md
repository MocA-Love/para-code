# Para Code Fork Test Coverage Design

## 目的

Para Code が upstream VS Code に追加した機能について、壊れたときに利用者影響が大きい振る舞いをテストで直接保護する。既存実装に合わせるためだけの弱いテストや、製品ソースの文字列を検索するだけのテストは追加しない。

この作業はテストの追加と実行に限定する。追加したテストが既存の製品不具合を検出した場合も、Para Code の製品コードは修正しない。失敗内容を記録し、テストを不当に緩めない。

## 対象範囲

調査で確認した fork 固有領域を、次の3段階で扱う。

### Tier 1: 更新・データ損失・遠隔操作・セキュリティ境界

- Cloudflare Update Worker とデスクトップ updater の契約
- 2次元ターミナルグリッドの分割、移動、サイズ、破棄
- ファイルビューアーの不正入力、サイズ制限、参照のライフサイクル
- Mobile/Relay/Protocol と PC 側 `ParadisMobileRelayService` の契約
- Workspace Switch のエディター、ターミナル、ワークスペース所有権
- Browser Mirror の対象フレーム判定と fail-closed 動作

Tier 1 は正常系だけでなく、拒否、欠損、競合、再接続、破棄のテストを置く。

### Tier 2: 永続化・外部プロセス・集計

- Browser bookmarks のモデル、HTML import/export、永続化
- Notifications/Aivis のスケジューリング、再試行、テンプレート、キャッシュ
- ccusage の日付、モデル分類、集計
- resource monitor のプロセス木、集計、表示閾値
- limits monitor の正規化と境界
- default extensions の VSIX 発見と導入条件
- Sentry の秘匿化とプロセス境界

Tier 2 は純粋関数だけで終えず、適切な範囲でサービス境界まで確認する。

### Tier 3: 小規模な UI/登録機能

- browser button/downloads/extensions/user-agent
- keep awake、release notes、view layout、watermark、window transparency
- terminal image paste、Shift+Enter、presets、history suggest

DOM や Electron を全面的に模倣せず、コマンド登録、設定反映、状態遷移、入力変換など、その機能固有の判断を最小の直接テストで保護する。

## テスト設計原則

1. **製品 API を直接呼ぶ。** テスト用にロジックを複製しない。
2. **壊れる条件を名前にする。** 各テスト名から、どの回帰を検出するか分かるようにする。
3. **入力と境界を明示する。** 正常、空、欠損、上限、重複、順序逆転、破棄後を必要に応じて含める。
4. **モックは外部境界だけに置く。** ネットワーク、ファイルシステム、OS/Electron、時刻は差し替えても、検証対象の製品ロジック自体はモックしない。
5. **テストのために製品 API を変更しない。** 現在公開されている振る舞いで直接テストできない UI 結線は、既存の登録情報または実際の contribution の生成を通して確認する。
6. **既存不具合を隠さない。** 新規テストが失敗した場合、製品コードを直さず、期待値が仕様と一致するかを再確認して失敗を残す。
7. **実行経路も保護する。** テストファイルが存在するだけでなく、PR 用 GitHub Actions から関連スイートが実行されることを確認する。

## レイヤー構成

### A. 純粋ロジックと状態機械

VS Code の Mocha または各 app の Vitest で、モデル変換、分類、集計、状態遷移、エラー処理を検証する。実行が速く、失敗原因を狭く特定できる層とする。

### B. サービス契約

Worker の `fetch`、IPC channel、ストレージ、参照管理、Relay の frame exchange など、実際の公開境界を呼び出す。依存先だけを fake にし、要求、応答、所有権、破棄を確認する。

### C. パッケージ・CI スモーク

release workflow、VSIX、更新成果物、app workspace のテスト起動を確認する。パッケージング全体が高コストな場合は、成果物の必須フィールドと参照先を検証する小さなスモークを置き、既存の build job に接続する。

## 実行と判定

- 各領域は、変更したテストに最も近い typecheck/compile を先に実行する。
- その後に対象テストを単独実行し、最後に同じ runner の関連スイートを実行する。
- 失敗は次のどれかに分類する。
  - テスト自身の構文、fixture、隔離不足
  - 環境依存または既存 baseline の失敗
  - 製品挙動が仕様を満たしていないことを示す失敗
- 最後の分類では製品コードを修正しない。テスト名、コマンド、失敗内容を最終報告に残す。

## 完了条件

- Tier 1 の全領域に、正常系と重要な拒否・破棄・競合系の直接テストがある。
- 調査時点でテストが0件だった fork 固有領域に、少なくとも1件の機能固有テストがある。ただし、単なる静的登録だけで完結する領域は既存の登録検査スイートにまとめてもよい。
- `app/mobile`、`app/protocol`、`app/relay`、Update Worker のテストがローカルで実行でき、PR CI の実行経路が確認できる。
- 追加・変更したテストの対象コマンドを実行し、成功または製品側の未修正失敗として分類済みである。
- 製品コード、コミット、push は作成しない。
