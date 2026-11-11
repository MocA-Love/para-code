/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isRecord } from '../../../common/paradisGuards.js';
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

/** process.platform（'darwin' など）を manifest の suggested_key の鍵にする。 */
export function paradisCommandPlatform(platform: string): 'mac' | 'windows' | 'linux' {
	return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
}

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

/** Chrome の見せ方（macOS は「⇧⌘Y」、ほかは「Ctrl+Shift+Y」）。 */
export function paradisFormatShortcut(parsed: IParadisShortcut, platform: ParadisPlatform): string {
	if (platform === 'mac') {
		return `${parsed.control ? '⌃' : ''}${parsed.alt ? '⌥' : ''}${parsed.shift ? '⇧' : ''}${parsed.meta ? '⌘' : ''}${parsed.key}`;
	}
	return [parsed.control ? 'Ctrl' : '', parsed.alt ? 'Alt' : '', parsed.shift ? 'Shift' : '', parsed.key].filter(Boolean).join('+');
}

/**
 * 利用者が決めたキー（拡張機能の id → コマンドの名前 → suggested_key の書き方のキー。'' は外したキー）。
 * Chrome の chrome://extensions/shortcuts で付け替えたものに当たる。台帳（main）が持つ。
 */
export type ParadisUserShortcuts = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** 1 つの拡張機能に覚えるキーの数の上限（manifest の commands の上限と同じ）。 */
const MAX_USER_SHORTCUTS_PER_EXTENSION = 100;

/** そのキーがどこから来たか。 */
export type ParadisShortcutSource =
	/** 拡張機能のおすすめのキー（suggested_key）。 */
	| 'suggested'
	/** 利用者が付けたキー。 */
	| 'user'
	/** 利用者が外した。 */
	| 'removed'
	/** おすすめのキーが無い。 */
	| 'none'
	/** おすすめのキーをほかのコマンドが使っている。 */
	| 'lost';

/** 割り当てを決めた後のコマンド 1 つ。 */
export interface IParadisResolvedExtensionCommand extends IParadisExtensionCommand {
	readonly source: ParadisShortcutSource;
	/** おすすめのキー（見せ方。無ければ ''）。 */
	readonly suggested: string;
	/** `lost` のとき: そのキーを使っているコマンド。 */
	readonly lostTo?: { readonly extensionId: string; readonly name: string };
}

/** 利用者が決めたキーを読む（suggested_key の書き方で読めないものは捨てる）。'' は外したキー。 */
export function paradisUserShortcutOf(userShortcuts: ParadisUserShortcuts | undefined, extensionId: string, name: string, platform: ParadisPlatform): { readonly binding: IParadisShortcut | undefined } | undefined {
	const byName = userShortcuts && Object.hasOwn(userShortcuts, extensionId) ? userShortcuts[extensionId] : undefined;
	const value = byName && Object.hasOwn(byName, name) ? byName[name] : undefined;
	if (typeof value !== 'string') {
		return undefined;
	}
	if (value === '') {
		return { binding: undefined };
	}
	const binding = paradisParseShortcut(value, platform);
	return binding ? { binding } : undefined;
}

/**
 * 1 つの場所に入っている拡張機能（先に入れた順）の commands のキーを決める。1 周目に利用者が決めたキーを入れ、2 周目に
 * 拡張機能のおすすめのキーを先に入れた順で入れる。Chrome と同じく、もう使われているキーは後のコマンドには割り当てない
 * （そのコマンドのキーは ''）。拡張機能を更新しても入れた順は変わらない。
 */
