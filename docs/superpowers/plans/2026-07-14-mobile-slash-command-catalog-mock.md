# Mobile Slash Command Catalog Mock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ローカルで操作できる、Codex／Claude Code別のスラッシュコマンド補完モックを提供する。

**Architecture:** 既存のエージェントUIカタログと分離した単一HTMLページを`app/mobile/mock/`に追加する。HTML内にエージェント別カタログ、入力解析、候補選択、疑似送信ログを完結させ、既存のmockサーバーが両ページを配信する。

**Tech Stack:** HTML、CSS、ブラウザ標準JavaScript、Node.js HTTP server。

## Global Constraints

- プロダクトのReact Native入力欄、リレー、プロトコルは変更しない。
- 候補はCodexとClaude Codeで別カタログにし、選択中エージェントの候補だけを表示する。
- 補完はメッセージ先頭の`/`トークンだけで開き、`/a`では`/a`で始まる候補だけを表示する。
- 実行はモックのログに記録し、実CLIやネットワークへは送信しない。

---

### Task 1: スラッシュコマンド操作モックを追加する

**Files:**
- Create: `app/mobile/mock/slash-command-catalog.html`

**Interfaces:**
- Produces: `COMMANDS`（`codex`と`claude`別の候補配列）、`getSlashQuery(text, cursor)`、`filterCommands(agent, query)`、`render()`。
- Consumes: ブラウザの`input`、`click`、`keydown`イベントのみ。

- [ ] **Step 1: 入力解析の失敗ケースをブラウザで確認する**

`hello /a`、`/a b`、`/z`を入力し、候補パネルが表示されない、または空状態になることを期待値として定める。

- [ ] **Step 2: 最小のモックを実装する**

`COMMANDS`を以下のようにエージェント別に定義し、`input.selectionStart`までを`/^\\/([^\\s/]*)$/`で判定する。

```js
const COMMANDS = {
  codex: [
    { name: '/model', description: 'モデルと推論量を選択', kind: 'builtin' },
    { name: '/permissions', description: '許可設定を変更', kind: 'builtin' },
    { name: '/skills', description: 'スキル一覧を開く', kind: 'builtin' },
  ],
  claude: [
    { name: '/model', description: 'モデルを選択', kind: 'builtin' },
    { name: '/aivis', description: 'Aivisを使った音声報告', kind: 'skill' },
    { name: '/make_pr', description: '指定ブランチへPRを作成', kind: 'skill' },
  ],
};

function getSlashQuery(text, cursor) {
  return /^\\/([^\\s/]*)$/.exec(text.slice(0, cursor))?.[1].toLowerCase();
}
```

- [ ] **Step 3: 候補選択と疑似送信を実装する**

候補クリックで現在のスラッシュトークンをコマンド名へ置換し、送信で`Codex: /model`の形式のログを追加する。`ArrowUp`、`ArrowDown`、`Enter`、`Escape`にも対応させる。

- [ ] **Step 4: 手動で期待動作を確認する**

Codexで`/p`、Claude Codeで`/a`を入力し、それぞれ`/permissions`、`/aivis`だけが候補になることを確認する。候補を選択して送信し、ログへ現在のエージェント名とコマンドが記録されることを確認する。

### Task 2: 既存モックサーバーから新ページを配信する

**Files:**
- Modify: `app/mobile/mock/serve.mts`

**Interfaces:**
- Consumes: `GET /`、`GET /agent-ui-catalog.html`、`GET /slash-command-catalog.html`。
- Produces: 各HTMLの`text/html; charset=utf-8`レスポンス。未知のパスは404。

- [ ] **Step 1: 新しいページのHTTPテストを先に実行する**

サーバー起動後、`curl -i http://127.0.0.1:4179/slash-command-catalog.html`が現状は404になることを確認する。

- [ ] **Step 2: ページ名を許可リスト化する最小実装を書く**

```ts
const pages = new Map([
  ['/', 'agent-ui-catalog.html'],
  ['/agent-ui-catalog.html', 'agent-ui-catalog.html'],
  ['/slash-command-catalog.html', 'slash-command-catalog.html'],
]);

const page = pages.get(url.pathname);
if (page === undefined) {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not Found');
  return;
}
const file = join(root, page);
```

- [ ] **Step 3: HTTP確認を再実行する**

`curl -I http://127.0.0.1:4179/slash-command-catalog.html`で`200 OK`と`Content-Type: text/html; charset=utf-8`を確認する。

### Task 3: 実ブラウザで操作検証する

**Files:**
- Verify: `app/mobile/mock/slash-command-catalog.html`
- Verify: `app/mobile/mock/serve.mts`

- [ ] **Step 1: サーバーを起動する**

Run: `pnpm --dir app/mobile mock:agent-ui -- --port 4179`

Expected: `Paracode Mobile Agent UI Catalog: http://127.0.0.1:4179`

- [ ] **Step 2: モックをブラウザで開き、CodexとClaude Codeの両方を操作する**

`/p`と`/a`の候補絞り込み、キーボード選択、タップ選択、送信ログ、`Escape`での候補消去を確認する。

- [ ] **Step 3: TypeScript確認を行う**

Run: `pnpm --dir app/mobile typecheck`

Expected: exit code 0。

## Self-Review

- Codex／Claude Codeのカタログ分離、プレフィックス絞り込み、候補選択、疑似送信、ローカル配信を全タスクでカバーしている。
- プロダクト本体とリレーには変更を加えない。
- すべての追加・変更ファイル、手動検証手順、期待値を明記している。
