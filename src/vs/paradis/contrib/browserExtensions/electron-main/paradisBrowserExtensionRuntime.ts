/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-runtime-lifecycle.ts, src/main/browser/extensions/api/runtime.ts

// chrome.runtime.onInstalled と onStartup。Electron はどちらも出さない（Electron 43.7.7 で実測）ので、
// 読み込みの後に Para Code が出す。
//
// 何を出すかは、そのセッションでその拡張機能を最後に読み込んだ版で決める。Global・各ワークスペース・各
// プロファイルのセッションは保存先（chrome.storage.local など）が別なので、Chrome のプロファイル 1 つに
// 当たるのはセッション 1 つ。初めてなら install、版が変わったかフォルダから読み込み直したなら update、
// 起動して初めての読み込みなら onStartup。

import { promises as fs } from 'fs';
import { ParadisExtensionApiHost } from './paradisBrowserExtensionApiHost.js';

/** 最後に読み込んだ版。 */
export interface IParadisLoadedVersions {
	readonly extensionVersion: string;
	readonly chromiumVersion: string;
}

/** startup: 起動してから最初の読み込み。reload: フォルダから読み込み直した。other: それ以外（有効にしたなど）。 */
export type ParadisExtensionLoadKind = 'startup' | 'reload' | 'other';

export interface IParadisRuntimeLifecycleEvent {
	readonly event: 'onInstalled' | 'onStartup';
	readonly args: readonly unknown[];
}

/** 1 回の読み込みで Chrome が出すイベント。 */
export function paradisDecideRuntimeLifecycleEvents(last: IParadisLoadedVersions | undefined, current: IParadisLoadedVersions, kind: ParadisExtensionLoadKind): IParadisRuntimeLifecycleEvent[] {
	if (!last) {
		return [{ event: 'onInstalled', args: [{ reason: 'install' }] }];
	}
	const events: IParadisRuntimeLifecycleEvent[] = kind === 'startup' ? [{ event: 'onStartup', args: [] }] : [];
	// Chrome はフォルダから読み込み直したものを、同じ版でも update として出す
	if (kind === 'reload' || last.extensionVersion !== current.extensionVersion) {
		events.push({ event: 'onInstalled', args: [{ reason: 'update', previousVersion: last.extensionVersion }] });
	} else if (last.chromiumVersion !== current.chromiumVersion) {
		events.push({ event: 'onInstalled', args: [{ reason: 'chrome_update' }] });
	}
	return events;
}

type State = Record<string, Record<string, IParadisLoadedVersions>>;

function isVersions(value: unknown): value is IParadisLoadedVersions {
	return value !== null && typeof value === 'object'
		&& typeof (value as IParadisLoadedVersions).extensionVersion === 'string'
		&& typeof (value as IParadisLoadedVersions).chromiumVersion === 'string';
}

/** セッションの保存先 × 拡張機能 → 最後に読み込んだ版（JSON 1 つ）。 */
export class ParadisBrowserExtensionRuntimeState {
	private _state: State = {};
	private _saving: Promise<void> = Promise.resolve();

	constructor(private readonly _path: string, private readonly _logService: { warn(message: string, ...args: unknown[]): void }) { }

	async load(): Promise<void> {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(this._path, 'utf8'));
			const state: State = {};
			if (raw !== null && typeof raw === 'object') {
				for (const [storagePath, byExtension] of Object.entries(raw)) {
					if (byExtension !== null && typeof byExtension === 'object') {
						state[storagePath] = Object.fromEntries(Object.entries(byExtension).filter((entry): entry is [string, IParadisLoadedVersions] => isVersions(entry[1])));
					}
				}
			}
			this._state = state;
		} catch {
			this._state = {};
		}
	}

	read(storagePath: string, extensionId: string): IParadisLoadedVersions | undefined {
		return this._state[storagePath]?.[extensionId];
	}

	update(storagePath: string, extensionId: string, versions: IParadisLoadedVersions): Promise<void> {
		this._state = { ...this._state, [storagePath]: { ...this._state[storagePath], [extensionId]: versions } };
		return this._save();
	}

	/** 削除した拡張機能を忘れる（入れ直したら install から出す）。 */
	forgetExtension(extensionId: string): Promise<void> {
		this._state = Object.fromEntries(Object.entries(this._state).map(([storagePath, byExtension]) => [storagePath, Object.fromEntries(Object.entries(byExtension).filter(([id]) => id !== extensionId))]));
		return this._save();
	}

	private _save(): Promise<void> {
		const state = this._state;
		this._saving = this._saving.then(async () => {
			const temporary = `${this._path}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(state));
			await fs.rename(temporary, this._path);
		}).catch(error => this._logService.warn('[paradis] could not save the browser extension runtime state', error));
		return this._saving;
	}
}

/** runtime の名前空間（イベントだけ。関数は Electron の本物を使う）。 */
export function paradisRegisterRuntimeApis(host: ParadisExtensionApiHost): void {
	host.registerNamespace('runtime', { methods: {}, events: ['onInstalled', 'onStartup'] });
}