export function paradisResolveExtensionShortcuts(extensions: readonly { readonly id: string; readonly manifest: Record<string, unknown> | undefined }[], platform: ParadisPlatform, userShortcuts?: ParadisUserShortcuts): Map<string, IParadisResolvedExtensionCommand[]> {
	const unique = extensions.filter((extension, index) => extensions.findIndex(candidate => candidate.id === extension.id) === index);
	const read = unique.map(extension => ({ id: extension.id, commands: paradisReadExtensionCommands(extension.manifest, platform) }));
	const taken = new Map<string, { readonly extensionId: string; readonly name: string }>();
	const resolved = new Map<string, Map<string, IParadisResolvedExtensionCommand>>();
	const put = (extensionId: string, command: IParadisResolvedExtensionCommand) => {
		let byName = resolved.get(extensionId);
		if (!byName) {
			byName = new Map();
			resolved.set(extensionId, byName);
		}
		byName.set(command.name, command);
	};
	// 1 周目: 利用者が決めたキー（外したものもここで決まる）
	for (const { id, commands } of read) {
		for (const command of commands) {
			const user = paradisUserShortcutOf(userShortcuts, id, command.name, platform);
			if (!user) {
				continue;
			}
			const key = user.binding ? paradisFormatShortcut(user.binding, platform) : '';
			if (!user.binding || taken.has(key)) {
				put(id, { ...command, shortcut: '', binding: undefined, source: 'removed', suggested: command.shortcut });
				continue;
			}
			taken.set(key, { extensionId: id, name: command.name });
			put(id, { ...command, shortcut: key, binding: user.binding, source: 'user', suggested: command.shortcut });
		}
	}
	// 2 周目: おすすめのキー（先に入れた方が取る）
	for (const { id, commands } of read) {
		for (const command of commands) {
			if (resolved.get(id)?.has(command.name)) {
				continue;
			}
			if (!command.binding) {
				put(id, { ...command, source: 'none', suggested: '' });
				continue;
			}
			const owner = taken.get(command.shortcut);
			if (owner) {
				put(id, { ...command, shortcut: '', binding: undefined, source: 'lost', suggested: command.shortcut, lostTo: owner });
				continue;
			}
			taken.set(command.shortcut, { extensionId: id, name: command.name });
			put(id, { ...command, source: 'suggested', suggested: command.shortcut });
		}
	}
	return new Map(read.map(({ id, commands }) => [id, commands.map(command => resolved.get(id)!.get(command.name)!)]));
}

/** {@link paradisResolveExtensionShortcuts} の、commands.getAll とショートカットを走らせるときに使う形。 */
export function paradisAssignExtensionCommands(extensions: readonly { readonly id: string; readonly manifest: Record<string, unknown> | undefined }[], platform: ParadisPlatform, userShortcuts?: ParadisUserShortcuts): Map<string, IParadisExtensionCommand[]> {
	const resolved = paradisResolveExtensionShortcuts(extensions, platform, userShortcuts);
	return new Map([...resolved].map(([id, commands]) => [id, commands.map(({ name, description, shortcut, binding }) => ({ name, description, shortcut, binding }))]));
}

/** キーを suggested_key の書き方にする（台帳に書く形）。この OS で書けないキー（macOS 以外の ⌘）なら undefined。 */
export function paradisShortcutToSuggestedKey(binding: IParadisShortcut, platform: ParadisPlatform): string | undefined {
	if (!SHORTCUT_KEYS.test(binding.key)) {
		return undefined;
	}
	const parts = platform === 'mac'
		? [binding.control ? 'MacCtrl' : '', binding.alt ? 'Alt' : '', binding.shift ? 'Shift' : '', binding.meta ? 'Command' : '']
		: (binding.meta ? undefined : [binding.control ? 'Ctrl' : '', binding.alt ? 'Alt' : '', binding.shift ? 'Shift' : '']);
	if (!parts) {
		return undefined;
	}
	const text = [...parts.filter(Boolean), binding.key].join('+');
	// 読み直せる（⌘・⌃・⌥ のどれかを含む）ものだけ
	return paradisParseShortcut(text, platform) ? text : undefined;
}

function withUserShortcut(userShortcuts: ParadisUserShortcuts, extensionId: string, name: string, value: string | undefined): ParadisUserShortcuts {
	const current = Object.hasOwn(userShortcuts, extensionId) ? { ...userShortcuts[extensionId] } : {};
	if (value === undefined) {
		delete current[name];
	} else {
		current[name] = value;
	}
	const next: Record<string, Readonly<Record<string, string>>> = { ...userShortcuts };
	if (Object.keys(current).length === 0) {
		delete next[extensionId];
	} else {
		next[extensionId] = current;
	}
	return next;
}

/**
 * コマンドにキーを付ける（付け替え）。今そのキーを使っているほかのコマンドからは外す（Chrome の画面と同じ。外した印を
 * 残すので、付けた側を後で戻しても、外れた側におすすめのキーは戻らない）。付けられないキーなら undefined。
 */
export function paradisWithAssignedShortcut(userShortcuts: ParadisUserShortcuts, extensions: readonly { readonly id: string; readonly manifest: Record<string, unknown> | undefined }[], platform: ParadisPlatform, extensionId: string, name: string, binding: IParadisShortcut): ParadisUserShortcuts | undefined {
	const value = paradisShortcutToSuggestedKey(binding, platform);
	const target = extensions.find(extension => extension.id === extensionId);
	if (value === undefined || !target || !paradisReadExtensionCommands(target.manifest, platform).some(command => command.name === name)) {
		return undefined;
	}
	const key = paradisFormatShortcut(binding, platform);
	let next = userShortcuts;
	for (const [id, commands] of paradisResolveExtensionShortcuts(extensions, platform, userShortcuts)) {
		for (const command of commands) {
			if (command.shortcut === key && !(id === extensionId && command.name === name)) {
				next = withUserShortcut(next, id, command.name, '');
			}
		}
	}
	return withUserShortcut(next, extensionId, name, value);
}

