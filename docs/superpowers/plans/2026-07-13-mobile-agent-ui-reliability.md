# Mobile Agent UI Reliability Implementation Plan

> 実装は各項目で RED → GREEN → REFACTOR を守り、現行Codex/Claude形式のみを対象にする。

**Goal:** モバイルAgent UIの送信、CLI起動表示、Web検索、SubAgent/Taskのライブ・履歴・詳細を一貫して表示する。

**Architecture:** shell integrationとproviderは即時のprovisional表示だけを担い、shared processは検証済みsessionとAgent活動の正本を担う。daemon/hook/transcriptをIDで同一trackerへ収束し、モバイルは正規化済み状態を描画する。

**Tech Stack:** TypeScript、VS Code terminal APIs、Node SQLite/JSONL、React Native/Expo、Mocha、Vitest。

---

### Task 1: 現行イベント形式の回帰テスト

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/test/node/paradisAgentActivity.test.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileAgentChat.test.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisAgentActivity.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`

1. Claude `task_description`、Codex rollout `sub_agent_activity`、Web検索合成ID、completed turn収束の失敗テストを追加する。
2. 関連テストを実行し、意図した失敗を確認する。
3. tracker/parserへ最小実装を加える。
4. 関連テストを再実行する。

### Task 2: SubAgent詳細フォールバック

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/test/node/paradisMobileAgentChat.test.ts`

1. Codex daemon読取失敗時に子thread IDから許可済みrolloutを読むテストを追加する。
2. 失敗確認後、state DB検索と上限付きparser読取を実装する。
3. Claude Stop由来のtranscript path/最終メッセージ補完をテスト・実装する。

### Task 3: Agentメッセージの二段階送信

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileWorkspaceProvider.ts`
- Create: `src/vs/paradis/contrib/mobileRelay/common/paradisAgentMessageSender.ts`
- Modify/Create: `src/vs/paradis/contrib/mobileRelay/test/electron-browser/*`

1. paste、再検証、Enterの順序とstale時にEnterを送らないテストを追加する。
2. 失敗確認後、既存action claim契約内で二段階送信を実装する。

### Task 4: ターミナルEnterを改行へ変更

**Files:**
- Modify: `app/mobile/src/components/glassComposer.tsx`
- Modify: `app/mobile/app/(tabs)/terminal.tsx`
- Modify/Create: `app/mobile/src/**/*.test.tsx`

1. 等幅入力でもmultilineかつ`onSubmitEditing`未設定になるテストを追加する。
2. 表示と送信ポリシーを分離し、送信ボタンのみ実行する。

### Task 5: CLI起動のprovisional表示

**Files:**
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileRelay.contribution.ts`
- Modify: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileWorkspaceProvider.ts`
- Modify/Create: `src/vs/paradis/contrib/mobileRelay/electron-browser/paradisAgentCliCommand.ts`
- Modify/Create: `src/vs/paradis/contrib/mobileRelay/test/electron-browser/paradisAgentCliCommand.test.ts`

1. 現行CLIの対話/非対話コマンド分類テストを追加する。
2. 失敗確認後、分類純関数を実装する。
3. command executed/finished/disposeをprovisional tokenへ接続し、confirmedと和集合でホーム表示する。
4. provisionalだけではAgent操作を可能にしないことを確認する。

### Task 6: モバイル描画回帰

**Files:**
- Modify: `app/mobile/app/agent.tsx`
- Modify: `app/mobile/src/components/agentActivityCard.tsx`
- Modify/Create: `app/mobile/src/**/*.test.tsx`

1. ID無しCodex Web検索が完了後も専用カードになるテストを追加する。
2. 完了活動がサマリーとして残り、実行中だけstripへ出ることを確認する。
3. 必要最小限の描画ロジックを修正する。

### Task 7: Changelog・全体検証・公開

**Files:**
- Modify: `src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md`

1. `## 未リリース`へユーザー向け修正を追記する。
2. VS Code client typecheck後、関連unit testsを実行する。
3. mobile typecheck/lint/testsを実行する。
4. diff/hygiene/layeringを確認し、自己レビューする。
5. 本作業ファイルだけをstageし、`para:`コミットを作る。
6. `origin/main`へpushする。リリースは行わない。

### Task 8: Effortスライダー・IME操作の安定化

**Files:**
- Modify: `app/mobile/src/components/effortSlider.tsx`
- Create: `app/mobile/src/components/effortSliderBehavior.ts`
- Modify: `app/mobile/src/components/glassComposer.tsx`
- Modify/Create: `app/mobile/src/components/*.test.ts`

1. 親ScrollViewがドラッグを途中終了させないgesture方針をテストする。
2. ドラッグ中の外部値同期を抑止し、release時だけ仮選択を確定する。
3. `TextInput`を独立したmemo境界へ移し、モデル・Effort・ツール表示の更新をIMEへ波及させない。
4. mobile typecheckと対象Vitestを実行する。
