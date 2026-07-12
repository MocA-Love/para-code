# Mobile Agent UI Catalog Design

## Purpose

Paracode Mobileに実装済みのClaude Code / Codex関連UIを、実際のrelayやエージェントプロセスを起動せずlocalhostで確認できるようにする。改善案や未実装デザインは含めず、現行実装の評価とレビューに使う。

## Architecture

- `app/mobile/mock/agent-ui-catalog.html` に依存関係のないインタラクティブカタログを置く。
- Node.js標準APIだけを使う小さなlocalhostサーバーを同ディレクトリへ置く。
- `app/mobile/package.json` の専用scriptから起動する。
- 製品のExpo Router、relay、Zustand store、Claude/Codexプロセスには接続しない。
- 表示データはカタログ内の固定fixtureに限定する。

## Studio Layout

- デスクトップ左側に390×844相当のスマホプレビューを固定する。
- 右側にprovider、画面、activity、Web Search、interaction、environmentの状態コントロールを置く。
- 小さいブラウザ幅ではコントロールを上、スマホプレビューを下へ並べる。
- 全パターンを一覧できるgallery表示も補助的に用意する。

## Included Screens and States

- 親Agent画面: Activityなし、1件実行中、複数並列、完了履歴、質問、承認、切断。
- Activity一覧: Claude / Codex、SubAgent、teammate、Task、running / idle / completed / failed / interrupted / unknown。
- SubAgent詳細: prompt、provider、ID、関連Task、会話・thinking・tool履歴、空履歴、親session切替。
- Web Search: 検索中、URLなし完了、参照ドメインあり、失敗、展開状態。
- 長履歴: 仮想化された実装を視覚的に確認できる十分なfixture件数。

## Fidelity Rules

- `app/mobile/src/theme.ts` の色と現行画面の文言、角丸、余白、状態色を反映する。
- 現行コードの表示条件と親子階層を再現する。
- 外部favicon通信は既定で行わない。明示操作後だけGoogle S2 URLを使用する。
- ネイティブ固有のBlur、Liquid Glass、hapticsはCSSによる視覚表現に限定する。

## Verification

- localhostからHTML、CSS、JavaScriptが読み込めることを確認する。
- 各コントロールでスマホ画面が更新されることをブラウザで確認する。
- 親Agent、Activity一覧、SubAgent詳細の遷移を確認する。
- faviconが明示操作前に外部通信しないことをソースとブラウザ表示で確認する。