/** コマンドのキーを外す（`clear`）か、拡張機能のおすすめのキーに戻す（`reset`。利用者の記録を消す）。 */
export function paradisWithoutUserShortcut(userShortcuts: ParadisUserShortcuts, extensionId: string, name: string, mode: 'clear' | 'reset'): ParadisUserShortcuts {
	return withUserShortcut(userShortcuts, extensionId, name, mode === 'clear' ? '' : undefined);
}

/** KeyboardEvent.code → suggested_key の書き方のキー（A〜Z と 0〜9 は押した位置で読む。Option・Shift で key が変わるため）。 */
const SHORTCUT_KEYS_BY_CODE: Readonly<Record<string, string>> = {
	Comma: 'Comma', Period: 'Period', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space', Insert: 'Insert', Delete: 'Delete',
	ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
	MediaTrackNext: 'MediaNextTrack', MediaPlayPause: 'MediaPlayPause', MediaTrackPrevious: 'MediaPrevTrack', MediaStop: 'MediaStop',
};

/** 押したキーをショートカットにできなかった理由。 */
export type ParadisShortcutRefusal =
	/** 修飾キーだけを押している（まだ待つ）。 */
	| 'modifierOnly'
	/** Chrome のショートカットに使えないキー。 */
	| 'unsupportedKey'
	/** ⌘・⌃・⌥（macOS 以外は Ctrl・Alt）のどれも含まない。 */
	| 'noModifier'
	/** macOS 以外の ⌘（Windows キー）。Chrome の書き方で書けない。 */
	| 'metaKey'
	/** Para Code のショートカット（ページの中では Para Code が先に取る）。 */
	| 'paraCode';

/**
 * ショートカットを付けるときに押したキーを読む。Para Code のキーかは `paraCodeCommand` が決める（実物では
 * workbench のキーの割り当てを、ページのキーを走らせるときと同じく softDispatch で引く）。
 */
export function paradisShortcutFromKeyEvent(event: { readonly code: string; readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }, platform: ParadisPlatform, paraCodeCommand: () => string | undefined): { readonly refusal: undefined; readonly binding: IParadisShortcut; readonly shortcut: string } | { readonly refusal: Exclude<ParadisShortcutRefusal, 'paraCode'> } | { readonly refusal: 'paraCode'; readonly shortcut: string; readonly command: string } {
	if (['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock', 'OS'].includes(event.key)) {
		return { refusal: 'modifierOnly' };
	}
	const letter = /^Key(?<letter>[A-Z])$/.exec(event.code)?.groups?.letter ?? /^Digit(?<digit>[0-9])$/.exec(event.code)?.groups?.digit;
	const key = letter ?? (Object.hasOwn(SHORTCUT_KEYS_BY_CODE, event.code) ? SHORTCUT_KEYS_BY_CODE[event.code] : undefined);
	if (!key) {
		return { refusal: 'unsupportedKey' };
	}
	if (event.metaKey && platform !== 'mac') {
		return { refusal: 'metaKey' };
	}
	if (!event.ctrlKey && !event.metaKey && !event.altKey) {
		return { refusal: 'noModifier' };
	}
	const binding: IParadisShortcut = { key, control: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey };
	const shortcut = paradisFormatShortcut(binding, platform);
	const command = paraCodeCommand();
	if (command !== undefined) {
		return { refusal: 'paraCode', shortcut, command };
	}
	return { refusal: undefined, binding, shortcut };
}

/** 保存してあった利用者のキーを読む（`ids` にある拡張機能だけ。読めない値は捨てる）。 */
export function paradisParseUserShortcuts(raw: unknown, ids: ReadonlySet<string>): ParadisUserShortcuts {
	const result: Record<string, Record<string, string>> = {};
	if (!isRecord(raw)) {
		return result;
	}
	for (const [id, byName] of Object.entries(raw)) {
		if (!ids.has(id) || !isRecord(byName)) {
			continue;
		}
		const entries = Object.entries(byName).filter((entry): entry is [string, string] => entry[0].length > 0 && entry[0].length <= 200 && typeof entry[1] === 'string' && entry[1].length <= 100).slice(0, MAX_USER_SHORTCUTS_PER_EXTENSION);
		if (entries.length > 0) {
			result[id] = Object.fromEntries(entries);
		}
	}
	return result;
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
			shortcut: binding ? paradisFormatShortcut(binding, platform) : '',
			binding,
		};
	});
}
