---
name: orca-mobile-watch
description: "Orca（stablyai/orca）本家のモバイルアプリ（mobile/）の更新を、前回確認した地点から追いかけ、Para Code Mobile（app/mobile）に取り込むべき変更を洗い出して HTML の報告にまとめる。『Orca のモバイルの更新を見て』『本家の mobile に取り込むものはある?』『orca-mobile-watch』のような依頼や、/loop・/schedule での定期実行で使う。取り込みの実装はしない（報告と提案まで）。"
---

# Orca モバイルの更新の追跡

Para Code Mobile（`app/mobile`）は、2026-09 に Orca モバイルの構成（PC → スペース → セッション、BottomDrawer、グラファイトのトークン、コマンドドックなど）を写して作り直した（PR MocA-Love/para-code#99）。Orca は同じ課題（PC で動く AI エージェントをスマホから見て操作する）を先に解いていて、更新が速い。このスキルは、Orca の `mobile/` の更新から Para Code に効くものを拾う。

**このスキルがやること・やらないこと**

- やる: 前回からの Orca のコミットを集める → 1件ずつ分類 → Para Code の対応箇所を特定 → 取り込むべきかを判定 → HTML の報告 → 状態ファイルの更新
- やらない: Para Code のコードの変更、コミット、Issue や PR の作成。取り込むものが決まったら、ユーザーの指示を受けてから別の作業として実装する

---

## 手順

### 1. 変更を集める

```bash
.claude/skills/orca-mobile-watch/scripts/fetch.sh /tmp/orca-mobile-watch
```

- 起点は `state.json` の `lastReviewedSha`。Orca を `~/.cache/orca-mobile-watch/orca` に blob なしで clone し（初回だけ）、`origin/main` までの `mobile/`・`docs/site/content/docs/mobile.mdx`・`docs/STYLEGUIDE.md` に触れたコミットを集める
- 出力: `commits.tsv`（sha・日時・題名・PR 番号）、`files.tsv`（sha・状態・パス）、`diffs/<sha>.patch`、`range.txt`
- コミットが0件なら「更新なし」とだけ報告し、`state.json` の `lastReviewedSha` を `range.txt` の終点に進めて終わる（報告の HTML は作らない）
- 見直しや試験では `ORCA_WATCH_SINCE=<sha>` で起点を上書きできる

コミットが多いとき（目安 40 件以上）は、題名と `files.tsv` で先にふるいにかけ、後述の「最初から対象外」を除いてから差分を読む。読む量が多ければ、PR ごとにエージェントへ分けて並行で読ませてよい（各エージェントには下の「判定」と「対応表」を渡す）。

### 2. 1件ずつ分類する

各コミット（PR 単位でまとめてよい）を、差分と PR の本文（`gh pr view <番号> --repo stablyai/orca`）を読んで次のどれかに分ける。

| 分類 | 例 |
|---|---|
| 不具合修正（RN / Expo / iOS の挙動） | キーボード、ジェスチャ、IME、スクロール、Modal、WebView、再マウント、メモリ |
| 不具合修正（Orca 固有のロジック） | Orca のデスクトップとの RPC、タスク連携 |
| UX の改善 | 導線、1タップ減らす、既定値、空状態、エラー表示、読み上げ |
| 新機能 | 画面・操作の追加 |
| 見た目 | トークン（色・余白・角丸・文字）、部品の寸法、アイコン |
| 内部整備 | リファクタ、テスト、型、依存の更新 |

**最初から対象外にしてよいもの**（題名だけで判断してよい。報告には件数だけ載せる）: Android 専用、Web 版（`*.web.ts`）専用、Orca にしか無い連携（Linear / GitLab / GitHub Projects のタスク、SSH worktree、Orca Relay のサインイン、Codex のリセットクレジット）、RPC のゴールデン（テストの期待値）の更新、リリースの作業。

### 3. Para Code の対応箇所を特定する

Orca の場所 → Para Code の場所の対応（作り直しで写したもの）:

| Orca（mobile/） | Para Code（app/mobile/） |
|---|---|
| `src/theme/mobile-theme.ts`、`docs/STYLEGUIDE.md` | `src/theme.ts`、`src/ui/statusColors.ts` |
| `src/components/BottomDrawer.tsx`・`ActionSheetModal`・`ConfirmModal`・`PickerModal`・`TextInputModal` | `src/ui/bottomDrawer.tsx`・`actionSheet.tsx`・`confirmDrawer.tsx`・`pickerDrawer.tsx`・`textInputDrawer.tsx` |
| `src/components/StatusDot`・`AgentSpinner`・`AgentStateDot` | `src/ui/statusIndicators.tsx` |
| `src/home/*`、`MobileHostCard`、`MobileHomeQuickActions` | `app/index.tsx`、`src/features/home/` |
| `src/host-screen/*`、`WorktreeListRow`、`WorktreeAgentRow`、`NewWorkspaceFab` | `app/pc/[pcId]/index.tsx`、`src/features/pc/`、`src/features/launch/` |
| `src/session/*`（タブストリップ、Chat UI、Composer、Ask / Permission、CommandDock、Quick Commands） | `app/pc/[pcId]/session/[spaceId].tsx`、`src/features/session/` |
| `src/terminal/*`（アクセサリキー、Live 入力） | `src/terminalKeys.ts`、`src/features/session/commandDock.tsx`・`terminalInputBar.tsx`・`liveInput.ts` |
| `src/platform/*`（IME・キーボードなどの差分吸収） | `src/features/session/liveInput.ts`、`src/hooks/useKeyboardVisible.ts`、`src/keyboardCoverage.ts` |
| `src/source-control/*`、`MobileDiffReview*` | `app/pc/[pcId]/source-control|review/[spaceId].tsx`、`src/features/code/` |
| `src/files/*` | `app/pc/[pcId]/files/[spaceId].tsx`、`src/features/code/` |
| `src/accounts/*`、`AccountUsage` | `app/settings/usage/`、`src/features/settings/usage*` |
| `src/settings/*`、`src/onboarding/*` | `app/settings/`、`app/onboarding.tsx`、`src/features/settings/` |
| `app/pair*.tsx` | `app/pair.tsx`、`src/features/pairing/` |
| `src/notifications/*` | `app/notifications.tsx`、`src/notificationNavigation.ts`、`native/NotifyExtension/` |
| `src/transport/*`（接続・再接続・診断） | `src/relayClient.ts`、`src/store.ts`、`src/appState.ts`（**通信の仕組みが違う**。Orca は LAN / Tailscale / Relay、Para Code は E2E のリレーだけ） |

対応箇所は `grep` で実物を確かめる（上の表は作り直し時点のもの。移動・改名があり得る）。対応箇所が無いものは「Para Code に無い機能」とする。

### 4. 取り込むべきかを判定する

| 判定 | 基準 |
|---|---|
| **取り込む** | Para Code にも同じ不具合がある（同じ書き方・同じ前提を実物で確認した）／同じ画面の明らかな UX 改善で、Para Code の前提（下）とぶつからない |
| 検討 | 良い変更だが、Para Code 側で設計の判断が要る（PC 側の対応が要る、見た目の方針が変わる、既存の設定とぶつかる） |
| 不要 | Orca 固有、Para Code では既に別の形で解決済み、Para Code の前提と合わない |

**Para Code の前提**（Orca と違うところ。判定の前に必ず照らす）:

- 通信は E2E 暗号化のリレーだけ。Orca の LAN 直結・Tailscale・ホストの自動発見は無い
- PC 側は Para Code（VS Code の fork）。Orca のデスクトップが持つ RPC（PR 情報、タスク、統計、ステージ操作など）は、Para Code の PC 側に無いことが多い。取り込むなら PC 側（`src/vs/paradis/contrib/mobileRelay/`）の対応も要る
- 押せる要素は 44pt 以上（Orca のキー行 28pt などは当たり判定で補っている）
- 状態の色と呼び名は `src/agentStatus.ts` と `theme.status` に集約（要対応=赤、実行中=黄、未確認=緑、待機=灰）。主ボタン・自分の発言・選択の印は利用者が色を変えられる（`src/ui/themeColors*.ts`）
- 独自のヘッダーのモーフや中身の面へのガラスは使わない（壊れやすかったので捨てた）
- iPhone と iPad の両方に出している。条件分岐で React ツリーの形を変えない（`CLAUDE.md` のモバイルの節）
- 文言は日本語。ウィジェット・Live Activity は Para Code 独自（Orca に同等の物が出たら比べる）

