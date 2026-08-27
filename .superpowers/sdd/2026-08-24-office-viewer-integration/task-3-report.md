# Task 3 Report: Full Targeted Verification

- 検証SHA: `c5f12e3d28a09c33d9f65a3ff061fdf0c020667f`
- 比較基点: `c5f12e3d28a09c33d9f65a3ff061fdf0c020667f`
- 変更範囲: `docs/office-viewer-verification.md` と本報告書のみ。実装変更なし。

## 結果

| コマンド | exit | 結果 |
| --- | ---: | --- |
| `npm run transpile-client` | 0 | 9,227 files found、2,571 resources copied |
| `./scripts/test.sh --runGlob 'vs/paradis/contrib/fileViewers/test/**/*.test.js'` | 1 | 958 passing / 1 pending / 2 failing |
| `app/mobile: npm test -- src/components/fileViewer.test.tsx src/components/officeCapability.test.ts` | 0 | 1 file / 12 tests passed。`fileViewer.test.tsx` は基点に存在せず未検出 |
| `npm run typecheck-client` | 0 | diagnostics 0 |
| `npm run valid-layers-check` | 0 | diagnostics 0 |
| `app/mobile: npm run typecheck` | 2 | `relayClientPresence.test.ts` のTS2532が13件 |

Office globとmobile typecheckは、検証SHAと同一の比較基点で再現した既知の基点失敗である。詳細な開始・終了時刻、実行コマンド、警告、失敗内容は `docs/office-viewer-verification.md` に記録した。全コマンドは `rtk /Users/magu/.local/bin/mise exec node@24.18.0 --` を経由した。
