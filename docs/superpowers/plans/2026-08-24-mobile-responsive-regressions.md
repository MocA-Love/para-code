# Mobile Responsive Regressions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iPhone 13を含む狭幅端末で失われたTerminal/Home/Changes/Session historyの操作入口を復旧し、WebViewとdiffの狭幅調査中に確定した回帰もテストで固定する。

**Architecture:** Mobile React Native側は既存size classを入力にする副作用のない表示モデルを先に作り、compactでは固定幅メニュー、regularでは現行の個別操作を選ぶ。Web phone Changesはsessions core層から直接`MenuId.AgentsChangesToolbar`を描画し、WebView・diff・Session historyは各判定／parser／実CSS cascadeの最小修正に限定する。

**Tech Stack:** TypeScript、React 19、React Native 0.86、Expo Router 57、Vitest 2、VS Code browser unit tests（Mocha + Playwright Chromium）、VS Code Electron renderer tests、CSS container queries。

**Spec:** docs/superpowers/specs/2026-08-24-regression-resource-mobile-audit-design.md

## Global Constraints

- この計画の対象は設計書の修正対象#1〜#7だけとし、別計画の#8〜#27および「対象外」の候補を変更しない。
- 実装は各Taskで必ず回帰テストを先に追加し、REDを確認してからproduction codeを変更する。
- compact判定には既存の`SizeClass`を使い、390pt、375pt、320ptは固定幅の単一メニュー、regular iPadは既存の個別操作を維持する。
- native menuがないAndroid／旧iOSでもTerminalの切替入口を失わせず、fallback帯は本文の通常フローに置いて`TermView`と入力欄を覆わない。
- Terminal/Homeのmenu itemは既存callbackへ委譲し、terminal作成、route遷移、音声通知、既読化などの業務ロジックを複製しない。
- Web phone Changesは`MenuId.AgentsChangesToolbar`を直接`MenuWorkbenchToolBar`へ渡し、`src/vs/sessions/browser`から`src/vs/sessions/contrib`をimportしない。
- Changes toolbarにはactive sessionの`resource`をmenu argumentとして渡し、compact headerでは全actionをoverflowへまとめる。
- WebViewは`request.isTopFrame === false`だけをiframeとして扱い、`undefined`と`true`には同じトップフレーム規則を適用する。
- diff parserは`diff --git`でhunk状態をresetし、有効な`@@`だけでhunkへ入り、hunk内の`+++value`／`---value`を内容行として保持する。
- Session historyのCSS修正はsource text検査だけで完了扱いにせず、実stylesheetを読み込むElectron renderer testで599px／600pxの`getComputedStyle(...).display`を確認する。
- PR #42で保持済みと確認したParaCode独自領域やupstream所有コードは、この7件に直接必要なファイル以外変更しない。
- 新しいruntime dependencyは追加しない。各TaskのcommitにはそのTaskのproduction/testファイルだけを含める。
- ファイル編集には`apply_patch`を使い、すべてのshell commandは`rtk`を先頭に付ける。
- Mobile TypeScriptには計画開始時点から`src/relayClientPresence.test.ts`の`TS2532`が13件ある。各GREEN stepでは下記の`awk`付きcommandで診断を全件表示し、「13件すべてがその既知file/error code」である場合だけ成功とする。変更file由来または別codeの診断、件数変化、typecheck自体の異常終了を新規失敗として扱う。

---

### Task 1: Compact Terminal Header Menu

**Files:**

- Create: `app/mobile/src/components/terminalHeaderBehavior.ts`
- Create: `app/mobile/src/components/terminalHeaderBehavior.test.ts`
- Modify: `app/mobile/src/components/terminalPicker.tsx:24-116`
- Modify: `app/mobile/app/(tabs)/terminal.tsx:136-208`

**Interfaces:**

- Consumes: `SizeClass` from `app/mobile/src/sizeClass.ts` and the existing `TerminalPickerEntry` shape `{ terminalKey, title, index, waiting, working }`.
- Produces: `terminalNativeHeaderLayout(sizeClass: SizeClass): TerminalNativeHeaderLayout`, `decodeTerminalCompactMenuAction(id: string): TerminalCompactMenuAction | undefined`, `COMPACT_TERMINAL_MENU_WIDTH = 44`, and `TerminalCompactMenu` with callbacks `onSelect`, `onOpenPresets`, and `onCreate`.
- Preserves: `TerminalPicker` remains the regular-width variable-label picker; callers without a native menu still receive the two existing preset/create actions.

- [ ] **Step 1: Write the failing test**

Create `app/mobile/src/components/terminalHeaderBehavior.test.ts` with the exact compact widths and action decoding contract:

```ts
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { sizeClassFor } from '../sizeClass.js';
import {
	COMPACT_TERMINAL_MENU_WIDTH,
	decodeTerminalCompactMenuAction,
	terminalNativeHeaderLayout,
} from './terminalHeaderBehavior.js';
import { TerminalCompactMenu } from './terminalPicker.js';

vi.mock('react-native', () => ({
	Platform: { OS: 'ios' },
	Pressable: 'Pressable',
	ScrollView: 'ScrollView',
	StyleSheet: { create: <T>(value: T) => value },
	Text: 'Text',
	View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../../modules/para-plus-menu/index.js', () => ({ ParaPlusMenuButton: 'ParaPlusMenuButton' }));
vi.mock('./glassSurface.js', () => ({ GlassSurface: 'GlassSurface' }));
vi.mock('../haptics.js', () => ({ hapticSelection: vi.fn() }));
vi.mock('../theme.js', () => ({
	colors: new Proxy({}, { get: () => '#000000' }),
	mono: { ios: 'Menlo' },
	radius: { pill: 999 },
	squircle: {},
}));

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('terminal header behavior', () => {
	test.each([390, 375, 320])('uses one fixed 44pt menu at %ipt', width => {
		const layout = terminalNativeHeaderLayout(sizeClassFor(width, false));
			expect({ width, layout }).toEqual({
			width,
			layout: { kind: 'compact-menu', headerItemCount: 1, itemWidth: 44 },
		});
		expect(COMPACT_TERMINAL_MENU_WIDTH).toBe(44);
	});

	test('keeps the existing three header items on a regular iPad', () => {
		expect(terminalNativeHeaderLayout(sizeClassFor(744, true))).toEqual({
			kind: 'regular-actions',
			headerItemCount: 3,
		});
	});

	test('decodes terminal, preset, and create selections without mixing their callbacks', () => {
		expect([
			decodeTerminalCompactMenuAction('pick:terminal-2'),
			decodeTerminalCompactMenuAction('presets'),
			decodeTerminalCompactMenuAction('new-terminal'),
			decodeTerminalCompactMenuAction('pick:'),
		]).toEqual([
			{ kind: 'terminal', terminalKey: 'terminal-2' },
			{ kind: 'presets' },
			{ kind: 'create' },
			undefined,
		]);
	});

	test('renders one fixed native component and invokes each existing callback', () => {
		const events: string[] = [];
		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(TerminalCompactMenu, {
				entries: [
					{ terminalKey: 'terminal-1', title: 'First', index: 1, waiting: false, working: false },
					{ terminalKey: 'terminal-2', title: 'Second', index: 2, waiting: true, working: false },
				],
				activeKey: 'terminal-1',
				onSelect: terminalKey => events.push(`terminal:${terminalKey}`),
				onOpenPresets: () => events.push('presets'),
				onCreate: () => events.push('create'),
			}));
		});
		const button = renderer!.root.findByType('ParaPlusMenuButton');
		const leafIds = button.props.items.flatMap((item: { id: string; children?: readonly { id: string }[] }) =>
			item.children?.map(child => child.id) ?? [item.id]);
		expect({ style: button.props.style, leafIds }).toEqual({
			style: { width: 44, height: 44 },
			leafIds: ['pick:terminal-1', 'pick:terminal-2', 'presets', 'new-terminal'],
		});
		act(() => {
			button.props.onSelect({ nativeEvent: { id: 'pick:terminal-2' } });
			button.props.onSelect({ nativeEvent: { id: 'presets' } });
			button.props.onSelect({ nativeEvent: { id: 'new-terminal' } });
		});
		expect(events).toEqual(['terminal:terminal-2', 'presets', 'create']);
		act(() => renderer!.unmount());
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm --dir app/mobile vitest run src/components/terminalHeaderBehavior.test.ts`

Expected: FAIL because `terminalHeaderBehavior.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `app/mobile/src/components/terminalHeaderBehavior.ts` as the pure decision boundary:

```ts
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { SizeClass } from '../sizeClass.js';

export const COMPACT_TERMINAL_MENU_WIDTH = 44;
export const TERMINAL_PICK_PREFIX = 'pick:';
export const TERMINAL_PRESETS_ACTION_ID = 'presets';
export const TERMINAL_CREATE_ACTION_ID = 'new-terminal';

export type TerminalNativeHeaderLayout =
	| { readonly kind: 'compact-menu'; readonly headerItemCount: 1; readonly itemWidth: 44 }
	| { readonly kind: 'regular-actions'; readonly headerItemCount: 3 };

export type TerminalCompactMenuAction =
	| { readonly kind: 'terminal'; readonly terminalKey: string }
	| { readonly kind: 'presets' }
	| { readonly kind: 'create' };

export function terminalNativeHeaderLayout(sizeClass: SizeClass): TerminalNativeHeaderLayout {
	return sizeClass === 'compact'
		? { kind: 'compact-menu', headerItemCount: 1, itemWidth: COMPACT_TERMINAL_MENU_WIDTH }
		: { kind: 'regular-actions', headerItemCount: 3 };
}

