# Office Viewer 検証台帳

## Task 2 監査時点

- 監査基点: `0e123d9598d9c098e7c6f6dc082a858524301eb7`
- matrix checker: `/Users/magu/.local/bin/mise exec node@24.18.0 -- node scripts/check-office-matrix.ts docs/office-viewer-acceptance-matrix.md`
- 実機ランタイム: 未実施。Desktop / Web / Remote / Mobile への接続、画面操作、スクリーンショットはこのTaskの証跡に含めない。
- 判定: 実機runtimeが未実行のため `implemented` は使用しない。各 `safe-fallback` 行はaction/reasonを構造化しており、checkerがrowごとに検証する。

## 安全フォールバックの行動

新経路の実機証跡がない行は、一律の文言ではなくmatrixの`action`へ従う。`legacy-preview`は既存の読み取り専用preview、`diagnostic`は種類・理由を示して意味差分を確定しない表示、`explicit-unavailable`は必要な接続または既存エディタを案内する表示である。`reason`は未実行という事実ではなく、`fail-closed`、`no-unsupported-projection`、`no-external-fetch`、`no-semantic-claim`の製品ポリシーを示す。外部取得・マクロ・OLE・ActiveXの実行は行わない。これは仕様34節のruntime kill switch、および27.1節のsilent omission禁止に従う暫定分類である。

## 既存ソース証跡（実行結果ではない）

次のテスト・fixtureはリポジトリに存在するが、Task 2では再実行していない。よってmatrixでは `not-run:` と記録した。

- `src/vs/paradis/contrib/fileViewers/test/integration/paradisOfficeDualRead.test.ts` の `preserves legacy spreadsheet values, styles, and effective base diagonal semantics while auditing unchanged overlays` は `common/fixtures/task2-diagonal-border.xlsx` を使う。
- 同テストは `common/fixtures/task2-drawing-line.docx` を使い、表罫線とDrawing lineを別の対象として扱う。
- `src/vs/paradis/contrib/fileViewers/test/common/paradisOfficeSanitizer.test.ts` の `preserves line, shape, anchor, transform, and diagonal-border geometry while blocking a DrawingML asset` はgeometryの保持とunsafe assetの遮断を別々に検証する。

これらはraw/effective diagonal一般のランタイム保証ではない。前者fixtureと上記の個別テストが覆う範囲だけをソース証跡として扱う。

## Commit 検証規則

checkerは各行のcommitが現在の`HEAD`の祖先であることを `git merge-base --is-ancestor <sha> HEAD` で検証する。台帳に個別のTask列挙がない既存commitも、この祖先性を満たす限り検証可能な既存証跡として扱う。例: `f516d5d52f5` と `aa7a5be4791`。祖先でないSHA、`pending`、空欄は拒否する。

## 次の検証Gate

Task 3以降でfixture/unit/runtimeを実行した後に、該当行だけを `implemented` へ更新する。runtime未確認のままの行は `safe-fallback` を維持する。policyにより提供しない機能は、具体的なUI行動とpolicy理由を記録して `intentional-unsupported` にする。
