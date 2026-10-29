/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/api/context-menus.ts, src/main/browser/extensions/browser-extension-context-menu-host.ts, src/main/browser/extensions/api/commands.ts

// chrome.contextMenus（右クリックの項目）と chrome.commands（ショートカット）の main 側（P5b）。
//
//  - 項目は拡張機能を読み込んだセッションの保存先ごと（Chrome のプロファイルごとと同じ単位。runtime.onInstalled も
//    保存先ごとに出すので、onInstalled でだけ項目を作る拡張機能でも、再起動の後に項目が残る）に JSON に保存する
//  - ページの右クリック: upstream の右クリックのメニューの組み立てから、PARA-PATCH の 1 行（paradisBrowserExtensionMenuHook.ts）
//    でここが呼ばれ、Electron の MenuItem を足す。押されたら main の中で onClicked を出す。エージェントの右クリックは
//    upstream の側でその前に止めている
//  - ツールバーのボタンの右クリック: workbench が `action` の項目を聞き、押したら合言葉（1 回きり）と項目の鍵で頼む
//  - ショートカット: ページから workbench へ届いたキーを、そのタブのエディタが見て runCommand を呼ぶ（ページのキーは、
//    ページが使わなかったときだけ preload が送る）。エージェントが打ったキーは preload と main が送る前に止める（PARA-PATCH
//    済みの自動入力の印）ので、拡張機能のショートカットは発火しない。Para Code のショートカットと同じキーなら Para Code が勝つ

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import {
	IParadisExtensionCommand,
	IParadisMenuTarget,
	IParadisStoredMenuItem,
	IParadisVisibleMenuItem,
	PARADIS_ACTION_MENU_CONTEXTS,
	PARADIS_EXECUTE_ACTION_COMMANDS,
	ParadisMenuError,
	ParadisMenuItemId,
	paradisApplyMenuClick,
	paradisArrangeExtensionMenu,
	paradisCreateMenuItem,
	paradisFindMenuItemByKey,
	paradisIsMenuItemId,
	paradisMenuClickData,
	paradisMenuItemProperties,
	paradisMenuTargetFromParams,
	paradisParseStoredMenuItems,
	paradisReadExtensionCommands,
	paradisRemoveMenuItem,
	paradisUpdateMenuItem,
	paradisVisibleMenuTree,
} from '../common/paradisBrowserExtensionMenus.js';
import { IParadisActionResult, IParadisActionMenu, IParadisBrowserExtensionCommand } from '../common/paradisBrowserExtensions.js';
import { IParadisApiExtension, IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import type { IParadisLoadedExtension } from './paradisBrowserExtensionActions.js';
import { paradisChromeFrameId, paradisMatchesUrlPattern, type IParadisTabView, type ParadisBrowserExtensionTabs } from './paradisBrowserExtensionTabs.js';

/** 右クリックの項目とショートカットに要る、main のほかの部分（拡張機能の管理が渡す）。 */
export interface IParadisMenusEnvironment {
	findView(viewId: string): IParadisTabView | undefined;
	/** その WebContents のセッションに読み込んだ、利用者が入れた拡張機能。拡張機能が入らないセッションなら undefined。 */
	sessionOf(contents: WebContents): { readonly session: ParadisApiSession; readonly extensions: readonly IParadisLoadedExtension[] } | undefined;
	/** 拡張機能を読み込んだすべてのセッションの拡張機能（ショートカットの一覧に使う）。 */
	allLoaded(): readonly IParadisLoadedExtension[];
	nameOf(extension: IParadisLoadedExtension): string;
	/** 利用者の操作をその拡張機能へ渡した（P5c、permissions）。 */
	noteUserGesture?(session: ParadisApiSession, extensionId: string): void;
	/** その WebContents がエージェントのタブか（タブでない・分からなければ false）。 */
	isAgentTab?(contents: WebContents): boolean;
}

/** 開いた右クリックのメニュー（押すまでの間、main に持つ）。 */
interface IMenuSnapshot {
	readonly session: ParadisApiSession;
	readonly contents: WebContents;
	/** 開いたときのタブの一番外の文書（移った後に押しても何もしない。Chrome と同じ）。 */
	readonly documentId: string | undefined;
	readonly target: IParadisMenuTarget;
	readonly frameId: number;
	readonly editable: boolean;
	readonly mediaType?: string;
	readonly createdAt: number;
}

const SNAPSHOT_TTL_MS = 10 * 60_000;
const MAX_SNAPSHOTS = 100;

type State = Record<string, Record<string, IParadisStoredMenuItem[]>>;

function hasPermission(extension: IParadisApiExtension, permission: string): boolean {
	const permissions = extension.manifest.permissions;
	return Array.isArray(permissions) && permissions.includes(permission);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** process.platform を manifest の suggested_key の鍵にする。 */
export function paradisCommandPlatform(platform: NodeJS.Platform): 'mac' | 'windows' | 'linux' {
	return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
}

export class ParadisBrowserExtensionMenus implements IDisposable {

	/** セッションの保存先 → 拡張機能 → 項目。 */
	private _state: State = {};
	private _saving: Promise<void> = Promise.resolve();
	private readonly _snapshots = new Map<string, IMenuSnapshot>();
	/** この起動で削除した拡張機能（削除と同時の書き込みが、消した項目を書き戻さないように）。 */
	private readonly _forgotten = new Set<string>();

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _tabs: ParadisBrowserExtensionTabs,
		private readonly _environment: IParadisMenusEnvironment,
		private readonly _path: string,
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
		private readonly _platform: NodeJS.Platform = process.platform,
	) {
		this._registerNamespaces();
	}

	dispose(): void {
		this._snapshots.clear();
	}

	async load(): Promise<void> {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(this._path, 'utf8'));
			const state: State = {};
			if (isRecord(raw)) {
				for (const [storagePath, byExtension] of Object.entries(raw)) {
					if (isRecord(byExtension)) {
						state[storagePath] = Object.fromEntries(Object.entries(byExtension).map(([id, items]) => [id, paradisParseStoredMenuItems(items)]));
					}
				}
			}
			this._state = state;
		} catch {
			this._state = {};
		}
	}

	/** 削除した拡張機能の項目を消す（すべての保存先）。 */
	forgetExtension(extensionId: string): Promise<void> {
		this._forgotten.add(extensionId);
		this._state = Object.fromEntries(Object.entries(this._state).map(([storagePath, byExtension]) => [storagePath, Object.fromEntries(Object.entries(byExtension).filter(([id]) => id !== extensionId))]));
		return this._save();
	}

	private _items(session: ParadisApiSession, extensionId: string): readonly IParadisStoredMenuItem[] {
		return session.storagePath ? this._state[session.storagePath]?.[extensionId] ?? [] : [];
	}

	private _setItems(session: ParadisApiSession, extensionId: string, items: readonly IParadisStoredMenuItem[]): void {
		const storagePath = session.storagePath;
		if (!storagePath || this._forgotten.has(extensionId)) {
			return;
		}
		this._state = { ...this._state, [storagePath]: { ...this._state[storagePath], [extensionId]: [...items] } };
		void this._save();
	}

	private _save(): Promise<void> {
		const state = this._state;
		this._saving = this._saving.then(async () => {
			const temporary = `${this._path}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(state));
			await fs.rename(temporary, this._path);
		}).catch(error => this._logService.warn('[paradis] could not save the browser extension menu items', error));
		return this._saving;
	}

	private _edit(caller: IParadisExtensionApiCaller, change: (items: readonly IParadisStoredMenuItem[]) => readonly IParadisStoredMenuItem[]): void {
		try {
			this._setItems(caller.session, caller.extension.id, change(this._items(caller.session, caller.extension.id)));
		} catch (error) {
			throw error instanceof ParadisMenuError ? new ParadisExtensionApiError(error.message) : error;
		}
	}

	private _properties(raw: Record<string, unknown>) {
		try {
			return paradisMenuItemProperties(raw);
		} catch (error) {
			throw error instanceof ParadisMenuError ? new ParadisExtensionApiError(error.message) : error;
		}
	}

	private _registerNamespaces(): void {
		this._host.registerNamespace('contextMenus', {
			permission: 'contextMenus',
			methods: {
				// 詰め物が id を決めてから送る（Chrome の create は id をその場で返すため）
				create: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) && paradisIsMenuItemId(args[0].id) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, raw) => {
					const id = raw.id as ParadisMenuItemId;
					const properties = this._properties(raw);
					this._edit(caller, items => paradisCreateMenuItem(items, id, properties));
					return id;
				}),
				update: paradisDefineExtensionMethod(args => args.length === 2 && paradisIsMenuItemId(args[0]) && isRecord(args[1]) ? [args[0], args[1]] as [ParadisMenuItemId, Record<string, unknown>] : undefined, (caller, id, raw) => {
					const properties = this._properties(raw);
					this._edit(caller, items => paradisUpdateMenuItem(items, id, properties));
				}),
				remove: paradisDefineExtensionMethod(args => args.length === 1 && paradisIsMenuItemId(args[0]) ? [args[0]] as [ParadisMenuItemId] : undefined, (caller, id) => {
					this._edit(caller, items => paradisRemoveMenuItem(items, id));
				}),
				removeAll: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => {
					this._edit(caller, () => []);
				}),
			},
			events: ['onClicked'],
		});
		this._host.registerNamespace('commands', {
			methods: {
				getAll: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller =>
					paradisReadExtensionCommands(caller.extension.manifest, paradisCommandPlatform(this._platform)).map(command => ({ name: command.name, description: command.description, shortcut: command.shortcut }))),
			},
			events: ['onCommand'],
		});
	}

	// --- ページの右クリック ---

	private _pruneSnapshots(now: number): void {
		for (const [token, snapshot] of this._snapshots) {
			if (now - snapshot.createdAt > SNAPSHOT_TTL_MS || this._snapshots.size > MAX_SNAPSHOTS) {
				this._snapshots.delete(token);
			}
		}
	}

	/** 拡張機能の項目の木を、Electron の MenuItem の形にする。 */
	private _toMenuItems(tree: readonly IParadisVisibleMenuItem[], click: (key: string) => void): MenuItemConstructorOptions[] {
		return tree.map((item): MenuItemConstructorOptions => {
			if (item.type === 'separator') {
				return { type: 'separator' };
			}
			if (item.children.length > 0) {
				return { label: item.title, enabled: item.enabled, submenu: this._toMenuItems(item.children, click) };
			}
			return {
				label: item.title,
				enabled: item.enabled,
				...(item.type === 'checkbox' || item.type === 'radio' ? { type: item.type, checked: item.checked } : {}),
				click: () => click(item.key),
			};
		});
	}

	/** そのセッションで右クリックの項目を持てる拡張機能（名前の順）。 */
	private _menuExtensions(extensions: readonly IParadisLoadedExtension[]): IParadisLoadedExtension[] {
		return extensions.filter(extension => hasPermission(extension, 'contextMenus')).sort((a, b) => this._environment.nameOf(a).localeCompare(this._environment.nameOf(b)));
	}

	/** 内蔵ブラウザのページの右クリックに足す項目（paradisBrowserExtensionMenuHook.ts から）。 */
	buildPageMenu(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
		const info = this._environment.sessionOf(contents);
		// エージェントのタブには出さない（ボタンのメニューと同じ。エージェントの右クリックはこれより前に止まる）
		const agentTab = this._environment.isAgentTab?.(contents) === true;
		if (!info || agentTab || contents.isDestroyed()) {
			return [];
		}
		const frame = params.frame && !params.frame.isDestroyed() ? params.frame : undefined;
		const target = paradisMenuTargetFromParams(params, contents.getURL(), !!frame?.parent);
		const now = Date.now();
		this._pruneSnapshots(now);
		const snapshot: IMenuSnapshot = {
			session: info.session,
			contents,
			documentId: this._tabs.topDocumentId(contents),
			target,
			frameId: frame ? paradisChromeFrameId(frame) : 0,
			editable: params.isEditable,
			mediaType: params.mediaType,
			createdAt: now,
		};
		const result: MenuItemConstructorOptions[] = [];
		for (const extension of this._menuExtensions(info.extensions)) {
			const tree = paradisArrangeExtensionMenu(this._environment.nameOf(extension), paradisVisibleMenuTree(this._items(info.session, extension.id), target, paradisMatchesUrlPattern));
			result.push(...this._toMenuItems(tree, key => this._runClick(snapshot, extension.id, key)));
		}
		return result;
	}

	private _runClick(snapshot: IMenuSnapshot, extensionId: string, key: string): boolean {
		// メニューを開いた文書から移っていたら何もしない（Chrome の RenderViewContextMenu と同じ）
		if (snapshot.contents.isDestroyed() || this._tabs.topDocumentId(snapshot.contents) !== snapshot.documentId) {
			return false;
		}
		const info = this._environment.sessionOf(snapshot.contents);
		const extension = info?.session === snapshot.session ? info.extensions.find(candidate => candidate.id === extensionId) : undefined;
		if (!extension || !hasPermission(extension, 'contextMenus')) {
			return false;
		}
		const items = this._items(snapshot.session, extensionId);
		const item = paradisFindMenuItemByKey(items, key);
		// 開いている間に隠された・使えなくされた・消されたかもしれないので、もう一度確かめる
		if (!item || !item.enabled || item.type === 'separator' || !paradisVisibleMenuTree(items, snapshot.target, paradisMatchesUrlPattern, item.parentId).some(entry => entry.key === key)) {
			return false;
		}
		// 利用者の操作（permissions.request などを、この後の少しの間だけ許す）
		this._environment.noteUserGesture?.(snapshot.session, extensionId);
		const click = paradisApplyMenuClick(items, item);
		if (click.items !== items) {
			this._setItems(snapshot.session, extensionId, click.items);
		}
		const clickData = paradisMenuClickData({ item, target: snapshot.target, frameId: snapshot.frameId, editable: snapshot.editable, mediaType: snapshot.mediaType, wasChecked: click.wasChecked, checked: click.checked });
		const tabId = snapshot.contents.id;
		let tab = this._tabs.describeTab(extension, snapshot.contents.session, tabId);
		if (tab) {
			// activeTab: 利用者が押したので、そのタブの URL とタイトルを見せる
			this._tabs.grantActiveTab(extension, tabId);
			tab = this._tabs.describeTab(extension, snapshot.contents.session, tabId);
		}
		this._host.emit({ session: snapshot.session, extensionId }, 'contextMenus', 'onClicked', tab ? [clickData, tab] : [clickData]);
		return true;
	}

	// --- ツールバーのボタンの右クリック ---

	/** そのタブのその拡張機能の `action` の項目（無ければ undefined）。押すときは合言葉と項目の鍵で runActionMenuItem を呼ぶ。 */
	getActionMenu(viewId: string, extensionId: string): IParadisActionMenu | undefined {
		const view = typeof viewId === 'string' ? this._environment.findView(viewId) : undefined;
		const info = view && !view.isAgentTab() ? this._environment.sessionOf(view.webContents) : undefined;
		const extension = info?.extensions.find(candidate => candidate.id === extensionId);
		if (!view || !info || !extension || !hasPermission(extension, 'contextMenus')) {
			return undefined;
		}
		const target: IParadisMenuTarget = { contexts: new Set(PARADIS_ACTION_MENU_CONTEXTS), pageUrl: view.webContents.getURL() };
		// ボタンのメニューはその拡張機能だけのものなので、名前のサブメニューにはまとめない
		const items = paradisVisibleMenuTree(this._items(info.session, extensionId), target, paradisMatchesUrlPattern);
		if (items.length === 0) {
			return undefined;
		}
		const now = Date.now();
		this._pruneSnapshots(now);
		const token = randomUUID();
		this._snapshots.set(token, { session: info.session, contents: view.webContents, documentId: this._tabs.topDocumentId(view.webContents), target, frameId: 0, editable: false, createdAt: now });
		return { token, items };
	}

	/** ツールバーのボタンの右クリックの項目を押した（合言葉は 1 回きり）。 */
	runActionMenuItem(token: string, extensionId: string, key: string): boolean {
		const snapshot = typeof token === 'string' ? this._snapshots.get(token) : undefined;
		if (!snapshot || typeof key !== 'string' || typeof extensionId !== 'string') {
			return false;
		}
		this._snapshots.delete(token);
		return Date.now() - snapshot.createdAt <= SNAPSHOT_TTL_MS && this._runClick(snapshot, extensionId, key);
	}

	// --- ショートカット ---

	/** 拡張機能のショートカット（workbench がページから届いたキーと比べる）。割り当ての無いものは除く。 */
	getCommands(): IParadisBrowserExtensionCommand[] {
		const seen = new Set<string>();
		const commands: IParadisBrowserExtensionCommand[] = [];
		for (const extension of this._environment.allLoaded()) {
			if (seen.has(extension.id)) {
				continue;
			}
			seen.add(extension.id);
			for (const command of paradisReadExtensionCommands(extension.manifest, paradisCommandPlatform(this._platform))) {
				if (command.binding) {
					commands.push({ extensionId: extension.id, extensionName: this._environment.nameOf(extension), name: command.name, description: command.description, shortcut: command.shortcut, binding: command.binding });
				}
			}
		}
		return commands;
	}

	/**
	 * 利用者がそのタブでショートカットを押した（workbench から）。commands.onCommand をタブ付きで出す。
	 * ポップアップを出すコマンド（_execute_action）は workbench がボタンの位置で activateAction を呼ぶ。
	 */
	runCommand(viewId: string, extensionId: string, name: string): IParadisActionResult {
		const view = typeof viewId === 'string' ? this._environment.findView(viewId) : undefined;
		const info = view && !view.isAgentTab() ? this._environment.sessionOf(view.webContents) : undefined;
		const extension = info?.extensions.find(candidate => candidate.id === extensionId);
		const command = extension ? paradisReadExtensionCommands(extension.manifest, paradisCommandPlatform(this._platform)).find((candidate: IParadisExtensionCommand) => candidate.name === name && candidate.binding) : undefined;
		if (!view || !info || !extension || !command || PARADIS_EXECUTE_ACTION_COMMANDS.has(name)) {
			return { ok: false, error: 'This shortcut is not on for this tab' };
		}
		const tabId = view.webContents.id;
		this._tabs.grantActiveTab(extension, tabId);
		this._environment.noteUserGesture?.(info.session, extensionId);
		const tab = this._tabs.describeTab(extension, view.webContents.session, tabId);
		this._host.emit({ session: info.session, extensionId }, 'commands', 'onCommand', tab ? [name, tab] : [name]);
		return { ok: true };
	}
}
