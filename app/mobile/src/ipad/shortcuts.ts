// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 外付けキーボードのショートカットの一覧と、押されたときの操作の対応（この1か所にまとめる）。
 *
 * ネイティブ（`modules/para-ipad-input`）は UIKeyCommand を作って押されたことを知らせるだけで、何をするかは
 * ここで決める。「いま効かせるもの」だけをネイティブへ渡すので、⌘ を長押ししたときの一覧（OS が描く）にも
 * その画面で使えるものだけが並ぶ。画面の側は `shortcutRegistry.ts` の `useShortcutSlot` で受け口を置く。
 *
 * 画面から切り離した純関数なので、割り当ての重複や出し分けをテストで固定している（`shortcuts.test.ts`）。
 */

export type ShortcutModifier = 'command' | 'alternate' | 'shift' | 'control';

/** ドックに置く（狭ければ押し進める）パネル。 */
export type DockPanel = 'scm' | 'files' | 'note';

/** ショートカットが押されたときの操作。 */
export type ShortcutAction =
	| { readonly kind: 'selectTab'; readonly index: number }
	| { readonly kind: 'stepTab'; readonly delta: 1 | -1 }
	| { readonly kind: 'quick' }
	| { readonly kind: 'send' }
	| { readonly kind: 'panel'; readonly panel: DockPanel }
	| { readonly kind: 'stepAgent'; readonly delta: 1 | -1 }
	| { readonly kind: 'launch' }
	| { readonly kind: 'toggleSidebar' }
	| { readonly kind: 'settings' }
	| { readonly kind: 'notifications' }
	| { readonly kind: 'escape' };

export interface ShortcutDef {
	readonly id: string;
	/** 1文字、または `Enter` / `Escape` / `ArrowUp` / `ArrowDown`。 */
	readonly input: string;
	readonly modifiers: readonly ShortcutModifier[];
	/** ⌘ を長押ししたときの一覧に出す名前。 */
	readonly title: string;
	readonly action: ShortcutAction;
	/**
	 * 入力欄の標準の動き（⌘[ の字下げ、⌘Return の改行、矢印の移動）とぶつかるので、こちらを先に効かせるもの。
	 * それ以外には付けない（Esc に付けると、日本語の変換中の Esc＝変換の取り消しまでこちらが奪う）。
	 */
	readonly overridesTextInput?: true;
}

const TAB_SHORTCUTS: readonly ShortcutDef[] = Array.from({ length: 9 }, (_, index): ShortcutDef => ({
	id: `tab.${index + 1}`,
	input: String(index + 1),
	modifiers: ['command'],
	title: `${index + 1} 番目のタブ`,
	action: { kind: 'selectTab', index },
}));

/** すべてのショートカット（モックの一覧と同じ並び）。 */
export const SHORTCUTS: readonly ShortcutDef[] = [
	...TAB_SHORTCUTS,
	{ id: 'tab.prev', input: '[', modifiers: ['command'], title: '前のタブ', action: { kind: 'stepTab', delta: -1 }, overridesTextInput: true },
	{ id: 'tab.next', input: ']', modifiers: ['command'], title: '次のタブ', action: { kind: 'stepTab', delta: 1 }, overridesTextInput: true },
	{ id: 'quick', input: 'k', modifiers: ['command'], title: 'クイックコマンド', action: { kind: 'quick' } },
	{ id: 'send', input: 'Enter', modifiers: ['command'], title: '送信', action: { kind: 'send' }, overridesTextInput: true },
	{ id: 'panel.scm', input: '1', modifiers: ['alternate', 'command'], title: 'ソース管理', action: { kind: 'panel', panel: 'scm' } },
	{ id: 'panel.files', input: '2', modifiers: ['alternate', 'command'], title: 'ファイル', action: { kind: 'panel', panel: 'files' } },
	{ id: 'panel.note', input: '3', modifiers: ['alternate', 'command'], title: 'メモ', action: { kind: 'panel', panel: 'note' } },
	{ id: 'agent.prev', input: 'ArrowUp', modifiers: ['alternate', 'command'], title: '前のエージェントを開く', action: { kind: 'stepAgent', delta: -1 }, overridesTextInput: true },
	{ id: 'agent.next', input: 'ArrowDown', modifiers: ['alternate', 'command'], title: '次のエージェントを開く', action: { kind: 'stepAgent', delta: 1 }, overridesTextInput: true },
	{ id: 'launch', input: 'n', modifiers: ['command'], title: 'エージェントを起動', action: { kind: 'launch' } },
	{ id: 'sidebar', input: '\\', modifiers: ['command'], title: 'サイドバーを隠す・出す', action: { kind: 'toggleSidebar' } },
	{ id: 'settings', input: ',', modifiers: ['command'], title: '設定', action: { kind: 'settings' } },
	{ id: 'notifications', input: 'n', modifiers: ['shift', 'command'], title: '通知', action: { kind: 'notifications' } },
	{ id: 'escape', input: 'Escape', modifiers: [], title: '閉じる', action: { kind: 'escape' } },
];

