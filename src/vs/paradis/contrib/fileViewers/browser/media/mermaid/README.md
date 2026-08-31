# Vendored mermaid.js

PARA-CODE: fork-owned directory (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

このディレクトリは npm から取得した vendored サードパーティ成果物です。Markdown ビューア
（`../paradisMarkdownMermaid.ts`）が ```mermaid``` コードブロックを図として描画するため、
webview 内に `<script>` の本文として読み込みます（`src` 参照ではなくインライン埋め込み。
Markdown ビューアは service worker を使わない方針のため）。

- `mermaid.min.js` — `mermaid@11.17.2`（MIT）の `package/dist/` より。UMD/classic script
  版。グローバル `mermaid` を定義する
- `LICENSE-mermaid` — mermaid 本体の MIT ライセンス全文（ファイル末尾にバンドルされた
  サードパーティコード分のライセンス表記も含む）

## 更新手順

1. `npm pack mermaid@<version>` で取得し、`package/dist/mermaid.min.js` をコピー
2. `package/LICENSE` を `LICENSE-mermaid` としてコピー
3. `../../../../../../../.eslint-allowed-javascript-files` のエントリはパス変更が無ければ
   そのまま（バージョン番号はファイル名に含まれない）