不具合修正は優先して読む。RN / Expo / iOS の挙動への対処（例: 2026-09 の `live-input-composing-range`＝ライブ入力の IME 変換中の範囲）は、Para Code の同じ箇所に同じ問題があるかを実物で確かめる。

### 5. 報告を書く

`.claude/skills/orca-mobile-watch/reports/<YYYY-MM-DD>.html` に書く。書式はユーザーのグローバルルールの「HTML の作成」に従う（単一ファイル、ライトテーマ、外部読み込みなし、絵文字なし、左端だけの色線なし、太字は1か所、コードは `<pre><code>` でエスケープ）。

構成:

1. 1行目に結論（取り込むべきものが何件あるか、一番大事な1件）
2. 範囲（`range.txt`、コミット数、期間、対象外にした件数）
3. **取り込む** の表: 項目 ／ Orca の PR（`https://github.com/stablyai/orca/pull/<番号>`）／ 何が変わったか ／ Para Code の対応箇所（パス）／ Para Code で起きていること（確認した根拠）／ 規模（小・中・大）／ PC 側の対応の要否
4. 検討 の表（判断が要る点を1行で）
5. 不要 の表（理由を1行で。件数が多ければ `<details>` に入れる）
6. 見た目の変化（トークンや寸法が変わっていれば、変更前後の値の表。必要なら簡単なモック）
7. 次にやること（1つ。例:「取り込む 3 件を1つの PR で実装するか決めてほしい」）

書き終えたら para-browser の `preview_file` で開き、ユーザーに要点（取り込むべきものの件数と上位）を伝える。

### 6. 状態を更新する

報告を書き終えてから `state.json` を更新する。

- `lastReviewedSha` と `lastReviewedAt` を `range.txt` の終点のコミットにする
- `history` の先頭に1件足す: `checkedOn`（今日の日付）、`from` / `to`、`report`（報告のパス）、`adopted`（取り込むと判定した Orca の PR 番号）、`comment`（1行）
- あとでユーザーが実装したら、その PR を `history` の該当する行の `comment` に書き足す（次回以降の「既に取り込んだか」の判断に使う）

途中で止まったときは `state.json` を進めない（次回も同じ範囲から見る）。

---

## 定期的に回す

- この Mac で回す: `/loop 7d /orca-mobile-watch`（週に1回）。更新が無い週は「更新なし」とだけ返す
- 期間を決めて回したいときは `/schedule` でも作れる。`state.json` は Git で管理している（`.claude/skills` は `.agents/skills` へのリンク）ので、進めたら他の変更と同じくコミットする。報告の HTML（`reports/`）は Git に入れない

## 落とし穴

- `gh` の既定の向き先は、このリポジトリでは upstream（microsoft/vscode）になっていることがある。Orca を見るときは必ず `--repo stablyai/orca`、Para Code の PR を見るときは `--repo MocA-Love/para-code` を付ける
- Orca のコミットは squash で、題名の末尾に `(#番号)` が付く。同じ PR が複数に分かれていることもあるので、PR 単位でまとめて判定する
- `mobile/` の外（`src/shared/` など）で、モバイルと共有しているロジックが変わることがある。差分の中で `../src/` などの import が変わっていたら、その先も見る
- Orca のテストの期待値（RPC のゴールデン、スナップショット）の更新だけのコミットは対象外
- 差分が大きい依存の更新（Expo SDK・RN の版上げ）は、Para Code の版と比べて「次に版を上げるときの参考」として検討に入れる（今すぐ取り込むものにはしない）
