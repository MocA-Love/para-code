# Task 2 Report: Close Audit Acceptance Matrix

## 対象

- 作業基点: `0e123d9598d9c098e7c6f6dc082a858524301eb7`
- 対象仕様: design sections 24–28, 34–36
- 対象行: A/B/C/D と追加監査行、計173行

## RED

```text
/Users/magu/.local/bin/mise exec node@24.18.0 -- node scripts/check-office-matrix.ts docs/office-viewer-acceptance-matrix.md
```

初回はcheckerが未作成で `MODULE_NOT_FOUND`。作成後のREDは、旧headerに `behavior`, `unit`, `runtime` がなく、旧statusも許可集合外であることを検出した。

## GREEN

同じcommandで173行を検証した。checkerはrequired column、空欄・placeholder、許可status、safe-fallback/intentional-unsupportedの行動要件、commit SHA形式、`HEAD`祖先性を検証する。

## 判定と制限

- Task 2ではDesktop/Web/Remote/Mobile runtimeを再実行していない。
- そのため実装済みソースやchecked-in fixtureがある行も `implemented` としない。`safe-fallback` は各行で `action=legacy-preview|diagnostic|explicit-unavailable` と製品policyの `reason` を持つ。
- runtime未確認時は、行ごとに既存読み取り専用preview、診断UI、明示的な利用不可案内のいずれかを選ぶ。macro/OLE/ActiveX/external取得は行わない。
- diagonal / Drawing geometryは、`task2-diagonal-border.xlsx` と `task2-drawing-line.docx`、および個別テストに記録された範囲だけをソース証跡とし、raw/effective diagonalの一般的なruntime保証にはしない。
- 台帳に個別Taskとして列挙されない既存commitは、現在HEADの祖先である場合に限り検証可能と明記した。
