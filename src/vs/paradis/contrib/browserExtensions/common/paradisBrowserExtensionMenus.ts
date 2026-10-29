/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-context-menu-model.ts, src/main/browser/extensions/browser-extension-context-menu-target.ts, src/main/browser/extensions/browser-extension-commands.ts

// chrome.contextMenus の項目の台帳と、右クリックでどれを出すかの判定、manifest の commands（ショートカット）の
// 読み方（P5b）。main と renderer の両方から読む純粋な部分。
//
// 項目の決まりは Chromium の context_menus.json と MenuManager に合わせる: id は拡張機能の中で 1 つ、項目を消すと
// その子も消える、同じ親の下で隣り合う radio の並びは必ず 1 つだけが選ばれている。

/** 項目の id（Chrome は文字か整数）。 */
export type ParadisMenuItemId = string | number;

/** 保存する項目 1 つ（Chrome の作成の引数のうち、関数を除いたもの）。 */
export interface IParadisStoredMenuItem {
	readonly id: ParadisMenuItemId;
	readonly type: 'normal' | 'checkbox' | 'radio' | 'separator';
	readonly title?: string;
	readonly checked?: boolean;
	readonly contexts: readonly string[];
	readonly visible: boolean;
	readonly enabled: boolean;
	readonly parentId?: ParadisMenuItemId;
	readonly documentUrlPatterns?: readonly string[];
	readonly targetUrlPatterns?: readonly string[];
}

/** 作る・変えるときに受け取る値。 */
export type ParadisMenuItemProperties = { -readonly [Key in keyof Omit<IParadisStoredMenuItem, 'id'>]?: IParadisStoredMenuItem[Key] };

/** 拡張機能 1 つが作れる項目の数の上限（壊れた拡張機能が main の台帳を膨らませないように）。 */
export const PARADIS_MAX_MENU_ITEMS = 1_000;

/** 文で失敗を返す（拡張機能へ runtime.lastError として届く）。 */
export class ParadisMenuError extends Error { }

