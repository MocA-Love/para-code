/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-webstore-updater.ts, src/main/browser/extensions/browser-extension-held-updates.ts
// The update request shape (Omaha 3.1 JSON without versions, compared locally) follows electron-chrome-web-store (MIT, Samuel Maddock), as Orca does.

// ストアから入れた拡張機能の更新（P7c）。問い合わせの形と、答えの読み方と、どの更新を自動で入れてよいかの決まり。
//
//  - 問い合わせるのは、ストアから入れた拡張機能（台帳の source が webstore）の分だけ。起動の 1 分後と、その後は 5 時間ごと
//    （設計書の 8 章）。フォルダから入れたものは「フォルダから読み込み直す」だけ
//  - 版は手元で比べ、今より新しいものだけを見る（古い版・同じ版は入れない）。落とした中身の版も、もう一度比べる
//  - 落とした中身は P7a と同じく、ストアの署名と id の一致を確かめる
//  - 新しく権限やサイトを求める更新は自動では入れず、保留にして管理画面に出す。利用者が確かめたら落とし直し、保留したときと
//    同じ権限のときだけ入れる。保留はメモリだけに持つ（起動のたびに見つけ直す）

import { randomUUID } from 'crypto';
import type { IParadisExtensionAccess } from '../common/paradisBrowserExtensionWebStore.js';
import { paradisIsAllowedCrxUrl } from './paradisBrowserExtensionWebStore.js';

/** 更新を問い合わせる先。 */
export const PARADIS_WEB_STORE_UPDATE_URL = 'https://update.googleapis.com/service/update2/json';
/** 起動から最初に確かめるまで。 */
export const PARADIS_FIRST_UPDATE_CHECK_DELAY_MS = 60_000;
/** その後に確かめる間（Chrome と同じ 5 時間）。 */
export const PARADIS_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 60_000;
const RESPONSE_PREFIX = ')]}\'';

/** 答えにあった、今より新しい版。 */
export interface IParadisWebStoreUpdate {
	readonly extensionId: string;
	readonly version: string;
	readonly url: string;
	readonly sha256: string | undefined;
	readonly size: number | undefined;
}

/** 新しく権限を求めるため保留にした更新。 */
export interface IParadisHeldUpdate extends IParadisWebStoreUpdate {
	/** その版のすべての権限（確かめた後に落とし直した中身は、これと同じでなければ入れない）。 */
	readonly access: IParadisExtensionAccess;
	/** 今の版に無く、新しく求めるもの（確認に出す）。 */
	readonly added: IParadisExtensionAccess;
}

/** Chrome の版（4 つまでの数を . でつないだもの。足りない所は 0）を比べる。 */
export function paradisCompareExtensionVersions(a: string, b: string): number {
	const left = a.split('.').map(part => Number.parseInt(part, 10) || 0);
	const right = b.split('.').map(part => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) {
			return Math.sign(difference);
		}
	}
	return 0;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function platformName(platform: NodeJS.Platform): string {
	return platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
}

/** 問い合わせの本文と頭（Omaha 3.1 の JSON。版は送らず、手元で比べる）。 */
export function paradisBuildUpdateRequest(extensionIds: readonly string[], environment: { readonly chromeVersion: string; readonly platform: NodeJS.Platform; readonly arch: string }): { readonly body: string; readonly headers: Record<string, string> } {
	return {
		headers: {
			'content-type': 'application/json',
			'X-Goog-Update-Interactivity': 'bg',
			'X-Goog-Update-AppId': extensionIds.join(','),
			'X-Goog-Update-Updater': `chromiumcrx-${environment.chromeVersion}`,
		},
		body: JSON.stringify({
			request: {
				'@updater': 'chromiumcrx',
				acceptformat: 'crx3',
				app: extensionIds.map(appid => ({ appid, updatecheck: {} })),
				os: { platform: platformName(environment.platform), arch: environment.arch === 'ia32' ? 'x86' : environment.arch },
				prodversion: environment.chromeVersion,
				protocol: '3.1',
				requestid: `{${randomUUID()}}`,
				sessionid: `{${randomUUID()}}`,
			},
		}),
	};
}

/** 答えから、入れてある版より新しいものを読む。形のおかしいもの・Google の外の場所・古い版や同じ版は捨てる。 */
export function paradisParseUpdateResponse(text: string, installedVersions: ReadonlyMap<string, string>): IParadisWebStoreUpdate[] {
	const body = text.startsWith(RESPONSE_PREFIX) ? text.slice(RESPONSE_PREFIX.length) : text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return [];
	}
	const updates: IParadisWebStoreUpdate[] = [];
	for (const app of list(record(record(parsed).response).app)) {
		const entry = record(app);
		const updateCheck = record(entry.updatecheck);
		const extensionId = entry.appid;
		const installed = typeof extensionId === 'string' ? installedVersions.get(extensionId) : undefined;
		const manifest = record(updateCheck.manifest);
		const pkg = record(list(record(manifest.packages).package)[0]);
		const codebase = record(list(record(updateCheck.urls).url)[0]).codebase;
		if (typeof extensionId !== 'string' || installed === undefined || updateCheck.status !== 'ok' || typeof manifest.version !== 'string'
			|| !/^\d+(\.\d+){0,3}$/.test(manifest.version) || typeof pkg.name !== 'string' || typeof codebase !== 'string'
			|| paradisCompareExtensionVersions(manifest.version, installed) <= 0 || updates.some(update => update.extensionId === extensionId)) {
			continue;
		}
		let url: string;
		try {
			url = new URL(pkg.name, codebase).toString();
		} catch {
			continue;
		}
		if (!paradisIsAllowedCrxUrl(url)) {
			continue;
		}
		updates.push({
			extensionId, version: manifest.version, url,
			sha256: typeof pkg.hash_sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(pkg.hash_sha256) ? pkg.hash_sha256 : undefined,
			size: typeof pkg.size === 'number' && Number.isInteger(pkg.size) && pkg.size > 0 ? pkg.size : undefined,
		});
	}
	return updates;
}

/** 新しい版が、今の版に無く求めるもの（権限とサイト）。無ければ空。 */
export function paradisAddedAccess(next: IParadisExtensionAccess, current: IParadisExtensionAccess): IParadisExtensionAccess {
	const has = new Set(current.permissions);
	const hosts = new Set(current.hostPermissions);
	return { permissions: next.permissions.filter(permission => !has.has(permission)), hostPermissions: next.hostPermissions.filter(host => !hosts.has(host)) };
}

/** 求めるものが増えるか。 */
export function paradisHasAddedAccess(added: IParadisExtensionAccess): boolean {
	return added.permissions.length > 0 || added.hostPermissions.length > 0;
}

/** 決まった時刻に確かめる（起動の 1 分後と、その後 5 時間ごと）。 */
export class ParadisWebStoreUpdateSchedule {
	private _first: ReturnType<typeof setTimeout> | undefined;
	private _interval: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly _check: () => Promise<void>) { }

	start(): void {
		if (this._first || this._interval) {
			return;
		}
		this._first = setTimeout(() => void this._check(), PARADIS_FIRST_UPDATE_CHECK_DELAY_MS);
		this._interval = setInterval(() => void this._check(), PARADIS_UPDATE_CHECK_INTERVAL_MS);
		// 終わるときに Para Code を待たせない
		(this._first as { unref?(): void }).unref?.();
		(this._interval as { unref?(): void }).unref?.();
	}

	dispose(): void {
		clearTimeout(this._first);
		clearInterval(this._interval);
		this._first = undefined;
		this._interval = undefined;
	}
}