export function decodeTerminalCompactMenuAction(id: string): TerminalCompactMenuAction | undefined {
	if (id.startsWith(TERMINAL_PICK_PREFIX)) {
		const terminalKey = id.slice(TERMINAL_PICK_PREFIX.length);
		return terminalKey.length > 0 ? { kind: 'terminal', terminalKey } : undefined;
	}
	if (id === TERMINAL_PRESETS_ACTION_ID) {
		return { kind: 'presets' };
	}
	if (id === TERMINAL_CREATE_ACTION_ID) {
		return { kind: 'create' };
	}
	return undefined;
}
```

In `terminalPicker.tsx`, import the constants/decoder, remove the local `PICK_PREFIX`, keep `TerminalPicker` unchanged apart from using `TERMINAL_PICK_PREFIX`, and add this fixed-width component:

```tsx
export function TerminalCompactMenu({ entries, activeKey, onSelect, onOpenPresets, onCreate }: {
	entries: readonly TerminalPickerEntry[];
	activeKey: string | undefined;
	onSelect: (terminalKey: string) => void;
	onOpenPresets: () => void;
	onCreate: () => void;
}) {
	if (ParaPlusMenuButton === undefined) {
		return null;
	}

	const items: ParaPlusMenuItem[] = [];
	if (entries.length > 0) {
		items.push({
			id: 'terminals',
			title: 'ターミナルを切り替える',
			systemImage: 'terminal',
			children: entries.map(entry => ({
				id: `${TERMINAL_PICK_PREFIX}${entry.terminalKey}`,
				title: `${entry.index}: ${entry.title}`,
				systemImage: entry.waiting ? 'questionmark.circle' : entry.working ? 'play.circle' : '',
				selected: entry.terminalKey === activeKey,
			})),
		});
	}
	items.push(
		{ id: TERMINAL_PRESETS_ACTION_ID, title: 'コマンドプリセット', systemImage: 'bolt', startsSection: true },
		{ id: TERMINAL_CREATE_ACTION_ID, title: '新しいターミナル', systemImage: 'plus' },
	);

	return (
		<ParaPlusMenuButton
			style={styles.compactMenu}
			symbol="ellipsis.circle"
			items={items}
			accessibilityTitle="ターミナル操作"
			onSelect={event => {
				const action = decodeTerminalCompactMenuAction(event.nativeEvent.id);
				if (action?.kind === 'terminal') {
					hapticSelection();
					onSelect(action.terminalKey);
				} else if (action?.kind === 'presets') {
					hapticSelection();
					onOpenPresets();
				} else if (action?.kind === 'create') {
					onCreate();
				}
			}}
		/>
	);
}
```

Add the concrete style so the compact menu cannot grow with the active terminal title:

```ts
compactMenu: {
	width: COMPACT_TERMINAL_MENU_WIDTH,
	height: COMPACT_TERMINAL_MENU_WIDTH,
},
```

In `terminal.tsx`, import `useSizeClass` from `../../src/hooks/useSizeClass.js`, import `terminalNativeHeaderLayout` from `../../src/components/terminalHeaderBehavior.js`, and add `TerminalCompactMenu` to the existing `terminalPicker.js` import. Then call `useSizeClass()` and replace the header-action construction with this branch. The existing `createHere`, `pickerEntries`, `otherWaiting`, and `setPresetsOpen` callbacks are reused verbatim:

```tsx
const sizeClass = useSizeClass();
const nativeHeaderLayout = terminalNativeHeaderLayout(sizeClass);

const actions = useMemo<ParaHeaderIcon[]>(() => {
	const operationalActions: ParaHeaderIcon[] = [
		{
			key: 'presets',
			icon: 'flash-outline',
			label: 'コマンドプリセット',
			size: 19,
			onPress: () => { hapticSelection(); setPresetsOpen(true); },
		},
		{
			key: 'new-terminal',
			icon: 'add',
			label: '新しいターミナル',
			size: 21,
			onPress: createHere,
		},
	];
	if (!terminalPickerIsNative) {
		return operationalActions;
	}
	if (nativeHeaderLayout.kind === 'compact-menu') {
		return [{
			key: 'terminal-menu',
			label: 'ターミナル操作',
			badge: otherWaiting ? 'red' : undefined,
			node: (
				<TerminalCompactMenu
					entries={pickerEntries}
					activeKey={activeKey}
					onSelect={setSelectedTerminalKey}
					onOpenPresets={() => setPresetsOpen(true)}
					onCreate={createHere}
				/>
			),
		}];
	}
	return [{
		key: 'picker',
		label: 'ターミナルを切り替える',
		badge: otherWaiting ? 'red' : undefined,
		node: (
			<TerminalPicker
				entries={pickerEntries}
				activeKey={activeKey}
				onSelect={setSelectedTerminalKey}
				onCreate={createHere}
			/>
		),
	}, ...operationalActions];
}, [activeKey, createHere, nativeHeaderLayout.kind, otherWaiting, pickerEntries, setSelectedTerminalKey]);
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk pnpm --dir app/mobile vitest run src/components/terminalHeaderBehavior.test.ts src/sizeClass.test.ts
rtk pnpm --dir app/mobile typecheck 2>&1 | rtk awk '
	{ print }
	/error TS/ { errorCount++; if ($0 !~ /src\/relayClientPresence\.test\.ts.*error TS2532/) { unexpectedCount++; } }
	END { if (errorCount != 13 || unexpectedCount != 0) { exit 1; } }
'
```

Expected: both Vitest files PASS. The typecheck validator prints exactly the 13 known `relayClientPresence.test.ts` `TS2532` diagnostics and exits 0, with no changed-file diagnostic. On an iOS simulator, `rtk pnpm --dir app/mobile ios` must show one 44pt Terminal menu at iPhone 13 width; its submenu must switch terminals, open presets, and create a terminal. At regular iPad width the title picker plus the two existing buttons must remain separate. If the simulator is unavailable, record that fact in the PR and retain the 390/375/320pt test output as the required evidence.

- [ ] **Step 5: Commit**

```bash
rtk git add app/mobile/src/components/terminalHeaderBehavior.ts app/mobile/src/components/terminalHeaderBehavior.test.ts app/mobile/src/components/terminalPicker.tsx 'app/mobile/app/(tabs)/terminal.tsx'
rtk git commit -m "fix(mobile): compact terminal header actions"
```

---

### Task 2: Terminal Fallback Band in Body Flow

**Files:**

- Modify: `app/mobile/src/components/terminalHeaderBehavior.ts`
- Modify: `app/mobile/src/components/terminalHeaderBehavior.test.ts`
- Modify: `app/mobile/src/components/terminalPicker.tsx`
- Modify: `app/mobile/app/(tabs)/terminal.tsx:199-319`
- Modify: `app/mobile/src/components/wsDrawer.tsx:692-783`

**Interfaces:**

- Consumes: `terminalPickerIsNative: boolean`, terminal count, `chipBand`, `useParaHeaderHeight()`, and the two existing preset/create header actions from Task 1.
- Produces: `terminalFallbackPlacement(nativeMenuAvailable: boolean, terminalCount: number): 'body' | 'none'` and a normal-flow `terminalBody` wrapper whose fallback band consumes height above `outputSlot`.
- Removes: the unused `below` property from `useWsHeader`; no caller may rely on an argument that native navigation silently discards.

- [ ] **Step 1: Write the failing test**

Add `terminalFallbackPlacement` to the existing `terminalHeaderBehavior.js` import, add `TerminalFallbackBand` to the existing `terminalPicker.js` import, and append the placement plus component-selection case:

```ts
test('renders non-native terminal switching in the body only when terminals exist', () => {
	expect([
		terminalFallbackPlacement(false, 2),
		terminalFallbackPlacement(false, 0),
		terminalFallbackPlacement(true, 2),
	]).toEqual(['body', 'none', 'none']);
});

