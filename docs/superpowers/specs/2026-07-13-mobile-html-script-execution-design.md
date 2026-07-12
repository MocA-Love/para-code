# Mobile HTML Script Execution Design

## Goal

Para Code Mobileで、ペアリング済みワークスペースから開くHTMLファイルをPC版と同様にスクリプト実行付きでレンダーする。

## Scope

- 通常のファイルビューアで `.html`、`.htm`、`.xhtml` のスクリプトを実行する。
- SCM差分ビューアのレンダー表示でも同じ拡張子のスクリプトを実行する。
- Markdown、画像、動画・音声、PDF、Raw表示は既存の実行可否を変えない。

## Design

WebViewのJavaScript有効化条件を純粋関数へ集約し、通常ビューアと差分ビューアが共有する。HTMLはペアリング済みPCのワークスペース内で開く信頼済みコンテンツとして扱う。WebViewにはネイティブ操作や認証情報へ到達するメッセージブリッジを追加しない。

## Verification

単体テストでHTMLのレンダー時だけJavaScriptを有効にすること、既存のスプレッドシート・Word・検索行ジャンプの条件を保つこと、差分ビューアもHTMLとスプレッドシートだけを許可することを確認する。モバイルの型チェックと既存単体テストを実行する。
