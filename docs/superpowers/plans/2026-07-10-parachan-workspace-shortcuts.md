# Parachan Workspace Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macOS で `Control+1〜9` を押すと対応する Parachan ワークスペースへ切り替わり、既存のデフォルトキーバインドより優先されるようにする。

**Architecture:** 既存の `paradis.workspaceSwitch.switchToRepository1〜9` アクションと切り替えサービスはそのまま使う。fork-owned の小さなキー定義 helper を追加し、macOS の primary/secondary と高優先度 weight を一元生成して、既存 contribution から利用する。

**Tech Stack:** TypeScript、VS Code `Action2` / `KeybindingsRegistry` / `KeybindingResolver`、Mocha TDD UI、Playwright browser unit test

---

## File structure

- Create: `src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceSwitchKeybindings.ts`
  - 1〜9の番号から OS 別キーバインド記述を生成する。
  - Parachan のデフォルト割り当てを既存 contribution より後に評価させる weight を定義する。
- Modify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspaceSwitch.contribution.ts:363-392`
  - 既存の9アクションへ helper が返すキーバインドを設定する。
  - コマンド ID と `run` の切り替え処理は変更しない。
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.ts`
  - 実際に登録された macOS / Linux の primary・secondary と競合解決を検証する。
- Modify: `src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md:7`
  - 「未リリース」セクションを追加し、ユーザー向け変更を記録する。

作業開始時点から存在する `extensions/copilot/.esbuild.mts` と `.serena/` はユーザーの変更なので、編集・ステージ・コミットしない。

### Task 1: Add the failing keybinding behavior test

**Files:**
- Create: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.ts`

- [ ] **Step 1: Write the failing browser unit test**

Create the test with the complete contents below. It imports the real contribution so the assertions cover the registered `Action2` keybindings, not a test-only copy.

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { createSimpleKeybinding, KeyCodeChord } from '../../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingItem, KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeybindingResolver, ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { ResolvedKeybindingItem } from '../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { USLayoutResolvedKeybinding } from '../../../../../platform/keybinding/common/usLayoutResolvedKeybinding.js';
import '../../browser/paradisWorkspaceSwitch.contribution.js';

const competingCommandId = 'test.paradis.workspaceSwitch.competingDefault';

function switchCommandId(index: number): string {
	return `paradis.workspaceSwitch.switchToRepository${index}`;
}

function commandBindings(os: OperatingSystem, index: number): IKeybindingItem[] {
	return KeybindingsRegistry.getDefaultKeybindingsForOS(os)
		.filter(item => item.command === switchCommandId(index) && item.keybinding);
}

function assertDigitChord(item: IKeybindingItem, expected: {
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly keyCode: KeyCode;
}): void {
	assert.ok(item.keybinding);
	const chord = item.keybinding.chords[0];
	assert.ok(chord instanceof KeyCodeChord);
	assert.deepStrictEqual({
		ctrlKey: chord.ctrlKey,
		altKey: chord.altKey,
		metaKey: chord.metaKey,
		keyCode: chord.keyCode,
	}, expected);
}

suite('Paradis workspace switch keybindings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses Control+1..9 on macOS and retains Control+Command+1..9 as secondary', () => {
		for (let index = 1; index <= 9; index++) {
			const bindings = commandBindings(OperatingSystem.Macintosh, index);
			const primary = bindings.find(item => item.weight2 === 0);
			const secondary = bindings.find(item => item.weight2 === -1);
			assert.ok(primary);
			assert.ok(secondary);
			assertDigitChord(primary, {
				ctrlKey: true,
				altKey: false,
				metaKey: false,
				keyCode: KeyCode.Digit0 + index,
			});
			assertDigitChord(secondary, {
				ctrlKey: true,
				altKey: false,
				metaKey: true,
				keyCode: KeyCode.Digit0 + index,
			});
		}
	});

	test('keeps Ctrl+Alt+1..9 as the Linux primary binding', () => {
		for (let index = 1; index <= 9; index++) {
			const bindings = commandBindings(OperatingSystem.Linux, index);
			const primary = bindings.find(item => item.weight2 === 0);
			assert.ok(primary);
			assertDigitChord(primary, {
				ctrlKey: true,
				altKey: true,
				metaKey: false,
				keyCode: KeyCode.Digit0 + index,
			});
		}
	});

	test('wins over an existing lower-priority default binding', () => {
		const competingRegistration = KeybindingsRegistry.registerKeybindingRule({
			id: competingCommandId,
			weight: Number.MAX_SAFE_INTEGER - 1,
			primary: KeyMod.CtrlCmd | KeyCode.Digit1,
			mac: { primary: KeyMod.WinCtrl | KeyCode.Digit1 },
		});
		try {
			const resolvedItems: ResolvedKeybindingItem[] = [];
			for (const item of KeybindingsRegistry.getDefaultKeybindingsForOS(OperatingSystem.Macintosh)) {
				if (!item.keybinding || (item.command !== competingCommandId && item.command !== switchCommandId(1))) {
					continue;
				}
				const resolved = USLayoutResolvedKeybinding.resolveKeybinding(item.keybinding, OperatingSystem.Macintosh)[0];
				assert.ok(resolved);
				resolvedItems.push(new ResolvedKeybindingItem(
					resolved,
					item.command,
					item.commandArgs,
					item.when ?? undefined,
					true,
					item.extensionId,
					item.isBuiltinExtension,
				));
			}

			const resolver = new KeybindingResolver(resolvedItems, [], () => { });
			const keypress = USLayoutResolvedKeybinding.getDispatchStr(createSimpleKeybinding(
				KeyMod.WinCtrl | KeyCode.Digit1,
				OperatingSystem.Macintosh,
			));
			assert.ok(keypress);
			const context: IContext = { getValue: () => undefined };
			const result = resolver.resolve(context, [], keypress);
			assert.ok(result.kind === ResultKind.KbFound);
			assert.strictEqual(result.commandId, switchCommandId(1));
		} finally {
			competingRegistration.dispose();
		}
	});
});
```