test('fallback band renders every terminal and forwards the tapped terminal key', () => {
	const selected: string[] = [];
	let renderer: ReactTestRenderer | undefined;
	act(() => {
		renderer = create(createElement(TerminalFallbackBand, {
			entries: [
				{ terminalKey: 'terminal-1', title: 'First', index: 1, waiting: false, working: true },
				{ terminalKey: 'terminal-2', title: 'Second', index: 2, waiting: true, working: false },
			],
			activeKey: 'terminal-1',
			onSelect: terminalKey => selected.push(terminalKey),
		}));
	});
	const chips = renderer!.root.findAllByType('Pressable');
	expect(chips).toHaveLength(2);
	act(() => chips[1].props.onPress());
	expect(selected).toEqual(['terminal-2']);
	act(() => renderer!.unmount());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm --dir app/mobile vitest run src/components/terminalHeaderBehavior.test.ts`

Expected: FAIL because `terminalFallbackPlacement` and `TerminalFallbackBand` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add the pure placement decision to `terminalHeaderBehavior.ts`:

```ts
export type TerminalFallbackPlacement = 'body' | 'none';

export function terminalFallbackPlacement(nativeMenuAvailable: boolean, terminalCount: number): TerminalFallbackPlacement {
	return !nativeMenuAvailable && terminalCount > 0 ? 'body' : 'none';
}
```

In `terminalPicker.tsx`, import `Pressable`, `ScrollView`, `Platform`, `GlassSurface`, `radius`, and `squircle`, then add the fallback component. It consumes the same `TerminalPickerEntry[]` model as both native menus, and invokes the route's existing `setSelectedTerminalKey` callback:

```tsx
export function TerminalFallbackBand({ entries, activeKey, onSelect }: {
	entries: readonly TerminalPickerEntry[];
	activeKey: string | undefined;
	onSelect: (terminalKey: string) => void;
}) {
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fallbackTabContent}>
			{entries.map(entry => {
				const active = entry.terminalKey === activeKey;
				const body = (
					<Pressable
						style={styles.fallbackTabHit}
						onPress={() => { hapticSelection(); onSelect(entry.terminalKey); }}
						accessibilityRole="button"
						accessibilityState={{ selected: active }}
					>
						{entry.waiting
							? <View style={styles.fallbackDotWaiting} />
							: entry.working ? <View style={styles.fallbackDotWorking} /> : null}
						<Text style={[styles.fallbackTabText, active && styles.fallbackTabTextActive]} numberOfLines={1}>{entry.index}: {entry.title}</Text>
					</Pressable>
				);
				return active
					? <View key={entry.terminalKey} style={[styles.fallbackTabChip, styles.fallbackTabChipActive]}>{body}</View>
					: <GlassSurface key={entry.terminalKey} style={styles.fallbackTabChip} interactive>{body}</GlassSurface>;
			})}
		</ScrollView>
	);
}
```

Add the styles used by that component to `terminalPicker.tsx`:

```ts
fallbackTabContent: { gap: 7, alignItems: 'center' },
fallbackTabChip: { height: 32, borderRadius: radius.pill, ...squircle, maxWidth: 200 },
fallbackTabChipActive: { backgroundColor: 'rgba(9,175,217,0.30)', borderWidth: 1, borderColor: 'rgba(9,175,217,0.5)' },
fallbackTabHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
fallbackTabText: { color: colors.text, fontSize: 11.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
fallbackTabTextActive: { color: '#bfeeff', fontWeight: '700' },
fallbackDotWaiting: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.red },
fallbackDotWorking: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
```

In `terminal.tsx`, add `TerminalFallbackBand` to the existing `terminalPicker.js` import and import `terminalFallbackPlacement` from `../../src/components/terminalHeaderBehavior.js`. Replace the inline chip renderer with the tested component, stop passing it to `useWsHeader`, and put it in the body’s normal layout flow:

```tsx
const fallbackPlacement = terminalFallbackPlacement(terminalPickerIsNative, terminals.length);
const chipBand = useMemo(() => (fallbackPlacement === 'body' ? (
	<TerminalFallbackBand entries={pickerEntries} activeKey={activeKey} onSelect={setSelectedTerminalKey} />
) : undefined), [activeKey, fallbackPlacement, pickerEntries, setSelectedTerminalKey]);

useWsHeader({ actions });
```

Move the existing special-key controls out of the `GlassComposer` prop into this local constant immediately before the screen return; this is a mechanical move and retains all nine commands and haptics:

```tsx
const terminalKeyTools = (
	<ScrollView
		horizontal
		showsHorizontalScrollIndicator={false}
		style={styles.keyRowScroll}
		contentContainerStyle={styles.keyRow}
		keyboardShouldPersistTaps="always"
	>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('\u001b'); }}><Text style={styles.keyText}>Esc</Text></Pressable>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('\t'); }}><Text style={styles.keyText}>Tab</Text></Pressable>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticWarning(); send('\u0003'); }}><Text style={[styles.keyText, styles.keyDanger]}>^C</Text></Pressable>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('up'); }}><Text style={styles.keyText}>↑</Text></Pressable>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('down'); }}><Text style={styles.keyText}>↓</Text></Pressable>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('left'); }}><Text style={styles.keyText}>←</Text></Pressable>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('right'); }}><Text style={styles.keyText}>→</Text></Pressable>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('/'); }}><Text style={styles.keyText}>/</Text></Pressable>
		<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('|'); }}><Text style={styles.keyText}>|</Text></Pressable>
	</ScrollView>
);
```

Replace the old `outputSlot` top margin with a wrapper that reserves both header and fallback-band height through normal flex layout:

```tsx
<View style={[styles.screen, { paddingBottom: keyboardCover }]}>
	<View style={[styles.terminalBody, { paddingTop: headerHeight }]}>
		{chipBand === undefined ? null : (
			<View style={styles.fallbackBand}>{chipBand}</View>
		)}
		<View
			style={styles.outputSlot}
			onLayout={event => {
				if (!isFocused && outputHeight > 0) {
					return;
				}
				const next = event.nativeEvent.layout.height;
				const nextWidth = event.nativeEvent.layout.width;
				const widthChanged = outputWidthRef.current !== 0 && Math.abs(outputWidthRef.current - nextWidth) > 0.5;
				outputWidthRef.current = nextWidth;
				if (!keyboardVisible || next > outputHeight || widthChanged) {
					setOutputHeight(next);
				}
			}}
		>
			<View style={[styles.output, outputHeight > 0 ? { height: outputHeight } : { flex: 1 }]}>
				{activeKey !== undefined ? (
					<TermView
						key={activeKey}
						output={output}
						cols={activeTerminal?.cols}
						rows={activeTerminal?.rows}
						subscribe={subscribeActive}
						onNeedResync={resyncActive}
						fontSize={isFocused && terminalPrefs.matchPcWidth ? terminalPrefs.fontSize : undefined}
						onGridChange={setGrid}
						onScroll={scroll}
					/>
				) : (
					<Text style={styles.placeholder}>(ターミナルなし — 右上の + で作成できます)</Text>
				)}
			</View>
		</View>
	</View>
	<View style={[styles.inputBar, { paddingBottom: keyboardVisible ? 8 : tabBarSpacer }]}>
		<GlassComposer
			value={input}
			onChangeText={setInput}
			onSubmit={submit}
			placeholder="コマンドまたは回答を入力…"
			sendIcon={input ? 'arrow-up' : 'return-down-back'}
			monospace
			tools={terminalKeyTools}
		/>
	</View>