const MENU_TYPES = new Set(['normal', 'checkbox', 'radio', 'separator']);
export const PARADIS_MENU_CONTEXTS = ['all', 'page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'launcher', 'browser_action', 'page_action', 'action'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 項目の id として正しいか。 */
export function paradisIsMenuItemId(value: unknown): value is ParadisMenuItemId {
	return (typeof value === 'string' && value.length <= 1_000) || (typeof value === 'number' && Number.isSafeInteger(value));
}

function strings(value: unknown, max: number): string[] | undefined {
	return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? (value as string[]).slice(0, max) : undefined;
}

/**
 * 作る・変えるの引数から、Chrome の項目の値だけを取り出す（onclick や知らない鍵は捨てる）。形が違えば投げる。
 */
export function paradisMenuItemProperties(raw: Record<string, unknown>): ParadisMenuItemProperties {
	const result: ParadisMenuItemProperties = {};
	if (raw.type !== undefined) {
		if (typeof raw.type !== 'string' || !MENU_TYPES.has(raw.type)) {
			throw new ParadisMenuError(`Invalid value for argument 1. Property 'type': Value must be one of normal, checkbox, radio, separator.`);
		}
		result.type = raw.type as IParadisStoredMenuItem['type'];
	}
	if (raw.title !== undefined) {
		if (typeof raw.title !== 'string') {
			throw new ParadisMenuError('Invalid title');
		}
		result.title = raw.title.slice(0, 1_000);
	}
	for (const key of ['checked', 'visible', 'enabled'] as const) {
		if (raw[key] !== undefined) {
			if (typeof raw[key] !== 'boolean') {
				throw new ParadisMenuError(`Invalid ${key}`);
			}
			result[key] = raw[key] as boolean;
		}
	}
	if (raw.contexts !== undefined) {
		const contexts = strings(raw.contexts, 20);
		if (!contexts || contexts.some(context => !PARADIS_MENU_CONTEXTS.includes(context))) {
			throw new ParadisMenuError('Invalid contexts');
		}
		result.contexts = contexts;
	}
	if (raw.parentId !== undefined) {
		if (!paradisIsMenuItemId(raw.parentId)) {
			throw new ParadisMenuError('Invalid parentId');
		}
		result.parentId = raw.parentId;
	}
	for (const key of ['documentUrlPatterns', 'targetUrlPatterns'] as const) {
		if (raw[key] !== undefined) {
			const patterns = strings(raw[key], 100);
			if (!patterns) {
				throw new ParadisMenuError(`Invalid ${key}`);
			}
			result[key] = patterns;
		}
	}
	return result;
}

function sameId(a: ParadisMenuItemId | undefined, b: ParadisMenuItemId | undefined): boolean {
	return a !== undefined && b !== undefined && a === b;
}

function descendantsOf(items: readonly IParadisStoredMenuItem[], id: ParadisMenuItemId): Set<ParadisMenuItemId> {
	const found = new Set<ParadisMenuItemId>([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const item of items) {
			if (item.parentId !== undefined && found.has(item.parentId) && !found.has(item.id)) {
				found.add(item.id);
				grew = true;
			}
		}
	}
	return found;
}

/** `selected` を選び、同じ並びのほかの radio を外す。 */
function selectRadio(items: readonly IParadisStoredMenuItem[], selected: IParadisStoredMenuItem): IParadisStoredMenuItem[] {
	const siblings = items.filter(item => (item.parentId ?? null) === (selected.parentId ?? null));
	const position = siblings.findIndex(item => sameId(item.id, selected.id));
	let start = position;
	while (start > 0 && siblings[start - 1].type === 'radio') {
		start--;
	}
	let end = position;
	while (end < siblings.length - 1 && siblings[end + 1].type === 'radio') {
		end++;
	}
	const run = new Set(siblings.slice(start, end + 1).map(item => item.id));
	return items.map(item => run.has(item.id) ? { ...item, checked: sameId(item.id, selected.id) } : item);
}

/** 同じ親の下で隣り合う radio の並びで、選ばれているものを 1 つにする（Chromium の SanitizeRadioList）。 */
export function paradisSanitizeRadioRuns(items: readonly IParadisStoredMenuItem[]): IParadisStoredMenuItem[] {
	const result = items.map(item => ({ ...item }));
	for (const parent of new Set(result.map(item => item.parentId ?? null))) {
		const siblings = result.filter(item => (item.parentId ?? null) === parent);
		let run: { checked?: boolean }[] = [];
		const settle = () => {
			if (run.length > 0) {
				const firstChecked = run.findIndex(item => item.checked);
				run.forEach((item, index) => item.checked = index === (firstChecked === -1 ? 0 : firstChecked));
			}
			run = [];
		};
		for (const item of siblings) {
			if (item.type === 'radio') {
				run.push(item);
			} else {
				settle();
			}
		}
		settle();
	}
	return result;
}

function settleRadios(items: readonly IParadisStoredMenuItem[], changed: IParadisStoredMenuItem, explicitlyChecked: boolean): IParadisStoredMenuItem[] {
	return paradisSanitizeRadioRuns(changed.type === 'radio' && explicitlyChecked ? selectRadio(items, changed) : items);
}

/** contextMenus.create。 */
export function paradisCreateMenuItem(items: readonly IParadisStoredMenuItem[], id: ParadisMenuItemId, properties: ParadisMenuItemProperties): IParadisStoredMenuItem[] {
	if (items.some(item => sameId(item.id, id))) {
		throw new ParadisMenuError(`Cannot create item with duplicate id ${id}`);
	}
	if (items.length >= PARADIS_MAX_MENU_ITEMS) {
		throw new ParadisMenuError('Too many menu items');
	}
	if (properties.parentId !== undefined && !items.some(item => sameId(item.id, properties.parentId))) {
		throw new ParadisMenuError(`Cannot find menu item with id ${properties.parentId}`);
	}
	const type = properties.type ?? 'normal';
	if (type !== 'separator' && !properties.title) {
		throw new ParadisMenuError('Title missing.');
	}
	const item: IParadisStoredMenuItem = {
		id,
		type,
		contexts: properties.contexts?.length ? properties.contexts : ['page'],
		enabled: properties.enabled ?? true,
		visible: properties.visible ?? true,
		...(properties.parentId !== undefined ? { parentId: properties.parentId } : {}),
		...(properties.title !== undefined ? { title: properties.title } : {}),
		...(properties.checked !== undefined ? { checked: properties.checked } : {}),
		...(properties.documentUrlPatterns ? { documentUrlPatterns: properties.documentUrlPatterns } : {}),
		...(properties.targetUrlPatterns ? { targetUrlPatterns: properties.targetUrlPatterns } : {}),
	};
	return settleRadios([...items, item], item, properties.checked === true);
}

/** contextMenus.update。 */
export function paradisUpdateMenuItem(items: readonly IParadisStoredMenuItem[], id: ParadisMenuItemId, properties: ParadisMenuItemProperties): IParadisStoredMenuItem[] {
	const index = items.findIndex(item => sameId(item.id, id));
	if (index === -1) {
		throw new ParadisMenuError(`Cannot find menu item with id ${id}`);
	}
	if (properties.parentId !== undefined) {
		if (!items.some(item => sameId(item.id, properties.parentId))) {
			throw new ParadisMenuError(`Cannot find menu item with id ${properties.parentId}`);
		}
		if (descendantsOf(items, id).has(properties.parentId)) {
			throw new ParadisMenuError('Cannot set an item to be a descendant of itself');
		}
	}
	const next = items.map(item => ({ ...item }));
	next[index] = { ...next[index], ...properties, id: next[index].id };
	return settleRadios(next, next[index], properties.checked === true);
}

/** contextMenus.remove（子も消える）。 */
export function paradisRemoveMenuItem(items: readonly IParadisStoredMenuItem[], id: ParadisMenuItemId): IParadisStoredMenuItem[] {
	if (!items.some(item => sameId(item.id, id))) {
		throw new ParadisMenuError(`Cannot find menu item with id ${id}`);
	}
	const removed = descendantsOf(items, id);
	return paradisSanitizeRadioRuns(items.filter(item => !removed.has(item.id)));
}

/** 押したとき: checkbox は反転、radio は選んで並びのほかを外す（onClicked の前、Chrome と同じ）。 */
export function paradisApplyMenuClick(items: readonly IParadisStoredMenuItem[], clicked: IParadisStoredMenuItem): { readonly items: readonly IParadisStoredMenuItem[]; readonly wasChecked?: boolean; readonly checked?: boolean } {
	if (clicked.type === 'checkbox') {
		const checked = !clicked.checked;
		return { items: items.map(item => sameId(item.id, clicked.id) ? { ...item, checked } : item), wasChecked: clicked.checked === true, checked };
	}
	if (clicked.type !== 'radio') {
		return { items };
	}
	return { items: selectRadio(items, clicked), wasChecked: clicked.checked === true, checked: true };
}

/** 保存してあった項目の並びを読む（壊れた行は捨てる）。 */
export function paradisParseStoredMenuItems(raw: unknown): IParadisStoredMenuItem[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const items: IParadisStoredMenuItem[] = [];
	for (const entry of raw.slice(0, PARADIS_MAX_MENU_ITEMS)) {
		if (!isRecord(entry) || !paradisIsMenuItemId(entry.id) || items.some(item => sameId(item.id, entry.id as ParadisMenuItemId))) {
			continue;
		}
		try {
			const properties = paradisMenuItemProperties(entry);
			items.push({ id: entry.id, type: properties.type ?? 'normal', contexts: properties.contexts ?? ['page'], visible: properties.visible ?? true, enabled: properties.enabled ?? true, ...properties });
		} catch {
			// 壊れた行
		}
	}
	return items.filter(item => item.parentId === undefined || items.some(parent => sameId(parent.id, item.parentId)));
}

// --- 右クリックで出すもの ---

/** 右クリックしたもの（項目の絞り込みに使う言葉で）。 */
export interface IParadisMenuTarget {
	readonly contexts: ReadonlySet<string>;
	readonly pageUrl: string;
	readonly frameUrl?: string;
	readonly linkUrl?: string;
	readonly srcUrl?: string;
	readonly selectionText?: string;
}

/** Electron の ContextMenuParams のうち、ここで使うところ。 */
export interface IParadisMenuParamsLike {
	readonly frameURL?: string;
	readonly linkURL?: string;
	readonly srcURL?: string;
	readonly mediaType?: string;
	readonly selectionText?: string;
	readonly isEditable?: boolean;
}

/** ツールバーのボタンの右クリックの項目の contexts。 */
export const PARADIS_ACTION_MENU_CONTEXTS: readonly string[] = ['action', 'browser_action', 'page_action'];

/** Chromium: 'page' は、リンク・選択・入力欄・メディアのどれでもないときだけ。 */
export function paradisMenuTargetFromParams(params: IParadisMenuParamsLike, pageUrl: string, inSubframe: boolean): IParadisMenuTarget {
	const contexts = new Set<string>();
	if (params.linkURL) {
		contexts.add('link');
	}
	if (params.isEditable) {
		contexts.add('editable');
	}
	if (params.selectionText) {
		contexts.add('selection');
	}
	if (params.mediaType === 'image' || params.mediaType === 'video' || params.mediaType === 'audio') {
		contexts.add(params.mediaType);
	}
	if (contexts.size === 0) {
		contexts.add('page');
	}
	if (inSubframe) {
		contexts.add('frame');
	}
	return {
		contexts,
		pageUrl,
		...(inSubframe && params.frameURL ? { frameUrl: params.frameURL } : {}),
		...(params.linkURL ? { linkUrl: params.linkURL } : {}),
		...(params.srcURL ? { srcUrl: params.srcURL } : {}),
		...(params.selectionText ? { selectionText: params.selectionText } : {}),
	};
}

/** 出す項目 1 つ（子を持てる）。 */
export interface IParadisVisibleMenuItem {
	/** 項目の id の JSON（押したときに項目を引く鍵）。拡張機能の名前の入れ物は ''。 */
	readonly key: string;
	readonly title: string;
	readonly type: IParadisStoredMenuItem['type'];
	readonly checked: boolean;
	readonly enabled: boolean;
	readonly children: readonly IParadisVisibleMenuItem[];
}

const MAX_SELECTION_IN_TITLE = 50;

/** %s は選んだ文字（Chrome と同じく切る）。& は Chrome のニーモニック、&& は & そのもの。 */
export function paradisFormatMenuTitle(title: string, selectionText: string | undefined): string {
	const selection = selectionText && selectionText.length > MAX_SELECTION_IN_TITLE ? `${selectionText.slice(0, MAX_SELECTION_IN_TITLE)}…` : (selectionText ?? '');
	return title.replaceAll('%s', selection).replace(/&(&?)/g, (_match, literal: string) => literal);
}

/** その項目を、この右クリックで出すか。 */
function itemApplies(item: IParadisStoredMenuItem, target: IParadisMenuTarget, matches: (pattern: string, url: string) => boolean): boolean {
	if (!item.visible || !(item.contexts.includes('all') || item.contexts.some(context => target.contexts.has(context)))) {
		return false;
	}
	const matchesAny = (patterns: readonly string[] | undefined, url: string | undefined) => !patterns || (url !== undefined && patterns.some(pattern => matches(pattern, url)));
	if (!matchesAny(item.documentUrlPatterns, target.frameUrl ?? target.pageUrl)) {
		return false;
	}
	if (item.targetUrlPatterns) {
		for (const url of [target.linkUrl, target.srcUrl]) {
			if (url && !matchesAny(item.targetUrlPatterns, url)) {
				return false;
			}
		}
	}
	return true;
}

/** この右クリックで出す項目の木（`matches` は Chrome の match pattern の照合）。 */
export function paradisVisibleMenuTree(items: readonly IParadisStoredMenuItem[], target: IParadisMenuTarget, matches: (pattern: string, url: string) => boolean, parentId?: ParadisMenuItemId): IParadisVisibleMenuItem[] {
	return items
		.filter(item => parentId === undefined ? item.parentId === undefined : sameId(item.parentId, parentId))
		.filter(item => itemApplies(item, target, matches))
		.flatMap((item): IParadisVisibleMenuItem[] => {
			const hasChildren = items.some(candidate => sameId(candidate.parentId, item.id));
			const children = hasChildren ? paradisVisibleMenuTree(items, target, matches, item.id) : [];
			// 子がすべて外れた親は、空のサブメニューになるので出さない
			if (hasChildren && children.length === 0) {
				return [];
			}
			return [{ key: JSON.stringify(item.id), title: paradisFormatMenuTitle(item.title ?? '', target.selectionText), type: item.type, checked: item.checked === true, enabled: item.enabled, children }];
		});
}

/** Chrome: 一番上の項目が 1 つならそのまま、複数なら拡張機能の名前のサブメニューにまとめる。 */
export function paradisArrangeExtensionMenu(extensionName: string, tree: readonly IParadisVisibleMenuItem[]): IParadisVisibleMenuItem[] {
	const items = tree.filter(item => item.type !== 'separator' || tree.length > 1);
	if (items.length <= 1) {
		return items;
	}
	return [{ key: '', title: extensionName, type: 'normal', checked: false, enabled: true, children: items }];
}

/** 押した項目を鍵で引く。 */
export function paradisFindMenuItemByKey(items: readonly IParadisStoredMenuItem[], key: string): IParadisStoredMenuItem | undefined {
	return items.find(item => JSON.stringify(item.id) === key);
}

/** contextMenus.onClicked の OnClickData。 */
export function paradisMenuClickData(args: { readonly item: IParadisStoredMenuItem; readonly target: IParadisMenuTarget; readonly frameId: number; readonly editable: boolean; readonly mediaType?: string; readonly wasChecked?: boolean; readonly checked?: boolean }): Record<string, unknown> {
	const { item, target } = args;
	return {
		menuItemId: item.id,
		...(item.parentId !== undefined ? { parentMenuItemId: item.parentId } : {}),
		...(args.mediaType === 'image' || args.mediaType === 'video' || args.mediaType === 'audio' ? { mediaType: args.mediaType } : {}),
		...(target.linkUrl ? { linkUrl: target.linkUrl } : {}),
		...(target.srcUrl ? { srcUrl: target.srcUrl } : {}),
		pageUrl: target.pageUrl,
		...(target.frameUrl ? { frameUrl: target.frameUrl } : {}),
		frameId: args.frameId,
		...(target.selectionText ? { selectionText: target.selectionText } : {}),
		editable: args.editable,
		...(args.wasChecked !== undefined ? { wasChecked: args.wasChecked } : {}),
		...(args.checked !== undefined ? { checked: args.checked } : {}),
	};
}

// --- ショートカット（manifest の commands） ---

/** ショートカット（Chrome の書き方を読んだもの）。 */
export interface IParadisShortcut {
	readonly key: string;
	readonly control: boolean;
	readonly meta: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

/** manifest の commands 1 つ。 */
export interface IParadisExtensionCommand {
	readonly name: string;
	readonly description: string;
	/** Chrome の見せ方（macOS は「⇧⌘Y」）。割り当てが無ければ ''。 */
	readonly shortcut: string;
	readonly binding: IParadisShortcut | undefined;
}

/** ポップアップを出す（ボタンを押すのと同じ）コマンドの名前。 */
export const PARADIS_EXECUTE_ACTION_COMMANDS: ReadonlySet<string> = new Set(['_execute_action', '_execute_browser_action', '_execute_page_action']);

/** Chrome がおすすめのキーを割り当てるコマンドの数。 */
const MAX_SUGGESTED_SHORTCUTS = 4;

/** Chrome の suggested_key の書き方で使えるキー。 */
const SHORTCUT_KEYS = /^([A-Z0-9]|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right|MediaNextTrack|MediaPlayPause|MediaPrevTrack|MediaStop)$/;

type ParadisPlatform = 'mac' | 'windows' | 'linux' | 'chromeos';

/** 「Ctrl+Shift+Y」→ 修飾キーとキー。macOS の Chrome は Ctrl を Command、MacCtrl を Control と読む。 */
export function paradisParseShortcut(shortcut: string, platform: ParadisPlatform): IParadisShortcut | undefined {
	const parts = shortcut.split('+').map(part => part.trim());
	const key = parts.pop();
	if (!key || !SHORTCUT_KEYS.test(key) || parts.length === 0) {
		return undefined;
	}
	const parsed = { key, control: false, meta: false, alt: false, shift: false };
	for (const modifier of parts) {
		if (modifier === 'Ctrl') {
			parsed[platform === 'mac' ? 'meta' : 'control'] = true;
		} else if (modifier === 'Command' && platform === 'mac') {
			parsed.meta = true;
		} else if (modifier === 'MacCtrl' && platform === 'mac') {
			parsed.control = true;
		} else if (modifier === 'Alt') {
			parsed.alt = true;
		} else if (modifier === 'Shift') {
			parsed.shift = true;
		} else {
			return undefined;
		}
	}
	// Chrome は Ctrl・Command・Alt（macOS は MacCtrl も）のどれかを要る。Shift だけはコマンドにならない
	return parsed.control || parsed.meta || parsed.alt ? parsed : undefined;
}

function formatShortcut(parsed: IParadisShortcut, platform: ParadisPlatform): string {
	if (platform === 'mac') {
		return `${parsed.control ? '⌃' : ''}${parsed.alt ? '⌥' : ''}${parsed.shift ? '⇧' : ''}${parsed.meta ? '⌘' : ''}${parsed.key}`;
	}
	return [parsed.control ? 'Ctrl' : '', parsed.alt ? 'Alt' : '', parsed.shift ? 'Shift' : '', parsed.key].filter(Boolean).join('+');
}

/** manifest の commands。おすすめのキーは Chrome と同じく 4 つまで割り当てる。 */
export function paradisReadExtensionCommands(manifest: Record<string, unknown> | undefined, platform: ParadisPlatform): IParadisExtensionCommand[] {
	const commands = isRecord(manifest?.commands) ? manifest.commands : {};
	let assigned = 0;
	return Object.entries(commands).slice(0, 100).map(([name, raw]) => {
		const command = isRecord(raw) ? raw : {};
		const suggested = isRecord(command.suggested_key) ? command.suggested_key : undefined;
		const wanted = suggested?.[platform] ?? suggested?.default;
		const binding = typeof wanted === 'string' && assigned < MAX_SUGGESTED_SHORTCUTS ? paradisParseShortcut(wanted, platform) : undefined;
		if (binding) {
			assigned++;
		}
		return {
			name,
			description: typeof command.description === 'string' ? command.description.slice(0, 500) : '',
			shortcut: binding ? formatShortcut(binding, platform) : '',
			binding,
		};
	});
}
