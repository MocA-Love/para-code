# Vendored chrome-devtools-mcp

PARA-CODE: fork-owned directory (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

このディレクトリは npm の `chrome-devtools-mcp@1.5.0`（Apache-2.0, Google LLC）を
そのままコピーした vendored サードパーティ成果物です。para-browser MCPサーバー
（`../../paradisAgentBrowserService.ts` + `../../paradisDevtoolsMcpProxy.ts`）が、
ペイン毎の子プロセスとして `ELECTRON_RUN_AS_NODE` で spawn し、stdio MCP経由で
DevToolsツール群（click / take_screenshot / navigate_page 等）をプロキシ合流させます。

- `package.json` — ESM宣言（`"type": "module"`）が実行に必須なため同梱
- `LICENSE` — Apache-2.0 ライセンス全文
- `build/` — 実行コード一式（エントリは `build/src/bin/chrome-devtools-mcp.js`。
  依存パッケージはすべて `build/src/third_party/` にバンドル済みで、node_modules 不要）
- 上流の `README.md` と `skills/`（エージェント向けドキュメント）はランタイム不要のため除外

## 更新手順

```sh
npm pack chrome-devtools-mcp@<version>
tar -xzf chrome-devtools-mcp-<version>.tgz
rm -rf build && cp -R package/build build
cp package/package.json package/LICENSE .
node build/src/bin/chrome-devtools-mcp.js --version  # 動作確認
# .eslint-allowed-javascript-files の当ディレクトリ分を再生成すること（手順は同ファイル内コメント参照）
```

更新時はこの README のバージョン表記と、`paradisDevtoolsMcpProxy.ts` が前提とする
CLIフラグ（`--wsEndpoint` / `--usageStatistics` / `--performanceCrux`）の互換性を確認すること。
ビルド同梱は `build/next/index.ts` の `desktopResourcePatterns`（実リリース経路）と
`build/gulpfile.vscode.ts` の `vscodeResourceIncludes` の両方に glob 登録済み
（拡張子なしファイル `LICENSE` / `THIRD_PARTY_NOTICES` は個別 glob）。
lint/hygiene 除外は `build/filters.ts` の2ブロック。
