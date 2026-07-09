# Parachan ワークスペース切り替えショートカット設計

## 目的

macOS で登録済みワークスペースを `Control+1` から `Control+9` で直接切り替えられるようにする。Parachan の切り替え操作は、同じキーを使う既存のデフォルトキーバインドより優先する。

## 現状

`paradis.workspaceSwitch.switchToRepository1` から `paradis.workspaceSwitch.switchToRepository9` は、登録済みリポジトリの1番目から9番目を直接開く。現在の既定キーは以下のとおり。

- macOS: `Control+Command+1` から `Control+Command+9`
- Windows/Linux: `Ctrl+Alt+1` から `Ctrl+Alt+9`

macOS の1番目と9番目は upstream のエディタグループ移動と競合するため、現在も標準の Workbench contribution より1段高い weight を使用している。

## 採用する設計

既存の9個の `Action2` コマンドと切り替え処理は再利用し、キーバインド記述だけを変更する。

- macOS の primary を `Control+1` から `Control+9` にする。
- 現在の `Control+Command+1` から `Control+Command+9` は secondary として残す。
- Windows/Linux の `Ctrl+Alt+1` から `Ctrl+Alt+9` は変更しない。
- fork 内の既存デフォルト、upstream のデフォルト、拡張機能が提供するデフォルトより後に評価される fork 専用 weight を使用する。
- `keybindings.json` でユーザーが追加・削除した割り当ては、従来どおりデフォルトより優先する。

キー定義は小さな fork-owned helper に分離し、アクション登録とテストの両方から利用する。これにより、ワークスペース切り替えサービスや共通のキー解決基盤は変更しない。

## 競合時の動作

デフォルトキーバインド同士で `Control+数字` が競合した場合、Parachan のワークスペース切り替えを選ぶ。ユーザー設定はデフォルトより後に解決されるため、ユーザーが明示的に別コマンドへ割り当てた場合や Parachan の割り当てを削除した場合は、その指定を尊重する。

## エラー処理

指定番号に対応する登録済みリポジトリが存在しない場合は、現在と同様に何もしない。通知やエラーは追加しない。切り替え先が存在する場合は、既存の `switchRepository` をそのまま呼び出す。

## テスト

以下を対象とする単体テストを追加する。

1. macOS では `Control+数字` が primary、`Control+Command+数字` が secondary になる。
2. Windows/Linux の primary は従来の `Ctrl+Alt+数字` のままである。
3. 同じ `Control+数字` を持つ低い優先度のデフォルトコマンドがあっても、Parachan のコマンドが解決される。
4. 1番目と9番目だけでなく、1から9まで同じ規則で生成される。

対象テストを先に失敗させた後、最小の実装で通し、関連するキー解決テストと型チェックを実行する。

## ユーザー向け変更

更新履歴の「未リリース」へ、macOS で `Control+1〜9` によりワークスペースを直接切り替えられることを追記する。

## 対象外

- リポジトリの並び順や登録方法の変更
- worktree を番号で直接選ぶ機能
- `Control+[` / `Control+]` による前後移動の変更
- ユーザー定義キーバインドより強制的に優先する仕組み
- ワークスペース切り替えサービスや VS Code のキー解決基盤の改変