</View>
```

Add these styles:

```ts
terminalBody: { flex: 1, minHeight: 0 },
fallbackBand: { flexShrink: 0, paddingHorizontal: 12, paddingVertical: 6 },
outputSlot: { flex: 1, minHeight: 0, overflow: 'hidden', justifyContent: 'flex-end' },
```

Delete the route-local `tabContent`, `tabChip`, `tabChipActive`, `tabHit`, `tabText`, `tabTextActive`, `dotRed`, and `dotGreen` style entries and its now-unused `GlassSurface` import; those exact responsibilities moved to `TerminalFallbackBand`.

Finally, remove `below` from the `useWsHeader` parameter type, destructuring, `ParaHeaderSpec` construction, and dependency array in `wsDrawer.tsx`:

```ts
export function useWsHeader({ subtitle, actions, mid, allWorkspaces, wide = false }: {
	subtitle?: string;
	actions?: readonly ParaHeaderIcon[];
	mid?: ParaHeaderSpec['mid'];
	allWorkspaces?: boolean;
	wide?: boolean;
}) {
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk pnpm --dir app/mobile vitest run src/components/terminalHeaderBehavior.test.ts
rtk pnpm --dir app/mobile typecheck 2>&1 | rtk awk '
	{ print }
	/error TS/ { errorCount++; if ($0 !~ /src\/relayClientPresence\.test\.ts.*error TS2532/) { unexpectedCount++; } }
	END { if (errorCount != 13 || unexpectedCount != 0) { exit 1; } }
'
```

Expected: Vitest PASS, followed by only the 13 known baseline diagnostics and a successful validator exit. On an Android emulator, run `rtk pnpm --dir app/mobile android`, expose at least two terminals, tap both chips, and confirm the selected output changes while the fallback band, `TermView`, and input composer remain simultaneously visible. If the emulator is unavailable, record that limitation in the PR; do not replace the placement test with a source-text assertion.

- [ ] **Step 5: Commit**

```bash
rtk git add app/mobile/src/components/terminalHeaderBehavior.ts app/mobile/src/components/terminalHeaderBehavior.test.ts app/mobile/src/components/terminalPicker.tsx 'app/mobile/app/(tabs)/terminal.tsx' app/mobile/src/components/wsDrawer.tsx
rtk git commit -m "fix(mobile): render terminal fallback in body"
```

---

### Task 3: Compact Home Overflow Menu

**Files:**

- Create: `app/mobile/src/components/homeHeaderMenuBehavior.ts`
- Create: `app/mobile/src/components/homeHeaderMenuBehavior.test.ts`
- Modify: `app/mobile/src/components/homePlusMenu.tsx:44-211`
- Modify: `app/mobile/src/components/voiceNotificationControl.tsx:16-112`
- Modify: `app/mobile/app/(tabs)/index.tsx:68-102,304-381,500-535`

**Interfaces:**

- Consumes: `SizeClass`, `archivedCount`, `voiceNotifications.desired`, agent-question notification count, `ackCount`, `hasSpace`, and the existing `onPlusMenuSelect(HomePlusMenuAction)` callback.
- Produces: `homeHeaderLayout(sizeClass: SizeClass): HomeHeaderLayout`, `buildHomeHeaderMenuItems(options): HomeHeaderMenuItem[]`, `dispatchHomeHeaderMenuAction(action, handlers): void`, `HomeHeaderMenuAction`, and controlled props `visible?: boolean` / `onClose?: () => void` on `VoiceNotificationControl`.
- Preserves: regular width still renders archive, voice, notifications, and plus as separate items; compact width renders exactly one 44pt overflow item and forwards every leaf selection to an existing callback.

- [ ] **Step 1: Write the failing test**

Create `app/mobile/src/components/homeHeaderMenuBehavior.test.ts`:

```ts
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { sizeClassFor } from '../sizeClass.js';
import {
	buildHomeHeaderMenuItems,
	dispatchHomeHeaderMenuAction,
	homeHeaderLayout,
	type HomeHeaderMenuAction,
	type HomeHeaderMenuHandlers,
	type HomeHeaderMenuItem,
	type HomePlusMenuAction,
} from './homeHeaderMenuBehavior.js';
import { HomePlusMenuButton } from './homePlusMenu.js';
import { VoiceNotificationControl } from './voiceNotificationControl.js';

vi.mock('react-native', () => ({
	ActivityIndicator: 'ActivityIndicator',
	BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
	Platform: { OS: 'ios' },
	Pressable: 'Pressable',
	ScrollView: 'ScrollView',
	StyleSheet: { hairlineWidth: 1, create: <T>(value: T) => value },
	Text: 'Text',
	View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../../modules/para-plus-menu/index.js', () => ({ ParaPlusMenuButton: 'ParaPlusMenuButton' }));
vi.mock('./glassSurface.js', () => ({ GlassSurface: 'GlassSurface' }));
vi.mock('./bottomSheet.js', () => ({ BottomSheet: 'BottomSheet' }));
vi.mock('./overlayHost.js', () => ({ OverlayPortal: 'OverlayPortal', PopIn: 'PopIn' }));
vi.mock('../paraHeader.js', () => ({ PARA_HEADER_PILL_BUTTON: 34, PARA_HEADER_SLOT_HEIGHT: 44 }));
vi.mock('../hooks/useStableInsets.js', () => ({ useStableInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock('../haptics.js', () => ({ hapticImpact: vi.fn() }));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(selector: T) => selector }));
vi.mock('../appState.js', () => ({
	useAppStore: (selector: (state: {
		voiceNotifications: { desired: boolean; status: 'idle'; error: undefined };
		pcOnline: boolean;
		startVoiceNotifications: () => void;
		stopVoiceNotifications: () => void;
	}) => unknown) => selector({
		voiceNotifications: { desired: false, status: 'idle', error: undefined },
		pcOnline: true,
		startVoiceNotifications: vi.fn(),
		stopVoiceNotifications: vi.fn(),
	}),
}));
vi.mock('../theme.js', () => ({
	colors: new Proxy({}, { get: () => '#000000' }),
	radius: { pill: 999 },
	squircle: {},
}));

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
	delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function leafIds(items: readonly HomeHeaderMenuItem[]): string[] {
	return items.flatMap(item => item.children === undefined ? [item.id] : leafIds(item.children));
}

describe('home header menu behavior', () => {
	test.each([390, 375, 320])('uses one fixed overflow item at %ipt', width => {
		expect(homeHeaderLayout(sizeClassFor(width, false))).toEqual({
			kind: 'compact-menu',
			headerItemCount: 1,
			itemWidth: 44,
		});
	});

	test('keeps separate actions at regular iPad width', () => {
		expect(homeHeaderLayout(sizeClassFor(744, true))).toEqual({ kind: 'regular-actions' });
	});

	test('compact menu exposes archive, voice, notifications, and every existing plus action', () => {
		const items = buildHomeHeaderMenuItems({
			compact: true,
			archivedCount: 2,
			voiceActive: true,
			notificationQuestionCount: 3,
			ackCount: 1,
			hasSpace: true,
		});
		expect(leafIds(items)).toEqual([
			'archive',
			'voice-notifications',
			'notifications',
			'launch-claude',
			'launch-codex',
			'new-terminal',
			'new-worktree',
			'space-note',
			'sort',
			'ack-all',
		]);
	});

	test('dispatches header-only actions and forwards creation actions unchanged', () => {
		const events: string[] = [];
		const handlers: HomeHeaderMenuHandlers = {
			onArchive: vi.fn(() => events.push('archive')),
			onVoiceNotifications: vi.fn(() => events.push('voice')),
			onNotifications: vi.fn(() => events.push('notifications')),
			onPlusMenuSelect: vi.fn((action: HomePlusMenuAction) => events.push(`plus:${action}`)),
		};
		dispatchHomeHeaderMenuAction('archive', handlers);
		dispatchHomeHeaderMenuAction('voice-notifications', handlers);
		dispatchHomeHeaderMenuAction('notifications', handlers);
		dispatchHomeHeaderMenuAction('new-worktree', handlers);
		expect(events).toEqual(['archive', 'voice', 'notifications', 'plus:new-worktree']);
	});

	test('compact HomePlusMenuButton is 44pt and forwards visible menu leaves', () => {
		const selected: HomeHeaderMenuAction[] = [];
		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(HomePlusMenuButton, {
				compact: true,
				archivedCount: 2,
				voiceActive: true,
				notificationQuestionCount: 3,
				ackCount: 1,
				hasSpace: true,
				onSelect: action => selected.push(action),
			}));
		});
		const button = renderer!.root.findByType('ParaPlusMenuButton');
		const ids = button.props.items.flatMap((item: { id: string; children?: readonly { id: string }[] }) =>
			item.children?.map(child => child.id) ?? [item.id]);
		expect(button.props.style).toMatchObject({ width: 44, height: 44 });
		expect(ids).toEqual([
			'archive',
			'voice-notifications',
			'notifications',
			'launch-claude',
			'launch-codex',
			'new-terminal',
			'new-worktree',
			'space-note',
			'sort',
			'ack-all',
		]);
		act(() => {
			button.props.onSelect({ nativeEvent: { id: 'archive' } });
			button.props.onSelect({ nativeEvent: { id: 'new-worktree' } });
		});
		expect(selected).toEqual(['archive', 'new-worktree']);
		act(() => renderer!.unmount());
	});

	test('controlled voice sheet is visible without adding its header button', () => {
		const onClose = vi.fn();
		let renderer: ReactTestRenderer | undefined;
		act(() => {
			renderer = create(createElement(VoiceNotificationControl, { visible: true, onClose }));
		});
		const sheet = renderer!.root.findByType('BottomSheet');
		expect({ visible: sheet.props.visible, pressables: renderer!.root.findAllByType('Pressable').length }).toEqual({
			visible: true,
			pressables: 1,
		});
		act(() => sheet.props.onClose());
		expect(onClose).toHaveBeenCalledOnce();
		act(() => renderer!.unmount());
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm --dir app/mobile vitest run src/components/homeHeaderMenuBehavior.test.ts`

Expected: FAIL because `homeHeaderMenuBehavior.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `homeHeaderMenuBehavior.ts` with the complete menu model and dispatcher:

```ts
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { SizeClass } from '../sizeClass.js';

export type HomePlusMenuAction =
	| 'launch-claude'
	| 'launch-codex'
	| 'new-terminal'
	| 'new-worktree'
	| 'space-note'
	| 'sort'
	| 'ack-all';

export type HomeHeaderMenuAction = HomePlusMenuAction | 'archive' | 'voice-notifications' | 'notifications';

export interface HomeHeaderMenuItem {
	readonly id: HomeHeaderMenuAction | 'agent';
	readonly title: string;
	readonly fallbackTitle: string;
	readonly systemImage: string;
	readonly fallbackIcon: string;
	readonly startsSection?: boolean;
	readonly children?: readonly HomeHeaderMenuItem[];
}

export type HomeHeaderLayout =
	| { readonly kind: 'compact-menu'; readonly headerItemCount: 1; readonly itemWidth: 44 }
	| { readonly kind: 'regular-actions' };

export interface HomeHeaderMenuOptions {
	readonly compact: boolean;
	readonly archivedCount: number;
	readonly voiceActive: boolean;
	readonly notificationQuestionCount: number;
	readonly ackCount: number;
	readonly hasSpace: boolean;
}

export interface HomeHeaderMenuHandlers {
	readonly onArchive: () => void;
	readonly onVoiceNotifications: () => void;
	readonly onNotifications: () => void;
	readonly onPlusMenuSelect: (action: HomePlusMenuAction) => void;
}

const AGENT_CHILDREN: readonly HomeHeaderMenuItem[] = [
	{ id: 'launch-claude', title: 'Claude', fallbackTitle: 'Claude を起動', systemImage: 'sparkles', fallbackIcon: 'sparkles-outline' },
	{ id: 'launch-codex', title: 'Codex', fallbackTitle: 'Codex を起動', systemImage: 'chevron.left.forwardslash.chevron.right', fallbackIcon: 'code-slash-outline' },
	{ id: 'new-terminal', title: 'ターミナル', fallbackTitle: 'ターミナルを起動', systemImage: 'terminal', fallbackIcon: 'terminal-outline' },
];

export function homeHeaderLayout(sizeClass: SizeClass): HomeHeaderLayout {
	return sizeClass === 'compact'
		? { kind: 'compact-menu', headerItemCount: 1, itemWidth: 44 }
		: { kind: 'regular-actions' };
}

export function buildHomeHeaderMenuItems(options: HomeHeaderMenuOptions): HomeHeaderMenuItem[] {
	const items: HomeHeaderMenuItem[] = [];
	if (options.compact) {
		if (options.archivedCount > 0) {
			items.push({ id: 'archive', title: `アーカイブ（${options.archivedCount}件）`, fallbackTitle: `アーカイブ ${options.archivedCount}件を見る`, systemImage: 'archivebox', fallbackIcon: 'file-tray-full-outline' });
		}
		items.push(
			{ id: 'voice-notifications', title: options.voiceActive ? '音声通知（受信中）' : '音声通知', fallbackTitle: '音声通知', systemImage: options.voiceActive ? 'speaker.wave.2.fill' : 'speaker.wave.2', fallbackIcon: options.voiceActive ? 'volume-high' : 'volume-high-outline' },
			{ id: 'notifications', title: options.notificationQuestionCount > 0 ? `通知（応答待ち ${options.notificationQuestionCount}件）` : '通知', fallbackTitle: '通知', systemImage: 'bell', fallbackIcon: 'notifications-outline' },
		);
	}
	items.push({
		id: 'agent',
		title: 'エージェントを起動',
		fallbackTitle: 'エージェントを起動',
		systemImage: 'sparkles',
		fallbackIcon: 'sparkles-outline',
		startsSection: options.compact,
		children: AGENT_CHILDREN,
	});
	items.push({ id: 'new-worktree', title: 'ワークツリーを作成', fallbackTitle: 'ワークツリーを作成', systemImage: 'arrow.triangle.branch', fallbackIcon: 'git-branch-outline', startsSection: true });
	if (options.hasSpace) {
		items.push({ id: 'space-note', title: 'メモ', fallbackTitle: 'メモ', systemImage: 'doc.text', fallbackIcon: 'document-text-outline' });
	}
	items.push({ id: 'sort', title: '並び替えと絞り込み', fallbackTitle: '並び替えと絞り込み', systemImage: 'arrow.up.arrow.down', fallbackIcon: 'swap-vertical-outline', startsSection: true });
	if (options.ackCount > 0) {
		items.push({ id: 'ack-all', title: 'すべて確認済みにする', fallbackTitle: 'すべて確認済みにする', systemImage: 'checkmark.circle', fallbackIcon: 'checkmark-done-outline' });
	}
	return items;
}

export function dispatchHomeHeaderMenuAction(action: HomeHeaderMenuAction, handlers: HomeHeaderMenuHandlers): void {
	if (action === 'archive') {
		handlers.onArchive();
	} else if (action === 'voice-notifications') {
		handlers.onVoiceNotifications();
	} else if (action === 'notifications') {
		handlers.onNotifications();
	} else {
		handlers.onPlusMenuSelect(action);
	}
}
```

In `homePlusMenu.tsx`, remove the local action union and `AGENT_CHILDREN`. Import the shared model locally as well as re-exporting its public action types, then replace `HomePlusMenuButton` and `FallbackPlusMenu` with these complete implementations. Both native and fallback menus now consume exactly the same item tree:

```tsx
import {
	buildHomeHeaderMenuItems,
	type HomeHeaderMenuAction,
	type HomeHeaderMenuItem,
	type HomePlusMenuAction,
} from './homeHeaderMenuBehavior.js';

export type { HomeHeaderMenuAction, HomePlusMenuAction } from './homeHeaderMenuBehavior.js';

interface HomePlusMenuProps {
	onSelect: (action: HomeHeaderMenuAction) => void;
	ackCount: number;
	hasSpace: boolean;
	compact?: boolean;
	archivedCount?: number;
	voiceActive?: boolean;
	notificationQuestionCount?: number;
}

export function HomePlusMenuButton({
	onSelect,
	ackCount,
	hasSpace,
	compact,
	archivedCount,
	voiceActive,
	notificationQuestionCount,
}: HomePlusMenuProps) {
	const menuItems = useMemo(() => buildHomeHeaderMenuItems({
		compact: compact === true,
		archivedCount: archivedCount ?? 0,
		voiceActive: voiceActive === true,
		notificationQuestionCount: notificationQuestionCount ?? 0,
		ackCount,
		hasSpace,
	}), [ackCount, archivedCount, compact, hasSpace, notificationQuestionCount, voiceActive]);

	if (ParaPlusMenuButton !== undefined) {
		const nativeItems: ParaPlusMenuItem[] = menuItems.map(item => ({
			id: item.id,
			title: item.title,
			systemImage: item.systemImage,
			startsSection: item.startsSection,
			children: item.children?.map(child => ({ id: child.id, title: child.title, systemImage: child.systemImage })),
		}));
		return (
			<ParaPlusMenuButton
				style={compact === true ? styles.compactButton : styles.nativeButton}
				symbol={compact === true ? 'ellipsis.circle' : 'plus'}
				items={nativeItems}
				accessibilityTitle={compact === true ? 'ホーム操作' : '作成と表示のメニュー'}
				onSelect={event => {
					hapticImpact('light');
					onSelect(event.nativeEvent.id as HomeHeaderMenuAction);
				}}
			/>
		);
	}
	return <FallbackPlusMenu items={menuItems} compact={compact === true} onSelect={onSelect} />;
}

function FallbackPlusMenu({ items, compact, onSelect }: {
	items: readonly HomeHeaderMenuItem[];
	compact: boolean;
	onSelect: (action: HomeHeaderMenuAction) => void;
}) {
	const [open, setOpen] = useState(false);
	const insets = useStableInsets();

	useEffect(() => {
		if (!open) {
			return;
		}
		const sub = BackHandler.addEventListener('hardwareBackPress', () => {
			setOpen(false);
			return true;
		});
		return () => sub.remove();
	}, [open]);

	const pick = (action: HomeHeaderMenuAction) => {
		hapticImpact('light');
		setOpen(false);
		onSelect(action);
	};

	return (
		<>
			<Pressable
				style={({ pressed }) => [styles.fallbackButton, compact && styles.compactButton, pressed && styles.pressed]}
				hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
				onPress={() => { hapticImpact('light'); setOpen(value => !value); }}
				accessibilityRole="button"
				accessibilityLabel={compact ? 'ホーム操作' : '作成と表示のメニュー'}
				accessibilityState={{ expanded: open }}
			>
				<Ionicons name={open ? 'close' : compact ? 'ellipsis-horizontal' : 'add'} size={21} color={colors.text} />
			</Pressable>
			{open ? (
				<OverlayPortal>
					<Pressable
						style={styles.scrim}
						onPress={() => setOpen(false)}
						accessibilityRole="button"
						accessibilityLabel="メニューを閉じる"
					/>
					<PopIn style={[styles.fallbackPanelPos, { top: insets.top + PARA_HEADER_SLOT_HEIGHT + 10 }]}>
						<GlassSurface style={styles.fallbackPanel}>
							<View style={styles.plate} pointerEvents="none" />
							<View style={styles.fallbackBody}>
								<FallbackMenuRows items={items} pick={pick} />
							</View>
						</GlassSurface>
					</PopIn>
				</OverlayPortal>
			) : null}
		</>
	);
}

function FallbackMenuRows({ items, pick }: {
	items: readonly HomeHeaderMenuItem[];
	pick: (action: HomeHeaderMenuAction) => void;
}) {
	return <>{items.map(item => (
		<View key={item.id}>
			{item.startsSection === true ? <View style={styles.divider} /> : null}
			{item.children === undefined
				? <MenuRow icon={item.fallbackIcon as keyof typeof Ionicons.glyphMap} label={item.fallbackTitle} onPress={() => pick(item.id as HomeHeaderMenuAction)} />
				: item.children.map(child => (
					<MenuRow
						key={child.id}
						icon={child.fallbackIcon as keyof typeof Ionicons.glyphMap}
						label={child.fallbackTitle}
						onPress={() => pick(child.id as HomeHeaderMenuAction)}
					/>
				))}
		</View>
	))}</>;
}
```

Add the fixed compact style next to `nativeButton`; the fallback trigger composes the same style:

```ts
compactButton: { width: 44, height: 44, borderRadius: radius.pill },
```

Make `VoiceNotificationControl` optionally controlled so compact Home can open the exact existing sheet without duplicating its store/toggle logic:

```tsx
export function VoiceNotificationControl({ visible, onClose }: {
	visible?: boolean;
	onClose?: () => void;
} = {}) {
	const [internalVisible, setInternalVisible] = useState(false);
	const { voice, pcOnline, start, stop } = useAppStore(useShallow(state => ({
		voice: state.voiceNotifications,
		pcOnline: state.pcOnline,
		start: state.startVoiceNotifications,
		stop: state.stopVoiceNotifications,
	})));
	const busy = voice.status === 'connecting';
	const active = voice.desired;
	const sheetVisible = visible ?? internalVisible;
	const closeSheet = () => {
		if (visible === undefined) {
			setInternalVisible(false);
		} else {
			onClose?.();
		}
	};
	const toggle = () => {
		hapticImpact('medium');
		if (active) {
			stop();
		} else {
			start();
		}
	};

	return (
		<>
			{visible === undefined ? (
				<Pressable
					style={({ pressed }) => [styles.headerButton, active && styles.headerButtonActive, pressed && styles.headerButtonPressed]}
					hitSlop={{ top: 5, bottom: 5, left: 4, right: 4 }}
					onPress={() => { hapticImpact('light'); setInternalVisible(true); }}
					accessibilityRole="button"
					accessibilityLabel={active ? '音声通知を受信中' : '音声通知を開始'}
				>
					<Ionicons name={active ? 'volume-high' : 'volume-high-outline'} size={17} color={active ? colors.accent : colors.text} />
					{active ? <View style={styles.liveBadge} /> : null}
				</Pressable>
			) : null}
			<BottomSheet visible={sheetVisible} onClose={closeSheet} title="音声通知" glass>
				<ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
					<View style={styles.hero}>
						<View style={[styles.heroIcon, active && styles.heroIconActive]}>
							{busy ? (
								<ActivityIndicator size="small" color={colors.accent} />
							) : (
								<Ionicons name={active ? 'radio' : 'volume-high-outline'} size={30} color={active ? colors.accent : colors.textDim} />
							)}
						</View>
						<Text style={styles.status}>{STATUS_LABELS[voice.status]}</Text>
						<Text style={styles.description}>
							{active
								? 'Macで作られたAivisの音声を、このiPhoneでも再生します。画面を閉じても受信を続けます。'
								: '必要なときだけ開始すると、Macで流れるAivisの音声をこのiPhoneでも聞けます。'}
						</Text>
					</View>

					<View style={styles.infoCard}>
						<View style={styles.infoRow}>
							<Ionicons name="desktop-outline" size={18} color={pcOnline ? colors.green : colors.textDim} />
							<View style={styles.infoText}>
								<Text style={styles.infoTitle}>接続中のPC</Text>
								<Text style={styles.infoValue}>{pcOnline ? 'オンライン' : 'オフライン・接続待ち'}</Text>
							</View>
							<View style={[styles.connectionDot, pcOnline && styles.connectionDotOnline]} />
						</View>
						<View style={styles.divider} />
						<View style={styles.infoRow}>
							<Ionicons name="apps-outline" size={18} color={colors.textDim} />
							<View style={styles.infoText}>
								<Text style={styles.infoTitle}>対象</Text>
								<Text style={styles.infoValue}>すべてのスペース</Text>
							</View>
						</View>
						<View style={styles.divider} />
						<View style={styles.infoRow}>
							<Ionicons name="lock-closed-outline" size={18} color={colors.textDim} />
							<View style={styles.infoText}>
								<Text style={styles.infoTitle}>再生について</Text>
								<Text style={styles.infoValue}>開始後はロック画面から停止できます</Text>
							</View>
						</View>
					</View>

					{voice.error ? <Text style={styles.errorText}>{voice.error}</Text> : null}
					{Platform.OS !== 'ios' ? <Text style={styles.platformNote}>現在はiOS版のみ対応しています。Android版は後日対応予定です。</Text> : null}

					<Pressable
						style={({ pressed }) => [styles.primaryButton, active && styles.stopButton, pressed && styles.pressed]}
						onPress={toggle}
						accessibilityRole="button"
						accessibilityLabel={busy ? '音声通知の開始をキャンセル' : active ? '音声通知を停止' : '音声通知を開始'}
					>
						{busy ? <Ionicons name="stop" size={17} color={colors.text} /> : <Ionicons name={active ? 'stop' : 'play'} size={17} color={active ? colors.text : colors.bg} />}
						<Text style={[styles.primaryText, active && styles.stopText]}>{busy ? '開始をキャンセル' : active ? '音声通知を停止' : '音声通知を開始'}</Text>
					</Pressable>
					<Text style={styles.footnote}>開始しない限り、iPhoneでは音声を再生しません。</Text>
				</ScrollView>
			</BottomSheet>
		</>
	);
}
```

In `app/(tabs)/index.tsx`, replace the current `HomePlusMenuAction` type import with `dispatchHomeHeaderMenuAction`, `homeHeaderLayout`, `type HomeHeaderMenuAction`, and `type HomePlusMenuAction` from `../../src/components/homeHeaderMenuBehavior.js`, while retaining the `HomePlusMenuButton` component import. Then compute the compact presentation and stable callbacks and branch the header items:

```tsx
const homeHeader = homeHeaderLayout(regular ? 'regular' : 'compact');
const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
const voiceActive = useAppStore(state => state.voiceNotifications.desired);
const notificationQuestionCount = useMemo(
	() => notifications.filter(notification => notification.kind === 'agent-question').length,
	[notifications],
);
const openArchive = useCallback(() => {
	hapticImpact('light');
	router.push('/archive');
}, [router]);
const openNotifications = useCallback(() => {
	hapticImpact('light');
	router.push('/notifications');
}, [router]);
const onHeaderMenuSelect = useCallback((action: HomeHeaderMenuAction) => {
	dispatchHomeHeaderMenuAction(action, {
		onArchive: openArchive,
		onVoiceNotifications: () => setVoiceSheetOpen(true),
		onNotifications: openNotifications,
		onPlusMenuSelect,
	});
}, [onPlusMenuSelect, openArchive, openNotifications]);

const actions = useMemo<ParaHeaderIcon[]>(() => {
	if (homeHeader.kind === 'compact-menu') {
		return [{
			key: 'home-overflow',
			label: 'ホーム操作',
			node: (
				<HomePlusMenuButton
					compact
					archivedCount={archivedCount}
					voiceActive={voiceActive}
					notificationQuestionCount={notificationQuestionCount}
					ackCount={reviewable.length}
					hasSpace={effectiveWs !== undefined}
					onSelect={onHeaderMenuSelect}
				/>
			),
		}];
	}
	return [
		...(archivedCount > 0 ? [{ key: 'archive', icon: 'file-tray-full-outline' as const, label: `アーカイブ ${archivedCount}件を見る`, onPress: openArchive }] : []),
		{ key: 'voice', label: '音声通知', node: <VoiceNotificationControl /> },
		{ key: 'notifications', label: '通知', node: <NotificationsButton notifications={notifications} /> },
		{ key: 'plus', label: '作成と表示のメニュー', node: <HomePlusMenuButton ackCount={reviewable.length} hasSpace={effectiveWs !== undefined} onSelect={onHeaderMenuSelect} /> },
	];
}, [archivedCount, effectiveWs, homeHeader.kind, notificationQuestionCount, notifications, onHeaderMenuSelect, openArchive, reviewable.length, voiceActive]);
```

Mount the controlled voice sheet next to the existing `WorktreeCreateSheet` and `HomeSortSheet` so it never occupies a header slot:

```tsx
{homeHeader.kind === 'compact-menu' ? (
	<VoiceNotificationControl visible={voiceSheetOpen} onClose={() => setVoiceSheetOpen(false)} />
) : null}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk pnpm --dir app/mobile vitest run src/components/homeHeaderMenuBehavior.test.ts src/sizeClass.test.ts
rtk pnpm --dir app/mobile typecheck 2>&1 | rtk awk '
	{ print }
	/error TS/ { errorCount++; if ($0 !~ /src\/relayClientPresence\.test\.ts.*error TS2532/) { unexpectedCount++; } }
	END { if (errorCount != 13 || unexpectedCount != 0) { exit 1; } }
'
```

Expected: Vitest PASS and the typecheck validator accepts only the 13 known baseline diagnostics. With `rtk pnpm --dir app/mobile ios`, verify at iPhone 13 and 320pt simulator widths that the one overflow menu can open archive when non-empty, open the existing voice sheet, navigate to notifications, and reach all creation items. Verify regular iPad still shows the separate controls. If those simulator profiles are unavailable, record the missing profiles in the PR and keep the width table plus rendered `HomePlusMenuButton` test as mandatory evidence.

- [ ] **Step 5: Commit**

```bash
rtk git add app/mobile/src/components/homeHeaderMenuBehavior.ts app/mobile/src/components/homeHeaderMenuBehavior.test.ts app/mobile/src/components/homePlusMenu.tsx app/mobile/src/components/voiceNotificationControl.tsx 'app/mobile/app/(tabs)/index.tsx'
rtk git commit -m "fix(mobile): compact home header actions"
```

---

### Task 4: Web Phone Changes Toolbar

**Files:**

- Create: `src/vs/sessions/test/browser/mobileChangesView.test.ts`
- Modify: `src/vs/sessions/browser/parts/mobile/contributions/mobileChangesView.ts:6-24,128-171`
- Modify: `src/vs/sessions/browser/parts/mobile/contributions/media/mobileOverlayViews.css:24-94`

**Interfaces:**

- Consumes: `ISessionsService.activeSession.get()?.resource`, `MenuId.AgentsChangesToolbar`, `MenuWorkbenchToolBar`, and `IInstantiationService.createInstance`.
- Produces: a `.mobile-changes-toolbar` as the rightmost (third DOM child) header region after Back and title information, with `menuOptions.arg` equal to the active session resource and `toolbarOptions.primaryGroup` returning `false` so all actions use the compact overflow.
- Layer boundary: imports are only from `vs/base`, `vs/platform`, `vs/workbench`, `vs/sessions/browser`, and `vs/sessions/services`; no `vs/sessions/contrib` import is permitted.

- [ ] **Step 1: Write the failing test**

Create `src/vs/sessions/test/browser/mobileChangesView.test.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { mock } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IMenuWorkbenchToolBarOptions, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { MobileChangesView } from '../../browser/parts/mobile/contributions/mobileChangesView.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../services/sessions/common/sessionsManagement.js';

suite('MobileChangesView', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('renders AgentsChangesToolbar as overflow with the active session resource', () => {
		const resource = URI.parse('test-session:/active');
		const session = {
			resource,
			changes: constObservable([]),
		} as unknown as IActiveSession;
		let toolbarArgs: unknown[] | undefined;
		const toolbar = new class extends mock<MenuWorkbenchToolBar>() {
			override dispose(): void { }
		};
		const instantiationService = {
			createInstance(ctor: unknown, ...args: unknown[]) {
				assert.strictEqual(ctor, MenuWorkbenchToolBar);
				toolbarArgs = args;
				return toolbar;
			},
		} as unknown as IInstantiationService;
		const sessionsService = {
			activeSession: constObservable(session),
		} as unknown as ISessionsService;
		const container = document.createElement('div');

		store.add(new MobileChangesView(container, () => { }, instantiationService, sessionsService));

		assert.ok(toolbarArgs);
		const options = toolbarArgs[2] as IMenuWorkbenchToolBarOptions;
		const primaryGroup = options.toolbarOptions?.primaryGroup;
		const header = container.querySelector('.mobile-overlay-header');
		assert.ok(header);
		assert.deepStrictEqual({
			menuId: toolbarArgs[1] === MenuId.AgentsChangesToolbar,
			argument: (options.menuOptions?.arg as URI | undefined)?.toString(),
			navigationIsPrimary: typeof primaryGroup === 'function' ? primaryGroup('navigation') : undefined,
			headerChildren: Array.from(header.children, child => child.className),
		}, {
			menuId: true,
			argument: resource.toString(),
			navigationIsPrimary: false,
			headerChildren: ['mobile-overlay-back-btn', 'mobile-overlay-header-info', 'mobile-changes-toolbar'],
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm run transpile-client
rtk npm run test-browser-no-install -- --run src/vs/sessions/test/browser/mobileChangesView.test.ts --browser chromium
```

Expected: FAIL because `MobileChangesView` neither creates `MenuWorkbenchToolBar` nor appends `.mobile-changes-toolbar`.

- [ ] **Step 3: Write minimal implementation**

In `mobileChangesView.ts`, import only the platform-owned menu APIs:

```ts
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
```

Rename the constructor parameter to `instantiationService` and append/register the toolbar after `subtitleEl`:

```ts
const toolbarContainer = DOM.append(header, $('div.mobile-changes-toolbar'));
const sessionResource = this.sessionsService.activeSession.get()?.resource;
this.viewStore.add(instantiationService.createInstance(
	MenuWorkbenchToolBar,
	toolbarContainer,
	MenuId.AgentsChangesToolbar,
	{
		telemetrySource: 'mobileChanges',
		menuOptions: sessionResource === undefined
			? { shouldForwardArgs: true }
			: { arg: sessionResource },
		toolbarOptions: { primaryGroup: () => false },
	},
));
```

Add compact, non-squeezing toolbar rules to `mobileOverlayViews.css`:

```css
.mobile-changes-toolbar {
	flex: 0 0 auto;
	min-width: 44px;
}

.mobile-changes-toolbar.has-no-actions {
	display: none;
}

.mobile-changes-toolbar .monaco-toolbar .action-label {
	min-width: 44px;
	min-height: 44px;
}
```

The existing `.mobile-overlay-header-info { flex: 1; min-width: 0; }` remains the shrinking title region, so header order is Back → title/subtitle → overflow toolbar → body list.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk npm run transpile-client
rtk npm run test-browser-no-install -- --run src/vs/sessions/test/browser/mobileChangesView.test.ts --browser chromium
rtk npm run typecheck-client
rtk npm run valid-layers-check
rtk npm run eslint -- src/vs/sessions/browser/parts/mobile/contributions/mobileChangesView.ts src/vs/sessions/test/browser/mobileChangesView.test.ts
rtk npm run stylelint -- src/vs/sessions/browser/parts/mobile/contributions/media/mobileOverlayViews.css
```

Expected: targeted browser test PASS, type/layer checks PASS, and lint/stylelint report no errors. In a phone-width Code OSS session with changes, open Changes and confirm the overflow menu exposes the contributed Create Pull Request/Create PR action and invokes it for the active session; record a screenshot or screen recording in the PR verification notes.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/sessions/test/browser/mobileChangesView.test.ts src/vs/sessions/browser/parts/mobile/contributions/mobileChangesView.ts src/vs/sessions/browser/parts/mobile/contributions/media/mobileOverlayViews.css
rtk git commit -m "fix(sessions): expose changes actions on phone"
```

---

### Task 5: WebView Top-Frame Guard

**Files:**

- Create: `app/mobile/src/components/webViewLinkGuard.test.ts`
- Modify: `app/mobile/src/components/webViewLinkGuard.ts:15-19`

**Interfaces:**

- Consumes: `ShouldStartLoadRequest.url`, the runtime-optional `ShouldStartLoadRequest.isTopFrame`, and `Linking.openURL(url)`.
- Produces: `guardWebViewNavigation(request): boolean` with explicit-false iframe bypass, top-level http(s) externalization, top-level javascript/data rejection, and existing safe internal-navigation allowance.

- [ ] **Step 1: Write the failing test**

Create `app/mobile/src/components/webViewLinkGuard.test.ts`:

```ts
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const openURL = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('react-native', () => ({ Linking: { openURL } }));

import { guardWebViewNavigation } from './webViewLinkGuard.js';

function request(url: string, isTopFrame?: boolean): ShouldStartLoadRequest {
	return { url, isTopFrame } as ShouldStartLoadRequest;
}

describe('guardWebViewNavigation', () => {
	beforeEach(() => openURL.mockClear());

	test('treats omitted Android isTopFrame as a top-level request', () => {
		expect(guardWebViewNavigation(request('https://example.com'))).toBe(false);
		expect(openURL).toHaveBeenCalledWith('https://example.com');
		expect(guardWebViewNavigation(request('javascript:alert(1)'))).toBe(false);
		expect(guardWebViewNavigation(request('data:text/html,unsafe'))).toBe(false);
		expect(guardWebViewNavigation(request('about:blank'))).toBe(true);
	});

	test('bypasses only an explicitly identified iframe', () => {
		expect(guardWebViewNavigation(request('https://example.com/frame', false))).toBe(true);
		expect(guardWebViewNavigation(request('javascript:frame()', false))).toBe(true);
		expect(openURL).not.toHaveBeenCalled();
	});

	test('keeps explicit top-frame behavior unchanged', () => {
		expect(guardWebViewNavigation(request('https://example.com/top', true))).toBe(false);
		expect(openURL).toHaveBeenCalledWith('https://example.com/top');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm --dir app/mobile vitest run src/components/webViewLinkGuard.test.ts`

Expected: FAIL because the omitted `isTopFrame` request currently returns `true` and never calls `Linking.openURL`.

- [ ] **Step 3: Write minimal implementation**

Replace only the iframe guard in `webViewLinkGuard.ts`:

```ts
// Android may omit isTopFrame. Only an explicit false proves this is an iframe;
// undefined must retain the top-level external-link and unsafe-scheme rules.
if (request.isTopFrame === false) {
	return true;
}
```

Leave the http(s), javascript/data, and internal-navigation branches unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk pnpm --dir app/mobile vitest run src/components/webViewLinkGuard.test.ts src/components/webViewScriptPolicy.test.ts
rtk pnpm --dir app/mobile typecheck 2>&1 | rtk awk '
	{ print }
	/error TS/ { errorCount++; if ($0 !~ /src\/relayClientPresence\.test\.ts.*error TS2532/) { unexpectedCount++; } }
	END { if (errorCount != 13 || unexpectedCount != 0) { exit 1; } }
'
```

Expected: both Vitest files PASS and the typecheck validator accepts only the 13 known baseline diagnostics. The existing script policy test remains green, demonstrating that this change affects navigation classification rather than JavaScript enablement.

- [ ] **Step 5: Commit**

```bash
rtk git add app/mobile/src/components/webViewLinkGuard.ts app/mobile/src/components/webViewLinkGuard.test.ts
rtk git commit -m "fix(mobile): guard omitted top-frame metadata"
```

---

### Task 6: Hunk-Aware Unified Diff Parsing

**Files:**

- Modify: `app/mobile/src/components/diffParser.test.ts`
- Modify: `app/mobile/src/components/diffParser.ts:15-52`

**Interfaces:**

- Consumes: unified diff text containing `diff --git` boundaries, valid `@@ -old +new @@` headers, file metadata, and content prefixes.
- Produces: the existing `DiffRow[]` contract while adding an internal `inHunk` state; content encoded as `+++value`/`---value` in a hunk becomes `{ kind: 'add', text: '++value' }` / `{ kind: 'del', text: '--value' }`.
- Preserves: hunkless untracked `+` lines, binary-file hunk notices, valid context numbering, and trailing empty-string suppression.

- [ ] **Step 1: Write the failing test**

Append these two cases inside the existing `describe('parseUnifiedDiff')` block:

```ts
test('ハンク内の+++／---始まりをファイルヘッダーではなく内容行として保持する', () => {
	const rows = parseUnifiedDiff([
		'diff --git a/markers.txt b/markers.txt',
		'--- a/markers.txt',
		'+++ b/markers.txt',
		'@@ -4,2 +4,2 @@',
		'---old-marker',
		'+++new-marker',
		' context',
	].join('\n'));
	expect(rows).toEqual([
		{ kind: 'hunk', text: '@@ -4,2 +4,2 @@' },
		{ kind: 'del', oldNo: 4, text: '--old-marker' },
		{ kind: 'add', newNo: 4, text: '++new-marker' },
		{ kind: 'ctx', oldNo: 5, newNo: 5, text: 'context' },
	]);
});

test('次のdiff --git境界でハンク状態と行番号をresetする', () => {
	const rows = parseUnifiedDiff([
		'diff --git a/one.txt b/one.txt',
		'--- a/one.txt',
		'+++ b/one.txt',
		'@@ -8 +8 @@',
		'-old-one',
		'+new-one',
		'diff --git a/two.txt b/two.txt',
		'--- a/two.txt',
		'+++ b/two.txt',
		'@@ -1 +1 @@',
		'-old-two',
		'+new-two',
	].join('\n'));
	expect(rows).toEqual([
		{ kind: 'hunk', text: '@@ -8 +8 @@' },
		{ kind: 'del', oldNo: 8, text: 'old-one' },
		{ kind: 'add', newNo: 8, text: 'new-one' },
		{ kind: 'hunk', text: '@@ -1 +1 @@' },
		{ kind: 'del', oldNo: 1, text: 'old-two' },
		{ kind: 'add', newNo: 1, text: 'new-two' },
	]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm --dir app/mobile vitest run src/components/diffParser.test.ts`

Expected: the first new case FAILS because both marker-content rows are dropped as metadata. The second case characterizes the boundary reset that the implementation must keep explicit.

- [ ] **Step 3: Write minimal implementation**

Replace the loop control in `parseUnifiedDiff` with an explicit hunk state while leaving row creation shapes unchanged:

```ts
export function parseUnifiedDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff ')) {
			inHunk = false;
			oldNo = 0;
			newNo = 0;
			continue;
		}
		if (line.startsWith('@@')) {
			const match = line.match(/^@@ -(?<oldStart>\d+)(?:,\d+)? \+(?<newStart>\d+)(?:,\d+)? @@(?<rest>.*)$/);
			if (match?.groups) {
				oldNo = parseInt(match.groups.oldStart ?? '1', 10);
				newNo = parseInt(match.groups.newStart ?? '1', 10);
				inHunk = true;
				rows.push({ kind: 'hunk', text: line });
			}
			continue;
		}
		if (!inHunk && (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('Binary files') || line.startsWith('\\'))) {
			if (line.startsWith('Binary files')) {
				rows.push({ kind: 'hunk', text: line });
			}
		} else if (line.startsWith('+')) {
			if (newNo === 0) {
				newNo = 1;
			}
			rows.push({ kind: 'add', newNo: newNo++, text: line.slice(1) });
		} else if (line.startsWith('-')) {
			if (oldNo === 0) {
				oldNo = 1;
			}
			rows.push({ kind: 'del', oldNo: oldNo++, text: line.slice(1) });
		} else if (line.startsWith(' ') && (oldNo > 0 || newNo > 0)) {
			rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
		}
	}
	return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk pnpm --dir app/mobile vitest run src/components/diffParser.test.ts
rtk pnpm --dir app/mobile typecheck 2>&1 | rtk awk '
	{ print }
	/error TS/ { errorCount++; if ($0 !~ /src\/relayClientPresence\.test\.ts.*error TS2532/) { unexpectedCount++; } }
	END { if (errorCount != 13 || unexpectedCount != 0) { exit 1; } }
'
```

Expected: all existing and new parser cases PASS, including the two-file reset and hunkless/trailing-newline behaviors; the typecheck validator accepts only the 13 known baseline diagnostics.

- [ ] **Step 5: Commit**

```bash
rtk git add app/mobile/src/components/diffParser.ts app/mobile/src/components/diffParser.test.ts
rtk git commit -m "fix(mobile): preserve marker-like diff lines"
```

---

### Task 7: Session History Narrow-Detail Back Button

**Files:**

- Modify: `src/vs/paradis/contrib/sessionResume/test/electron-browser/paradisSessionResumeDialog.test.ts:30-220,420-474`
- Modify: `src/vs/paradis/contrib/sessionResume/electron-browser/media/paradisSessionResume.css:198-234`

**Interfaces:**

- Consumes: the existing `.paradis-session-resume-modal` named inline-size container, `.detail-open`, and `.paradis-session-resume-detail-back` button created by `renderDetail()`.
- Produces: computed `display: inline-flex` at container width 599px and `display: none` at 600px; no TypeScript production API changes.
- Verification boundary: the test imports the real dialog, which imports the real CSS, attaches the fixture to `document.body`, changes the actual container width, and observes browser-computed style.

- [ ] **Step 1: Write the failing test**

Add this test inside `suite('ParadisSessionResumeDialog')`:

```ts
test('shows the detail back button only in the one-column container', async () => {
	const client = new TestResumeClient();
	client.listResult = async () => [testSession('one', 'First session')];
	const fixture = createRefreshFixture(client);
	document.body.appendChild(fixture.root);
	try {
		await fixture.load();
		fixture.root.querySelector<HTMLButtonElement>('.paradis-session-resume-row')!.click();
		const modal = fixture.root.querySelector<HTMLElement>('.paradis-session-resume-modal')!;
		const backButton = fixture.root.querySelector<HTMLElement>('.paradis-session-resume-detail-back')!;
		const view = fixture.root.ownerDocument.defaultView!;
		modal.style.maxWidth = 'none';

		modal.style.width = '599px';
		await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
		const narrowDisplay = view.getComputedStyle(backButton).display;

		modal.style.width = '600px';
		await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
		const wideDisplay = view.getComputedStyle(backButton).display;

		assert.deepStrictEqual({ narrowDisplay, wideDisplay }, {
			narrowDisplay: 'inline-flex',
			wideDisplay: 'none',
		});
	} finally {
		fixture.root.remove();
		fixture.dispose();
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm run transpile-client
rtk ./scripts/test.sh --run src/vs/paradis/contrib/sessionResume/test/electron-browser/paradisSessionResumeDialog.test.ts
```

Expected: FAIL with `narrowDisplay: 'none'`, proving the later equal-specificity default rule overrides the 599px container rule.

- [ ] **Step 3: Write minimal implementation**

Move the complete wide-width default button rule before both container-query blocks, then leave the narrow override as the last matching declaration:

```css
/* 広い幅では一覧へ戻るボタンは不要（一覧が常に見えている）。 */
.paradis-session-resume .paradis-session-resume-detail-back {
	display: none; align-items: center; gap: 5px; margin-bottom: 10px; height: 24px; padding: 0 9px;
	border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); border-radius: 5px;
	background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); font-size: 11px;
}
.paradis-session-resume .paradis-session-resume-detail-back:hover { background: var(--vscode-list-hoverBackground); }

@container paradis-session-resume (max-width: 935px) {
	.paradis-session-resume .paradis-session-resume-rail-toggle { display: inline-flex; }
	.paradis-session-resume .paradis-session-resume-content { position: relative; grid-template-columns: minmax(280px, 43%) minmax(320px, 1fr); }
	.paradis-session-resume:not(.rail-open) .paradis-session-resume-nav { display: none; }
	.paradis-session-resume.rail-open .paradis-session-resume-nav {
		position: absolute; top: 0; bottom: 0; left: 0; z-index: 20; width: 216px; max-width: 62%;
		box-shadow: 4px 0 12px rgba(0, 0, 0, .35);
	}
}

@container paradis-session-resume (max-width: 599px) {
	.paradis-session-resume .paradis-session-resume-content { grid-template-columns: 1fr; }
	.paradis-session-resume .paradis-session-resume-detail { display: none; }
	.paradis-session-resume.detail-open .paradis-session-resume-listcolumn { display: none; }
	.paradis-session-resume.detail-open .paradis-session-resume-detail { display: flex; }
	.paradis-session-resume .paradis-session-resume-detail-back { display: inline-flex; }
}
```

Do not add `!important`; ordering alone fixes the cascade and keeps the selector specificity unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run the focused CSS behavior test, then the complete cross-surface verification set:

```bash
rtk npm run transpile-client
rtk ./scripts/test.sh --run src/vs/paradis/contrib/sessionResume/test/electron-browser/paradisSessionResumeDialog.test.ts
rtk npm run test-browser-no-install -- --run src/vs/sessions/test/browser/mobileChangesView.test.ts --browser chromium
rtk pnpm --dir app/mobile test
rtk pnpm --dir app/mobile typecheck 2>&1 | rtk awk '
	{ print }
	/error TS/ { errorCount++; if ($0 !~ /src\/relayClientPresence\.test\.ts.*error TS2532/) { unexpectedCount++; } }
	END { if (errorCount != 13 || unexpectedCount != 0) { exit 1; } }
'
rtk npm run typecheck-client
rtk npm run valid-layers-check
rtk npm run eslint -- src/vs/sessions/browser/parts/mobile/contributions/mobileChangesView.ts src/vs/sessions/test/browser/mobileChangesView.test.ts src/vs/paradis/contrib/sessionResume/test/electron-browser/paradisSessionResumeDialog.test.ts app/mobile/src/components/terminalHeaderBehavior.ts app/mobile/src/components/terminalHeaderBehavior.test.ts app/mobile/src/components/homeHeaderMenuBehavior.ts app/mobile/src/components/homeHeaderMenuBehavior.test.ts app/mobile/src/components/webViewLinkGuard.ts app/mobile/src/components/webViewLinkGuard.test.ts app/mobile/src/components/diffParser.ts app/mobile/src/components/diffParser.test.ts app/mobile/src/components/terminalPicker.tsx app/mobile/src/components/homePlusMenu.tsx app/mobile/src/components/voiceNotificationControl.tsx 'app/mobile/app/(tabs)/terminal.tsx' 'app/mobile/app/(tabs)/index.tsx'
rtk npm run stylelint -- src/vs/sessions/browser/parts/mobile/contributions/media/mobileOverlayViews.css src/vs/paradis/contrib/sessionResume/electron-browser/media/paradisSessionResume.css
rtk git diff --check
```

Expected: both VS Code target suites and all mobile Vitest tests PASS; root typecheck/layer/lint/stylelint PASS; the mobile typecheck validator sees only the 13 known baseline diagnostics; and `git diff --check` emits no output. Before PR creation, narrow the running Session history modal below 600px, open a session detail, use the visible 一覧へ button to return, and record the successful interaction together with the phone Changes and available mobile-simulator checks.

- [ ] **Step 5: Commit**

```bash
rtk git add src/vs/paradis/contrib/sessionResume/test/electron-browser/paradisSessionResumeDialog.test.ts src/vs/paradis/contrib/sessionResume/electron-browser/media/paradisSessionResume.css
rtk git commit -m "fix(session-history): show narrow detail back action"
```

---

## Completion Evidence

- Preserve the RED output and subsequent GREEN output for every Task in the PR notes.
- Attach the 390/375/320pt presentation test output, regular-iPad preservation result, Android fallback result or explicit emulator limitation, phone Changes action screenshot/recording, and narrow Session history interaction result.
- Confirm `rtk git diff --name-only origin/main...HEAD` contains only the files listed by Tasks 1〜7 plus this plan/spec documentation and the independently planned #8〜#27 fixes.
- Request a final review from a Subagent that did not implement these Tasks, providing base SHA, head SHA, the #1〜#7 requirement table, all command output, and UI evidence. Resolve every Critical or Important finding before the parent branch is pushed and the `main` PR is created.
