# Vendored pdf.js (pdfjs-dist)

PARA-CODE: fork-owned directory (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

このディレクトリは npm の `pdfjs-dist@6.1.200`（Apache-2.0, Mozilla Foundation）から
以下をそのままコピーした vendored サードパーティ成果物です。PDF ビューア
（`../..​/paradisPdfFileEditor.ts`）が webview 内で読み込みます。

- `pdf.min.mjs` / `pdf.worker.min.mjs` — `package/build/` より
- `cmaps/` — CJK 等の外部 CMap（日本語 PDF の非埋め込み CID フォントに必要）
- `standard_fonts/` — 非埋め込み標準14フォントの代替フォント
- `LICENSE` — pdfjs-dist の Apache-2.0 ライセンス全文

## 更新手順

```sh
npm pack pdfjs-dist@<version>
tar -xzf pdfjs-dist-<version>.tgz
cp package/build/pdf.min.mjs package/build/pdf.worker.min.mjs .
rm -rf cmaps standard_fonts && cp -R package/cmaps package/standard_fonts .
cp package/LICENSE .
```

更新時はこの README のバージョン表記も更新すること。
ビルド同梱は `build/next/index.ts` の `desktopResourcePatterns`（実リリース経路）と
`build/gulpfile.vscode.ts` の `vscodeResourceIncludes` の両方に glob 登録済み。
