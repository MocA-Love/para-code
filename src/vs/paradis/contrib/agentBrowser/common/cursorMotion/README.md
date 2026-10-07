<!-- PARA-CODE: third-party code vendored by Para Code — not present in upstream microsoft/vscode. See CLAUDE.md. -->

# cursor-motion（vendored）

内蔵ブラウザのエージェントのカーソルの軌跡を計算するために、Cua の `cursor-motion` の計算部分を写したものです。描画はしません（Para Code はページの isolated world で `element.animate()` の keyframes として再生します。`paradisCursorOverlay.ts`・`paradisCursorMotion.ts`）。

| 項目 | 値 |
|---|---|
| 取得元 | https://github.com/trycua/cua/tree/2ce4691fc053287b332fb5ca9a170f4fbcbd7f1d/libs/typescript/cursor-motion/src |
| 取得日 | 2026-10-07（npm には公開されていないため、ソースを写す。上流の README がこの使い方を案内している） |
| ライセンス | MIT（Copyright (c) 2025 Cua AI, Inc.）。全文は同じフォルダの `LICENSE` |
| 写したファイル | `dubins.ts`・`ease.ts`・`effects.ts`・`geom.ts`・`params.ts`・`path.ts`・`plan.ts`・`rng.ts`・`spec.ts`・`style.ts`（`render.ts`・`driver.ts`・`index.ts` は canvas の描画と再生なので写さない） |
| 変えたこと | 各ファイルの先頭に出典とライセンスの 4 行のコメントを足した。相対 import の末尾に `.js` を付けた（VS Code はファイル名で ES モジュールを読むため）。それ以外は上流のまま |

上流のコードの書き方（2 文字のインデント・Microsoft の著作権ヘッダーが無い）のまま置くため、hygiene の indentation・copyright・tsfmt と eslint から外している（`build/filters.ts`・`.eslint-ignore` の PARA-PATCH）。

## 更新の手順

1. 上流の `libs/typescript/cursor-motion/src` から上の 10 ファイルを取り直す
2. 先頭の 4 行のコメントを付け直し、相対 import の末尾に `.js` を付ける（`sed -E "s#from '\./([a-z]+)'#from './\1.js'#g"`）
3. この README の取得元のコミットと取得日を直し、`LICENSE` を取り直す
4. `scripts/test.sh --grep "Paradis cursor motion"` で軌跡のテストを流す
