# Vendored docx-preview + JSZip

PARA-CODE: fork-owned directory (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

このディレクトリは npm から取得した vendored サードパーティ成果物です。Word (.docx)
ビューア（`../paradisDocxFileEditor.ts`）が webview 内で読み込み、.docx を HTML に
レンダリングします。UMD 版を classic script として読み込む方式のため、以下を使います。

- `docx-preview.min.js` — `docx-preview@0.3.7`（Apache-2.0, Volodymyr Baydalka）の
  `package/dist/` より。UMD 版。グローバル `docx` を定義し、`jszip` をグローバル
  `JSZip` として外部参照する。
- `jszip.min.js` — `jszip@3.10.1`（MIT または GPL-3.0 のデュアルライセンス。本 fork は
  MIT の下で使用）の `package/dist/` より。UMD 版。グローバル `JSZip` を定義する。
- `LICENSE-docx-preview` — docx-preview の Apache-2.0 ライセンス全文
- `LICENSE-jszip` — jszip のライセンス全文（MIT / GPL-3.0）

## 更新手順

```sh
npm pack docx-preview@<version>
tar -xzf docx-preview-<version>.tgz
cp package/dist/docx-preview.min.js .
cp package/LICENSE LICENSE-docx-preview

npm pack jszip@<version>
tar -xzf jszip-<version>.tgz
cp package/dist/jszip.min.js .
cp package/LICENSE.markdown LICENSE-jszip
```

更新時はこの README のバージョン表記も更新すること。
ビルド同梱は `build/next/index.ts` の `desktopResourcePatterns`（実リリース経路）と
`build/gulpfile.vscode.ts` の `vscodeResourceIncludes` の両方に glob 登録済み。