- [ ] **Step 2: Compile the client and new test**

Run:

```bash
rtk npm run compile-client
```

Expected: compilation succeeds and emits `out/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.js`.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
rtk npm run test-browser-no-install -- --run src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.ts --browser chromium
```

Expected: FAIL. The macOS test cannot find a secondary binding and/or sees `Control+Command+数字` as primary; the priority test resolves `test.paradis.workspaceSwitch.competingDefault` instead of `paradis.workspaceSwitch.switchToRepository1`. The Linux assertion should pass.

### Task 2: Implement the prioritized workspace keybindings

**Files:**
- Create: `src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceSwitchKeybindings.ts`
- Modify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspaceSwitch.contribution.ts:363-392`
- Test: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.ts`

- [ ] **Step 1: Add the shared keybinding descriptor helper**

Create the helper with the complete contents below. `Number.MAX_SAFE_INTEGER` wins over every built-in and extension default registration, including extension rules whose weight includes a contribution index, while user keybindings remain overrides in `WorkbenchKeybindingService`.

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IKeybindingRule } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

const PARADIS_WORKSPACE_SWITCH_KEYBINDING_WEIGHT = Number.MAX_SAFE_INTEGER;

export function paradisWorkspaceSwitchKeybinding(index: number): Omit<IKeybindingRule, 'id'> {
	const digit = KeyCode.Digit0 + index;
	return {
		weight: PARADIS_WORKSPACE_SWITCH_KEYBINDING_WEIGHT,
		primary: KeyMod.CtrlCmd | KeyMod.Alt | digit,
		mac: {
			primary: KeyMod.WinCtrl | digit,
			secondary: [KeyMod.CtrlCmd | KeyMod.WinCtrl | digit],
		},
	};
}
```

- [ ] **Step 2: Use the helper from the existing repository actions**

Add this import beside the existing `../common/paradisWorkspaceSwitch.js` import:

```ts
import { paradisWorkspaceSwitchKeybinding } from '../common/paradisWorkspaceSwitchKeybindings.js';
```

Replace the keybinding comment and inline descriptor above/in the `for (let index = 1; index <= 9; index++)` loop with:

