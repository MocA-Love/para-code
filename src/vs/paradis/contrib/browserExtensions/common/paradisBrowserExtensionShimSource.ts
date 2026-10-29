/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能の写しへ書く詰め物（paracode-extension-api.js）の中身を作る。paradisBrowserExtensionShim.ts の
// 自己完結した関数を toString() で並べ、1 本のスクリプトにする。importScripts でも、副作用だけの module の
// import でも、ページの <script> でも動く形（何も export しない即時実行の関数）。

import {
	PARADIS_EXTENSION_API_CALL_URL,
	PARADIS_EXTENSION_API_EVENTS_URL,
	PARADIS_EXTENSION_TOKEN_FILE,
} from './paradisBrowserExtensionApiWire.js';
import {
	PARADIS_SHIM_STORAGE_RELAY_NAMESPACE,
	PARADIS_SHIM_STORAGE_SYNC_CONSTANTS,
	PARADIS_SHIM_STORAGE_SYNC_NAMESPACE,
	PARADIS_SHIM_SURFACE,
	paradisExtensionShimMain,
	paradisInstallExtensionApis,
	paradisInstallStorageRelay,
	paradisInstallStorageSync,
} from './paradisBrowserExtensionShim.js';

/** つなぎ直すまでの待ち。 */
const RECONNECT_DELAY_MS = 1_000;

/** 詰め物のスクリプト。 */
export function paradisBrowserExtensionShimSource(): string {
	const options = {
		callUrl: PARADIS_EXTENSION_API_CALL_URL,
		eventsUrl: PARADIS_EXTENSION_API_EVENTS_URL,
		tokenPath: `/${PARADIS_EXTENSION_TOKEN_FILE}`,
		surface: PARADIS_SHIM_SURFACE,
		syncConstants: PARADIS_SHIM_STORAGE_SYNC_CONSTANTS,
		relayNamespace: PARADIS_SHIM_STORAGE_RELAY_NAMESPACE,
		syncNamespace: PARADIS_SHIM_STORAGE_SYNC_NAMESPACE,
		reconnectDelayMs: RECONNECT_DELAY_MS,
	};
	return [
		'// Written by Para Code: chrome.* APIs Electron lacks, for this extension\'s worker and pages.',
		'(() => {',
		'\'use strict\';',
		`const installApis = ${paradisInstallExtensionApis.toString()};`,
		`const installStorageRelay = ${paradisInstallStorageRelay.toString()};`,
		`const installStorageSync = ${paradisInstallStorageSync.toString()};`,
		`(${paradisExtensionShimMain.toString()})({ ...${JSON.stringify(options)}, installApis, installStorageRelay, installStorageSync });`,
		'})();',
		'',
	].join('\n');
}
