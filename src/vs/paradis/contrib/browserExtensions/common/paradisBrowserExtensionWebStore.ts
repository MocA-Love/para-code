/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/shared/browser-extension-webstore.ts, src/main/browser/extensions/browser-extension-permission-summary.ts

// Chrome ウェブストアから入れるとき（P7）の、renderer と main の両方で使う決まり。

import { paradisIsExtensionId } from './paradisBrowserExtensions.js';

/** ストアのページの橋（P7b）の名前（ストアのページの preload は束ねないので書き写してある。テストが一致を確かめる）。 */
export const PARADIS_WEB_STORE_CHANNEL = 'paradis:webStore';
export const PARADIS_WEB_STORE_EVENT_CHANNEL = 'paradis:webStoreEvent';
export const PARADIS_WEB_STORE_QUERY = 'paradis:webStoreAllowed';

/** ストアのページの橋（P7b）の答え。`value` はページの callback へ、`error` は callback の間だけ runtime.lastError になる。 */
export interface IParadisWebStoreReply {
	readonly value?: unknown;
	readonly error?: string;
}

/** Chrome ウェブストアの origin（前方一致にすると似せた名前の host に入れる力を渡すので、完全一致で比べる）。 */
export const PARADIS_CHROME_WEB_STORE_ORIGIN = 'https://chromewebstore.google.com';

const STORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com']);

/** ストアの詳しいページのリンク（今の host と前の host）か、32 文字の id から id を読む。読めなければ undefined。 */
export function paradisParseWebStoreInput(input: string): string | undefined {
	const trimmed = input.trim();
	if (paradisIsExtensionId(trimmed.toLowerCase())) {
		return trimmed.toLowerCase();
	}
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' || !STORE_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
		return undefined;
	}
	const segments = url.pathname.split('/').filter(Boolean);
	const detail = segments.indexOf('detail');
	if (detail === -1) {
		return undefined;
	}
	// `/detail/<名前>/<id>` か `/detail/<id>`（前の host は先頭に `/webstore` が付く）
	return segments.slice(detail + 1, detail + 3).find(segment => paradisIsExtensionId(segment));
}

/** 拡張機能ができること（入れる前の確認に出し、落とした中身が確認したものと同じかを比べる）。 */
export interface IParadisExtensionAccess {
	/** API の権限（manifest の名前のまま）。 */
	readonly permissions: readonly string[];
	/** サイト（host_permissions、MV2 の permissions のサイト、content script の matches）。 */
	readonly hostPermissions: readonly string[];
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isHostPattern(permission: string): boolean {
	return permission === '<all_urls>' || permission.includes('://');
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

/** manifest から、拡張機能ができることをまとめる。 */
export function paradisSummarizeExtensionAccess(manifest: unknown): IParadisExtensionAccess {
	if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
		return { permissions: [], hostPermissions: [] };
	}
	const fields = manifest as Record<string, unknown>;
	const declared = strings(fields.permissions);
	const contentScripts = Array.isArray(fields.content_scripts) ? fields.content_scripts : [];
	const matches = contentScripts.flatMap((script: unknown) => script !== null && typeof script === 'object' ? strings((script as Record<string, unknown>).matches) : []);
	return {
		permissions: sortedUnique(declared.filter(permission => !isHostPattern(permission))),
		hostPermissions: sortedUnique([...declared.filter(isHostPattern), ...strings(fields.host_permissions), ...matches]),
	};
}

/** 2 つが同じか（Chrome は確認したものと違う中身を入れない）。 */
export function paradisSameExtensionAccess(a: IParadisExtensionAccess, b: IParadisExtensionAccess): boolean {
	const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
	return same(a.permissions, b.permissions) && same(a.hostPermissions, b.hostPermissions);
}
