# Para Code Reliability Improvement Program

## 目的

ユーザーから報告された9件を、相互依存を壊さない順序で4つの実装単位として完了させる。各単位は独立した回帰テストとレビューを持ち、Critical/Important指摘を解消してから次へ進む。

## 要件対応表

| 報告 | 設計書 | 完了条件 |
|---|---|---|
| 透明スクリーンショット | `2026-07-14-browser-mcp-recovery-design.md` | 透明結果を検出して再試行し、対応外形式を明示する |
| 50X・再接続不能 | `2026-07-14-browser-mcp-recovery-design.md` | token単位で自動回復し、アプリ再起動を不要にする |
| 複数スペースのMCP異常 | `2026-07-14-browser-multispace-focus-design.md` | park中を含む生存台帳とscope一致bindingを維持する |
| MCP操作のフォーカス奪取 | `2026-07-14-browser-multispace-focus-design.md` | `webContents.focus()`を使わず入力する |
| 再起動後のAgent未認識 | `2026-07-14-terminal-recovery-performance-design.md` | 復元順序に依存せずClaude/Codexを再検知する |
| Workspaces開閉状態 | `2026-07-14-workspaces-ui-terminal-split-design.md` | workspace単位で再起動後も復元する |
| terminalの別space表示 | `2026-07-14-terminal-recovery-performance-design.md` | 全生成・park・再起動経路で所属を維持する |
| 大量出力時の入力遅延 | `2026-07-14-terminal-recovery-performance-design.md` | Para固有処理を限定し、相対性能基準を満たす |
| Split時の新規terminal設定 | `2026-07-14-workspaces-ui-terminal-split-design.md` | default OFF、ON時は分割先へ必ず新規作成する |

## 実装順序

1. Browser MCP recovery: 後続が利用するbinding generationと自己回復を作る。
2. Browser multispace/focus: generationを用いてlive pane manifest、scope binding、focusless inputを作る。
3. Terminal recovery/performance: identity/scopeを回帰固定し、出力ホットパスを軽量化・計測する。
4. Workspaces UI/split: 独立したUI永続化と設定を追加する。
5. 4単位を横断する統合レビューを行い、全9件の要件対応表を再確認する。

## 共通制約

- 現在のmobile relay protocol v3とrenderer lease契約を壊さない。
- ペインtokenをログへ平文で出さない。
- background spaceのAgent操作を、active space切替だけで止めない。
- ユーザーのterminal入力とIMEへMCP操作を配送しない。
- 新しいSplit設定はdefault `false`にする。
- 既存の未追跡ファイル`.serena/`と`app/design/mobile-relay-v3-recovery-design.md`へ触れない。
- ユーザーの明示指示があるまでcommitとpushを行わない。

## レビュー手順

各実装タスクで、テストの失敗確認、最小実装、対象テスト、型検査・lint、主担当の自己レビューを行う。その後、独立したread-onlyレビューで要件、並行性、リソース解放、セキュリティ、回帰を確認する。Critical/Important指摘は同じ単位で修正・再検証し、未解決のまま次へ進まない。

最終レビューでは4つの設計書、全差分、テスト結果、9件の完了条件を照合し、既修正だった項目もテストで保証されていることを確認する。
