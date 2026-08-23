# Para Code

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.txt)
[![Issues](https://img.shields.io/github/issues/MocA-Love/para-code.svg)](https://github.com/MocA-Love/para-code/issues)

Para Code は、AI コーディングエージェント（Claude Code・Codex など）と一緒に開発することを前提に作られたエディタです。[Visual Studio Code](https://github.com/microsoft/vscode) を fork し、複数リポジトリの並行作業・常駐ターミナル・エージェントセッション管理・内蔵ブラウザ連携・SSH リモート開発・モバイルからの遠隔操作といった機能を継ぎ足してあります。

## Para Code とは

このリポジトリは `microsoft/vscode` を fork した独自エディタです。エディタ本体の土台は本家 VS Code のままで、今後も定期的に upstream の新しいリリースを取り込み続けます。そのうえに、複数のエージェントを並行して走らせながら開発する働き方に合わせた機能を追加しています。

<p align="center">
  <!-- ここにスクリーンショットを挿入 -->
</p>

## 主な機能

### スペース（ワークスペース）管理

- 複数のリポジトリ・ワークツリーを常駐させたまま、Extension Host を再起動せずに瞬時に切り替え
- リモートエクスプローラーの「Para ホスト」ビューで、手元と SSH 先を同じツリーに並べて操作
- SSH 先とのファイル送受信・ドラッグ&ドロップ・複数ファイルのアップロードにも対応

### ターミナル

- 縦横自由な田の字型（2D グリッド）分割
- 「常駐ターミナル」でウィンドウや Para Code 自体を閉じても実行中のプロセスが動き続け、次回起動時にそのまま繋ぎ直せる（macOS / Linux）
- Superset 相当のターミナル履歴サジェストなど、日々のシェル操作を補う拡張

### AI エージェント連携

- Claude Code・Codex など複数のエージェントセッションを一覧・絞り込み・履歴検索
- 通知（音声報告・サウンド・おやすみモード）とユーザー辞書
- 使用量ダッシュボード（コスト/トークン切り替え）や RTK のトークン節約ダッシュボード
- 実行環境（手元／特定の SSH 接続先など）に応じて出し分けられるコマンドプリセット

### 内蔵ブラウザ

- CDP で繋いだブラウザタブとエージェントセッションを紐づけ、エージェントが見ている画面を可視化・共有
- 複数ペインの一覧化・絞り込み・ズーム操作

### ファイルビューア / Git

- Markdown・HTML・PDF・Excel・Word の独自プレビュー（相対パスの画像・実行中の読み込みにも対応）
- Excel・Word の変更点を左右に並べて見られる差分ビュー
- ソース管理に分岐元ブランチからの差分を独立して表示する「ブランチの変更点」ビュー、GitHub Issue 連携

### モバイル（Para Code Mobile）

- iPhone / iPad から、PC 上で動いているエージェントセッションを遠隔で確認・操作

各バージョンで実際に何が変わったかは、アプリ内の歯車メニュー →「更新履歴」から確認できます。

## 開発に参加する

Para Code は本家 VS Code のソースをベースにしているため、ビルド・デバッグの基本的な流れは [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) や [Coding Guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines) がそのまま参考になります。そのうえで、この fork 特有の実装ルール（新機能の置き場所・既存ファイルへのパッチ方針・upstream 取り込み手順など）は [`CLAUDE.md`](CLAUDE.md) と [`NOTES.md`](NOTES.md) にまとめてあるので、変更を加える前に一読してください。

* [問題や要望を報告する](https://github.com/MocA-Love/para-code/issues)
* [変更を提案する](https://github.com/MocA-Love/para-code/pulls)

## フィードバック

* [Issue を立てる](https://github.com/MocA-Love/para-code/issues)
* 本家 VS Code 自体の不具合・要望は [microsoft/vscode](https://github.com/microsoft/vscode/issues) 側へ

## 本家 VS Code との関係

Para Code は `microsoft/vscode` を upstream として fetch し続けている fork です。エディタのコア機能（言語サポート、デバッグ、拡張機能 API など）は本家の開発にそのまま追従し、Para Code 独自の機能はなるべく新規ファイル・薄いフックポイントだけで完結させる方針で実装しています。本家の関連プロジェクト一覧は [Related Projects](https://github.com/microsoft/vscode/wiki/Related-Projects) を参照してください。

## 同梱拡張機能

[extensions](extensions) フォルダには、多言語対応の文法・スニペットなどを提供する組み込み拡張機能が含まれます（本家由来）。加えて Para Code では、Open VSX に未公開のいくつかのサードパーティ拡張機能を VSIX として同梱し、起動時に自動インストールする仕組みを備えています。拡張機能の取得元は Open VSX Registry です。

## 開発コンテナ

このリポジトリには Visual Studio Code Dev Containers / GitHub Codespaces 用の開発コンテナ設定が含まれています。

* Dev Containers を使う場合は、Docker と VS Code（または Para Code）をインストールしたうえで **Dev Containers: Clone Repository in Container Volume...** コマンドを実行してください。
* Codespaces を使う場合は、GitHub Codespaces 拡張機能をインストールし、**Codespaces: Create New Codespace** コマンドを実行してください。

フルビルドには最低でも **4 コア・6 GB の RAM（推奨 8 GB）** が必要です。詳細は [development container README](.devcontainer/README.md) を参照してください。

## 行動規範

このプロジェクトに参加するすべての人は、互いに敬意を持って接してください。攻撃的な言動やハラスメントは認められません。問題があれば Issue で報告してください。

## ライセンス

Copyright (c) 2015 - present Microsoft Corporation.
Para Code による追加・変更部分も含め、[MIT](LICENSE.txt) ライセンスの下で公開されています。