```ts
// --- キーバインド (Superset 風のリポジトリ即時切り替え) ------------------------------------------
// mac: ctrl+1..9 (primary) / ctrl+cmd+1..9 (secondary)。win/linux: ctrl+alt+1..9。
// Parachan のデフォルトは既存の built-in / extension デフォルトより高い weight で登録する。
// ユーザーの keybindings.json はデフォルト登録より後に解決されるため、引き続き上書き可能。

for (let index = 1; index <= 9; index++) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `paradis.workspaceSwitch.switchToRepository${index}`,
				title: localize2('paradis.workspaceSwitch.switchToRepositoryN', "Switch to Repository {0}", index),
				category: CATEGORY,
				f1: false,
				keybinding: paradisWorkspaceSwitchKeybinding(index),
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const service = accessor.get(IParadisWorkspaceSwitchService);
			const repository = service.repositories[index - 1];
			if (repository) {
				await service.switchRepository(repository.id);
			}
		}
	});
}
```

- [ ] **Step 3: Compile the implementation**

Run:

```bash
rtk npm run compile-client
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
rtk npm run test-browser-no-install -- --run src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.ts --browser chromium
```

Expected: all 3 tests pass. In particular, pure `Control+1` resolves to `paradis.workspaceSwitch.switchToRepository1` even with the competing default registered at `Number.MAX_SAFE_INTEGER - 1`.

- [ ] **Step 5: Commit the green implementation and test**

Run:

```bash
rtk git add -- src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceSwitchKeybindings.ts src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspaceSwitch.contribution.ts src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.ts
rtk git commit -m "para: prioritize workspace number shortcuts"
```

Expected: one `para:` commit containing only the helper, contribution change, and focused test.

### Task 3: Document the user-facing shortcut

**Files:**
- Modify: `src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md:7`

- [ ] **Step 1: Add an unreleased improvement entry**

Insert this section immediately before `## paracode-30（2026-07-09）`:

```md
## 未リリース

### 改善

- macOSで `Control+1〜9` を押すと、登録順に対応するワークスペースへ直接切り替えられるようになりました。従来の `Control+Command+1〜9` も引き続き利用できます

```

- [ ] **Step 2: Check formatting and the exact diff**

Run:

```bash
rtk git diff --check -- src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md
rtk git diff -- src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md
```

Expected: no whitespace errors and exactly one new unreleased changelog section.

- [ ] **Step 3: Commit the changelog**

Run:

```bash
rtk git add -- src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md
rtk git commit -m "para: document workspace number shortcuts"
```

Expected: one `para:` commit containing only the changelog.

### Task 4: Run final verification

**Files:**
- Verify: `src/vs/paradis/contrib/workspaceSwitch/common/paradisWorkspaceSwitchKeybindings.ts`
- Verify: `src/vs/paradis/contrib/workspaceSwitch/browser/paradisWorkspaceSwitch.contribution.ts`
- Verify: `src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.ts`
- Verify: `src/vs/paradis/contrib/releaseNotes/electron-browser/media/paradisChangelog.md`

- [ ] **Step 1: Re-run the focused behavior test**

Run:

```bash
rtk npm run test-browser-no-install -- --run src/vs/paradis/contrib/workspaceSwitch/test/browser/paradisWorkspaceSwitchKeybindings.test.ts --browser chromium
```

Expected: all 3 tests pass.

- [ ] **Step 2: Run client type checking**

Run:

```bash
rtk npm run typecheck-client
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Validate architectural import layers**

Run:

```bash
rtk npm run valid-layers-check
```

Expected: PASS; the new common helper imports only `vs/base` and `vs/platform`, and the browser contribution may import the common helper.

- [ ] **Step 4: Run repository lint and hygiene checks**

Run:

```bash
rtk npm run eslint
rtk npm run precommit
```

Expected: both commands pass without warnings or errors.

- [ ] **Step 5: Confirm only the user's pre-existing changes remain uncommitted**

Run:

```bash
rtk git status --short
rtk git log -3 --oneline
```

Expected: no uncommitted files from this implementation. The pre-existing `extensions/copilot/.esbuild.mts` modification and `.serena/` directory may still appear and must remain untouched. The recent history contains the design, implementation, and changelog `para:` commits.
