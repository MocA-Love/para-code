# Mobile Agent UI Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 現行Paracode MobileのClaude Code / Codex UIをlocalhost上で操作・比較できる忠実なUIカタログを作る。

**Architecture:** 製品ランタイムから独立した単一HTMLにfixture、render関数、CSSをまとめ、Node.js標準APIだけのサーバーから配信する。製品のrelay、store、外部エージェントには接続しない。

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js `node:http`

## Global Constraints

- 現在実装済みUIだけを再現し、改善案を混ぜない。
- `app/mobile/src/theme.ts` の色と現行文言を使用する。
- favicon外部通信は明示操作前に発生させない。
- 既存Expoアプリのruntimeやdependencyを変更しない。

---

### Task 1: Localhost Server

**Files:**
- Create: `app/mobile/mock/serve.mjs`
- Modify: `app/mobile/package.json`

**Interfaces:**
- Produces: `pnpm --dir app/mobile mock:agent-ui` で `http://127.0.0.1:4179` を配信するサーバー。

- [ ] **Step 1: サーバーを実装する**

`node:http`で同一ディレクトリの`agent-ui-catalog.html`だけを配信し、`--port`でポートを上書きできるようにする。HTML以外のpathは404、GET以外は405を返す。

- [ ] **Step 2: 起動scriptを追加する**

`app/mobile/package.json`へ次を追加する。

```json
"mock:agent-ui": "node mock/serve.mjs"
```

- [ ] **Step 3: レビューしてコミットする**

```bash
git add app/mobile/mock/serve.mjs app/mobile/package.json
git commit -m "chore(mobile): serve agent UI catalog"
```

### Task 2: Interactive Studio Catalog

**Files:**
- Create: `app/mobile/mock/agent-ui-catalog.html`

**Interfaces:**
- Consumes: localhost server。
- Produces: provider、screen、activity、web、interaction、environmentを切り替えるStudio UI。

- [ ] **Step 1: themeとStudio shellを作る**

`theme.ts`の色をCSS custom propertiesへ写し、390×844 phone frameと右側control panelをレスポンシブに配置する。

- [ ] **Step 2: fixtureとrender関数を作る**

```js
const state = { provider: 'claude', screen: 'agent', activity: 'parallel', web: 'none', interaction: 'none', environment: 'normal' };
function renderPhone() { /* stateから現行画面を描画 */ }
```

親Agent、Activity一覧、SubAgent詳細をscreenごとに描画し、Claude/Codexのprovider表示と状態色を切り替える。

- [ ] **Step 3: Web SearchとInteractionを作る**

検索中、完了、参照domain、失敗、展開を再現する。質問、複数質問、承認を現行文言と操作状態で再現する。favicon取得ボタンを押すまで画像URLをDOMへ設定しない。

- [ ] **Step 4: 長履歴と切断状態を作る**

長履歴fixture、親session切替、ConnectionGate相当の切断画面を追加する。Galleryボタンで主要presetを縮小一覧表示する。

- [ ] **Step 5: レビューしてコミットする**

```bash
git add app/mobile/mock/agent-ui-catalog.html
git commit -m "feat(mobile): add interactive agent UI catalog"
```

### Task 3: Browser Verification

**Files:**
- Modify only if verification exposes defects.

**Interfaces:**
- Consumes: `http://127.0.0.1:4179`。
- Produces: 操作確認済みのlocalhostカタログ。

- [ ] **Step 1: localhostを起動する**

```bash
pnpm --dir app/mobile mock:agent-ui
```

- [ ] **Step 2: ブラウザで全presetを確認する**

Provider、3画面、Activity、Web Search、Interaction、Environment、Galleryを操作し、コンソールエラーと意図しない外部favicon要求がないことを確認する。

- [ ] **Step 3: 最終差分を確認する**

```bash
git diff --check
git status --short
```

- [ ] **Step 4: 検証修正があればコミットする**

```bash
git add app/mobile/mock/agent-ui-catalog.html app/mobile/mock/serve.mjs app/mobile/package.json
git commit -m "fix(mobile): polish agent UI catalog"
```