/** いまの画面で受け口があるもの（`shortcutRegistry.ts` が集める）。 */
export interface ShortcutContext {
	/** 前面のセッションのタブの数（セッションを開いていなければ undefined）。 */
	readonly tabCount: number | undefined;
	/** 入力欄の送信の受け口があるか。 */
	readonly send: boolean;
	/** PC の画面（エージェントの一覧）が出ているか。 */
	readonly list: boolean;
	/** 起動のシートを出せるか（PC の画面・ホーム）。 */
	readonly launch: boolean;
	/** 左の列を隠す・出すができるか（2列でセッションを開いているとき）。 */
	readonly sidebar: boolean;
	/** 閉じられるもの（シート・ドック）が開いているか。 */
	readonly escape: boolean;
	/** 設定・通知の画面にいるか（いれば同じ画面を重ねない）。 */
	readonly inSettings: boolean;
	readonly inNotifications: boolean;
}

/** その操作がいまの画面で効くか。 */
export function isShortcutAvailable(action: ShortcutAction, context: ShortcutContext): boolean {
	switch (action.kind) {
		case 'selectTab':
			return context.tabCount !== undefined && action.index < context.tabCount;
		case 'stepTab':
			return context.tabCount !== undefined && context.tabCount > 1;
		case 'quick':
		case 'panel':
			return context.tabCount !== undefined;
		case 'send':
			return context.send;
		case 'stepAgent':
			return context.list;
		case 'launch':
			return context.launch;
		case 'toggleSidebar':
			return context.sidebar;
		case 'settings':
			return !context.inSettings;
		case 'notifications':
			return !context.inNotifications;
		case 'escape':
			// Esc は入力欄でも使うキー（日本語の変換の取り消しなど）なので、閉じるものがあるときだけ取る。
			return context.escape;
	}
}

/** いまネイティブへ渡すショートカット（効かないものは渡さない＝⌘ 長押しの一覧にも出ない）。 */
export function availableShortcuts(context: ShortcutContext): ShortcutDef[] {
	return SHORTCUTS.filter(def => isShortcutAvailable(def.action, context));
}

/** 押されたショートカットの ID から定義を引く（知らない ID は undefined）。 */
export function shortcutById(id: string): ShortcutDef | undefined {
	return SHORTCUTS.find(def => def.id === id);
}

/**
 * 一覧の中で前後へ1つ動いた位置（端では反対の端へ回る）。今の位置が無い（-1）ときは、
 * 次なら先頭、前なら末尾から始める。数が 0 なら -1。
 */
export function stepIndex(current: number, count: number, delta: 1 | -1): number {
	if (count <= 0) {
		return -1;
	}
	if (current < 0 || current >= count) {
		return delta > 0 ? 0 : count - 1;
	}
	return (current + delta + count) % count;
}

/** 並んだ中から、今のもの（`current`）の前後の1つを選ぶ。無ければ undefined。 */
export function stepKey(keys: readonly string[], current: string | undefined, delta: 1 | -1): string | undefined {
	const index = stepIndex(current !== undefined ? keys.indexOf(current) : -1, keys.length, delta);
	return index >= 0 ? keys[index] : undefined;
}
