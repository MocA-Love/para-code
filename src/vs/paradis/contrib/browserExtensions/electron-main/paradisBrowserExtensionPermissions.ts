/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/api/permissions.ts, src/main/browser/extensions/browser-extension-permission-grants.ts

// chrome.permissions（後から求める権限）と、利用者の操作（ユーザージェスチャー）の記録（P5c）。
//
//  - 後から許した権限は場所（`default` / `profile:<id>`、D2）ごとに JSON に保存する。Para Code が足した API（cookies・
//    downloads・notifications・management・contextMenus・tabs の URL など）はこれを見る。Electron が元から持つ API
//    （scripting・content script の対象のサイト）は manifest しか見ないので、後から許したサイトでも動かない（残り）
//  - permissions.request は、利用者の操作の中からだけ（Chrome と同じ）。Para Code の確認のダイアログで聞く
//  - 利用者の操作: main が記録したものだけ（拡張機能の申告は信じない）。Para Code が渡した操作（ツールバーのボタン・
//    右クリックの項目・ショートカット・通知を押した）と、拡張機能自身のページへの本物のクリックやキーから 5 秒の間

import { promises as fs } from 'fs';
import type { Session } from 'electron';
import { IParadisApiExtension, IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import { paradisMatchesUrlPattern } from './paradisBrowserExtensionTabs.js';

/** chrome.permissions.Permissions。 */
export interface IParadisPermissionSet {
	readonly permissions: readonly string[];
	readonly origins: readonly string[];
}

const EMPTY: IParadisPermissionSet = { permissions: [], origins: [] };

/** 操作の後、操作の中とみなす長さ（Chrome の transient activation に近い）。 */
const USER_GESTURE_WINDOW_MS = 5_000;

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isOriginPattern(value: string): boolean {
	return value === '<all_urls>' || value.includes('://');
}

function split(entries: readonly string[]): { permissions: string[]; origins: string[] } {
	return { permissions: entries.filter(entry => !isOriginPattern(entry)), origins: entries.filter(isOriginPattern) };
}

/** manifest の権限（MV2 は permissions にサイトも並べる。MV3 は host_permissions に分けた）。 */
export function paradisManifestPermissionSets(manifest: Record<string, unknown>): { readonly required: IParadisPermissionSet; readonly optional: IParadisPermissionSet } {
	const required = split(strings(manifest.permissions));
	const optional = split(strings(manifest.optional_permissions));
	required.origins.push(...strings(manifest.host_permissions));
	optional.origins.push(...strings(manifest.optional_host_permissions));
	return { required, optional };
}

const PATTERN = /^(?<scheme>\*|https?|wss?|file|ftp):\/\/(?<host>\*|\*\.[^/*]+|[^/*]+)?(?<path>\/.*)$/;

/** `requested` に当たるすべての URL に `granted` も当たるか（Chrome の部分集合の決まり）。 */
export function paradisOriginPatternCovers(granted: string, requested: string): boolean {
	if (granted === '<all_urls>') {
		return true;
	}
	if (requested === '<all_urls>') {
		return false;
	}
	const g = PATTERN.exec(granted)?.groups;
	const r = PATTERN.exec(requested)?.groups;
	if (!g || !r) {
		return false;
	}
	const schemeOk = g.scheme === r.scheme || (g.scheme === '*' && ['http', 'https', 'ws', 'wss'].includes(r.scheme));
	const gh = (g.host ?? '').toLowerCase();
	const rh = (r.host ?? '').toLowerCase();
	const hostOk = gh === '*' || gh === rh || (gh.startsWith('*.') && (rh === gh.slice(2) || rh.endsWith(gh.slice(1))));
	const pathOk = g.path === r.path || g.path === '/*' || (!r.path.includes('*') && paradisMatchesUrlPattern(`https://x${g.path}`, `https://x${r.path}`));
	return schemeOk && hostOk && pathOk;
}

function covered(origin: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => paradisOriginPatternCovers(pattern, origin));
}

/** manifest の権限と、後から許したもの。 */
export function paradisEffectivePermissions(manifest: Record<string, unknown>, granted: IParadisPermissionSet): IParadisPermissionSet {
	const { required } = paradisManifestPermissionSets(manifest);
	return {
		permissions: [...new Set([...required.permissions, ...granted.permissions])],
		origins: [...new Set([...required.origins, ...granted.origins])],
	};
}

/** permissions.request で聞くもの、または断る理由。 */
export function paradisPlanPermissionRequest(manifest: Record<string, unknown>, granted: IParadisPermissionSet, request: Partial<IParadisPermissionSet>): { readonly kind: 'invalid'; readonly error: string } | { readonly kind: 'already-granted' } | { readonly kind: 'prompt'; readonly add: IParadisPermissionSet } {
	const { required, optional } = paradisManifestPermissionSets(manifest);
	const effective = paradisEffectivePermissions(manifest, granted);
	const permissions = [...new Set(request.permissions ?? [])];
	const origins = [...new Set(request.origins ?? [])];
	const notInManifest = 'Only permissions specified in the manifest may be requested.';
	if (permissions.some(permission => !required.permissions.includes(permission) && !optional.permissions.includes(permission))) {
		return { kind: 'invalid', error: notInManifest };
	}
	if (origins.some(origin => !covered(origin, [...required.origins, ...optional.origins]))) {
		return { kind: 'invalid', error: notInManifest };
	}
	const add = { permissions: permissions.filter(permission => !effective.permissions.includes(permission)), origins: origins.filter(origin => !covered(origin, effective.origins)) };
	return add.permissions.length === 0 && add.origins.length === 0 ? { kind: 'already-granted' } : { kind: 'prompt', add };
}

/** permissions.remove で外すもの（manifest の必須の権限は外せない）。 */
export function paradisPlanPermissionRemoval(manifest: Record<string, unknown>, granted: IParadisPermissionSet, request: Partial<IParadisPermissionSet>): { readonly kind: 'invalid'; readonly error: string } | { readonly kind: 'remove'; readonly removed: IParadisPermissionSet } {
	const { required } = paradisManifestPermissionSets(manifest);
	const permissions = request.permissions ?? [];
	const origins = request.origins ?? [];
	if (permissions.some(permission => required.permissions.includes(permission)) || origins.some(origin => required.origins.includes(origin))) {
		return { kind: 'invalid', error: 'You cannot remove required permissions.' };
	}
	return { kind: 'remove', removed: { permissions: permissions.filter(permission => granted.permissions.includes(permission)), origins: origins.filter(origin => granted.origins.includes(origin)) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `{ permissions?, origins? }` の引数。 */
function permissionsArg(args: readonly unknown[]): [Partial<IParadisPermissionSet>] | undefined {
	if (args.length !== 1 || !isRecord(args[0])) {
		return undefined;
	}
	const { permissions, origins } = args[0];
	if ((permissions !== undefined && !Array.isArray(permissions)) || (origins !== undefined && !Array.isArray(origins))) {
		return undefined;
	}
	return [{ ...(permissions !== undefined ? { permissions: strings(permissions).slice(0, 100) } : {}), ...(origins !== undefined ? { origins: strings(origins).slice(0, 100) } : {}) }];
}

/** 確認のダイアログで聞く内容。 */
export interface IParadisPermissionPrompt {
	readonly extensionName: string;
	readonly add: IParadisPermissionSet;
}

type State = Record<string, Record<string, IParadisPermissionSet>>;

export class ParadisBrowserExtensionPermissions {

	/** 場所 → 拡張機能の id → 後から許した権限。 */
	private _state: State = {};
	private _saving: Promise<void> = Promise.resolve();
	private readonly _gestures = new WeakMap<ParadisApiSession | Session, Map<string, number>>();
	private readonly _pending = new Set<string>();
	/** この起動で削除した拡張機能（削除と同時の書き込みが、消した権限を書き戻さないように）。 */
	private readonly _forgotten = new Set<string>();

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _path: string,
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
		/** 確認のダイアログ（許したら true。Para Code のウィンドウが無ければ false）。 */
		private readonly _ask: (prompt: IParadisPermissionPrompt) => Promise<boolean>,
		private readonly _nameOf: (extension: IParadisApiExtension) => string,
		private readonly _now: () => number = Date.now,
	) {
		_host.setGrantedPermissionsLookup((extensionId, place) => this.granted(extensionId, place).permissions);
		this._registerNamespace();
	}

	async load(): Promise<void> {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(this._path, 'utf8'));
			const state: State = {};
			if (isRecord(raw)) {
				for (const [place, byExtension] of Object.entries(raw)) {
					if (isRecord(byExtension)) {
						state[place] = Object.fromEntries(Object.entries(byExtension).filter(([, value]) => isRecord(value)).map(([id, value]) => [id, { permissions: strings((value as Record<string, unknown>).permissions), origins: strings((value as Record<string, unknown>).origins) }]));
					}
				}
			}
			this._state = state;
		} catch {
			this._state = {};
		}
	}

	/** 後から許した権限（その場所で）。 */
	granted(extensionId: string, place: string): IParadisPermissionSet {
		return this._state[place]?.[extensionId] ?? EMPTY;
	}

	/** Para Code が見るサイトの権限: manifest のものと、その場所で後から許したもの。 */
	hostPatterns(extension: IParadisApiExtension, place: string): readonly string[] {
		return paradisEffectivePermissions(extension.manifest, this.granted(extension.id, place)).origins;
	}

	/** 削除した拡張機能の、すべての場所の権限を忘れる。 */
	forgetExtension(extensionId: string): Promise<void> {
		this._forgotten.add(extensionId);
		this._state = Object.fromEntries(Object.entries(this._state).map(([place, byExtension]) => [place, Object.fromEntries(Object.entries(byExtension).filter(([id]) => id !== extensionId))]));
		return this._save();
	}

	/** 利用者の操作をその拡張機能へ渡した（ボタン・右クリックの項目・ショートカット・通知を押した）。 */
	noteUserGesture(session: ParadisApiSession | Session, extensionId: string): void {
		let byExtension = this._gestures.get(session);
		if (!byExtension) {
			byExtension = new Map();
			this._gestures.set(session, byExtension);
		}
		byExtension.set(extensionId, this._now());
	}

	/**
	 * 呼び出しが利用者の操作の中か。拡張機能の申告（本文）は見ず、main の記録だけで決める: Para Code が渡した操作と、
	 * 拡張機能自身のページ（ポップアップ・小さな窓・タブで開いた拡張機能のページ）への本物のクリックやキー
	 * （paradisBrowserExtensionWindows.ts が input-event で記録する。エージェントは P1・P2 の守りで拡張機能のページへ
	 * 入力できないので、そこへの入力は利用者のもの）。
	 */
	hasUserGesture(caller: Pick<IParadisExtensionApiCaller, 'session' | 'extension'>): boolean {
		const at = this._gestures.get(caller.session)?.get(caller.extension.id);
		return at !== undefined && this._now() - at <= USER_GESTURE_WINDOW_MS;
	}

	private _set(place: string, extensionId: string, value: IParadisPermissionSet): void {
		if (this._forgotten.has(extensionId)) {
			return;
		}
		this._state = { ...this._state, [place]: { ...this._state[place], [extensionId]: value } };
		void this._save();
	}

	private _save(): Promise<void> {
		const state = this._state;
		this._saving = this._saving.then(async () => {
			const temporary = `${this._path}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(state));
			await fs.rename(temporary, this._path);
		}).catch(error => this._logService.warn('[paradis] could not save the browser extension permission grants', error));
		return this._saving;
	}

	private _emit(caller: IParadisExtensionApiCaller, event: 'onAdded' | 'onRemoved', change: IParadisPermissionSet): void {
		if (change.permissions.length > 0 || change.origins.length > 0) {
			this._host.emitToPlace(caller.place, caller.extension.id, 'permissions', event, [{ permissions: [...change.permissions], origins: [...change.origins] }]);
		}
	}

	private async _request(caller: IParadisExtensionApiCaller, wanted: Partial<IParadisPermissionSet>): Promise<boolean> {
		const { extension, place } = caller;
		const plan = paradisPlanPermissionRequest(extension.manifest, this.granted(extension.id, place), wanted);
		if (plan.kind === 'invalid') {
			throw new ParadisExtensionApiError(plan.error);
		}
		if (plan.kind === 'already-granted') {
			return true;
		}
		if (!this.hasUserGesture(caller)) {
			throw new ParadisExtensionApiError('This function must be called during a user gesture');
		}
		const key = `${place}\n${extension.id}`;
		if (this._pending.has(key)) {
			throw new ParadisExtensionApiError('A permissions request is already pending');
		}
		this._pending.add(key);
		try {
			if (!await this._ask({ extensionName: this._nameOf(extension), add: plan.add })) {
				return false;
			}
			const current = this.granted(extension.id, place);
			this._set(place, extension.id, { permissions: [...new Set([...current.permissions, ...plan.add.permissions])], origins: [...new Set([...current.origins, ...plan.add.origins])] });
			this._emit(caller, 'onAdded', plan.add);
			return true;
		} finally {
			this._pending.delete(key);
		}
	}

	private _remove(caller: IParadisExtensionApiCaller, wanted: Partial<IParadisPermissionSet>): boolean {
		const { extension, place } = caller;
		const current = this.granted(extension.id, place);
		const plan = paradisPlanPermissionRemoval(extension.manifest, current, wanted);
		if (plan.kind === 'invalid') {
			throw new ParadisExtensionApiError(plan.error);
		}
		this._set(place, extension.id, { permissions: current.permissions.filter(permission => !plan.removed.permissions.includes(permission)), origins: current.origins.filter(origin => !plan.removed.origins.includes(origin)) });
		this._emit(caller, 'onRemoved', plan.removed);
		return true;
	}

	private _registerNamespace(): void {
		this._host.registerNamespace('permissions', {
			methods: {
				contains: paradisDefineExtensionMethod(permissionsArg, (caller, wanted) => {
					const effective = paradisEffectivePermissions(caller.extension.manifest, this.granted(caller.extension.id, caller.place));
					return (wanted.permissions ?? []).every(permission => effective.permissions.includes(permission)) && (wanted.origins ?? []).every(origin => covered(origin, effective.origins));
				}),
				getAll: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => {
					const effective = paradisEffectivePermissions(caller.extension.manifest, this.granted(caller.extension.id, caller.place));
					return { permissions: [...effective.permissions], origins: [...effective.origins] };
				}),
				request: paradisDefineExtensionMethod(permissionsArg, (caller, wanted) => this._request(caller, wanted)),
				remove: paradisDefineExtensionMethod(permissionsArg, (caller, wanted) => this._remove(caller, wanted)),
			},
			events: ['onAdded', 'onRemoved'],
		});
	}
}
