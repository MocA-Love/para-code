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

## 既知のバグへの手動パッチ（`docx-preview.min.js`、2026-07-06）

`docx-preview@0.3.7`（GitHub `master` の現行実装でも同様、未修正）の
`HtmlRenderer.levelTextToContent()` は、番号付き/箇条書きリストの CSS `content` 値を
テンプレートリテラルの二重ネストで組み立てており、生成される値が
`content: ""counter(docx-num-5-0, decimal)"".\9";` のような不正な CSS になる
（`counter()` 呼び出しをクォートで囲んでしまい、さらに外側からもクォートしている）。
ブラウザはこの `content` 宣言をパースエラーとして無視し（計算値は `content: none`）、
**番号・箇条書きの記号が一切表示されない**。

この関数の実装を、正しい CSS（`counter(...)` はクォート無し、リテラル文字列部分だけ
`JSON.stringify` でクォートし、スペース区切りで連結する）に**直接パッチ**してある
（`levelTextToContent(e,t,r,a){...}` 関数本体を丸ごと置換）。

再更新時（`npm pack` で新バージョンを取得し直す際）は、新しい `docx-preview.min.js` に
このパッチが必要かどうか確認し、必要ならこの内容で再適用すること。壊れた実装かどうかは、
実際に番号付きリストを含む .docx をレンダリングし、DevTools で `::before` の
計算済み `content` が `none` になっていないかで確認できる。
