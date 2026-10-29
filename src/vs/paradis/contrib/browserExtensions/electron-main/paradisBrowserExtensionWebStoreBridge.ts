/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-webstore-bridge-host.ts, src/main/browser/extensions/browser-extension-webstore-install-flow.ts, src/main/browser/extensions/browser-extension-webstore-events.ts

// Chrome ウェブストアのページの「Para Code に追加」（P7b）の main 側。ストアのページの preload
// （../electron-browser/paradisWebStorePreload.ts）からの呼び出しに答える。
//
//  - 呼び出しを受けるのは、送り主のフレームが一番外の文書で、その origin がちょうど https://chromewebstore.google.com で、
//    利用者の内蔵ブラウザのタブ（エージェントのタブ・拡張機能の窓ではない、拡張機能を入れるセッションの、SSH 先ではない
//    もの）のときだけ。エージェントと共有中のタブでは受けない（Q483 と同じ考え方）。値は本文ではなく送り主から決める
//  - ページの JS は webstorePrivate を自由に呼べるので、入れる・外すは、そのタブへの利用者の本物の入力から 5 秒の間だけ受け、
//    入れる前には main が自分で落として署名を確かめた中身の権限を main のダイアログで見せる（ページの manifest は信じない）
//  - 外と話すのは beginInstallWithManifest3 で入れるときだけ（getExtensionStatus・getAll は台帳だけで答える）

import * as electron from 'electron';
import type { WebContents, WebFrameMain } from 'electron';
import { localize } from '../../../../nls.js';
import { paradisIsExtensionPageHeld } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { IParadisAddExtensionResult, PARADIS_DEFAULT_EXTENSION_PROFILE, paradisIsExtensionId } from '../common/paradisBrowserExtensions.js';
import { IParadisWebStoreReply as IParadisWebStoreBridgeReply, PARADIS_CHROME_WEB_STORE_ORIGIN, PARADIS_WEB_STORE_CHANNEL, PARADIS_WEB_STORE_EVENT_CHANNEL, PARADIS_WEB_STORE_QUERY } from '../common/paradisBrowserExtensionWebStore.js';


/** 利用者の操作とみなす入力から、入れる・外すを受ける間。 */
const GESTURE_WINDOW_MS = 5_000;
/** begin で入れた後、complete を待つ間（Chromium の webstorePrivate と同じく、begin と complete は対で呼ばれる）。 */
const APPROVAL_TTL_MS = 2 * 60_000;
const MAX_MANIFEST_CHARS = 2_000_000;
const ACTIVATING_INPUTS: ReadonlySet<string> = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'touchStart', 'touchEnd', 'gestureTap']);

/** ストアのページに見せる、入れてある拡張機能 1 つ。 */
export interface IParadisWebStoreInstalled {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly source: 'unpacked' | 'webstore';
}

/** 拡張機能の管理（テストでは偽物）。 */
export interface IParadisWebStoreBridgeHost {
	/** そのタブが、拡張機能を入れる利用者の内蔵ブラウザのタブなら、その場所（プロファイルのキー）。 */
	placeOf(contents: WebContents): string | undefined;
	listEnabled(place: string): readonly IParadisWebStoreInstalled[];
	/** ストアから落とし、署名を確かめ、main のダイアログで権限を見せてから入れる（P7a の addFromWebStore）。 */
	install(id: string, place: string, placeLabel: string): Promise<IParadisAddExtensionResult>;
	/** その場所から外す（ほかの場所でも有効ならこの場所で無効にし、ここだけなら削除する）。 */
	removeFrom(id: string, place: string): Promise<void>;
	/** 外す前の確認（main のダイアログ）。 */
	confirmRemove(name: string): Promise<boolean>;
	/** 今の WebContents（イベントの届け先を探す。無ければ Electron のすべての WebContents）。 */
	allContents?(): readonly WebContents[];
}

type Frame = Pick<WebFrameMain, 'url' | 'parent' | 'frameTreeNodeId'> & { isDestroyed?(): boolean };

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseManifest(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw !== 'string' || raw.length > MAX_MANIFEST_CHARS) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) && typeof parsed.name === 'string' && typeof parsed.version === 'string' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const USER_CANCELLED: IParadisWebStoreBridgeReply = { value: 'user_cancelled', error: 'User cancelled install' };
const NEEDS_GESTURE = 'This function must be called during a user gesture';

/** 場所の、確認のダイアログに出す名前（main はプロファイルの名前を持たない）。 */
function placeLabel(place: string): string {
	return place === PARADIS_DEFAULT_EXTENSION_PROFILE
		? localize('paradis.browserExtensions.webStore.defaultPlace', "既定（通常のタブ・ワークスペースのタブ）")
		: localize('paradis.browserExtensions.webStore.profilePlace', "このタブのプロファイル");
}

export class ParadisWebStoreBridge {

	private readonly _gestures = new WeakMap<WebContents, number>();
	private readonly _approvals = new Map<string, number>();
	private readonly _busy = new Set<string>();
	private readonly _answered = new WeakSet<WebContents>();
	private _disposed = false;

	constructor(
		private readonly _host: IParadisWebStoreBridgeHost,
		private readonly _now: () => number = Date.now,
	) { }

	/** これから作られるすべての WebContents に受け手を立てる（同期の問いは受け手が無いと renderer が止まる）。 */
	listen(): void {
		const app = electron.app;
		if (!app) {
			return;
		}
		const onCreated = (_event: unknown, contents: WebContents) => this.attach(contents);
		app.on('web-contents-created', onCreated);
		for (const contents of electron.webContents?.getAllWebContents() ?? []) {
			this.attach(contents);
		}
	}

	dispose(): void {
		this._disposed = true;
	}

	/** 1 つの WebContents に受け手を立てる（テストからも呼ぶ）。 */
	attach(contents: Pick<WebContents, 'ipc' | 'on'> & WebContents): void {
		if (this._answered.has(contents)) {
			return;
		}
		this._answered.add(contents);
		contents.ipc.on(PARADIS_WEB_STORE_QUERY, event => {
			event.returnValue = !this._disposed && this._placeFor(contents, event.senderFrame) !== undefined;
		});
		contents.ipc.handle(PARADIS_WEB_STORE_CHANNEL, (event, request: unknown) => this.handle(contents, event.senderFrame, request));
		contents.on('input-event', (_event, input) => {
			if (ACTIVATING_INPUTS.has(input.type)) {
				this._gestures.set(contents, this._now());
			}
		});
	}

	/** 送り主が、橋を出してよいストアのタブの一番外の文書なら、その場所。 */
	private _placeFor(contents: WebContents, frame: Frame | null | undefined): string | undefined {
		try {
			if (!frame || frame.isDestroyed?.() || frame.parent !== null || contents.isDestroyed()) {
				return undefined;
			}
			if (frame.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId || originOf(frame.url) !== PARADIS_CHROME_WEB_STORE_ORIGIN) {
				return undefined;
			}
			// エージェントと共有中のタブでは出さない（Q483 と同じ考え方）
			if (paradisIsExtensionPageHeld(contents)) {
				return undefined;
			}
			return this._host.placeOf(contents);
		} catch {
			return undefined;
		}
	}

	private _hasGesture(contents: WebContents): boolean {
		const at = this._gestures.get(contents);
		return at !== undefined && this._now() - at <= GESTURE_WINDOW_MS;
	}

	/** ストアのページからの 1 回の呼び出し。 */
	async handle(contents: WebContents, frame: Frame | null | undefined, request: unknown): Promise<IParadisWebStoreBridgeReply> {
		const place = this._disposed ? undefined : this._placeFor(contents, frame);
		if (place === undefined || !frame) {
			return { error: 'Not allowed' };
		}
		if (!isRecord(request) || typeof request.method !== 'string' || !Array.isArray(request.args)) {
			return { error: 'Invalid arguments' };
		}
		const args = request.args as unknown[];
		const key = (id: string) => `${contents.id}:${frame.frameTreeNodeId}:${id}`;
		switch (request.method) {
			case 'beginInstallWithManifest3': {
				const details = isRecord(args[0]) ? args[0] : undefined;
				const id = details?.id;
				if (!paradisIsExtensionId(id)) {
					return { value: 'invalid_id', error: 'Invalid id' };
				}
				if (this._installed(place).some(installed => installed.id === id)) {
					return { value: 'already_installed', error: 'This item is already installed' };
				}
				// ページの manifest は、ストアの答えを決めるためだけに読む（入れる中身と権限は、main が落として確かめたもの）
				const manifest = parseManifest(details?.manifest);
				if (!manifest) {
					return { value: 'manifest_error', error: 'Invalid manifest' };
				}
				if (manifest.theme !== undefined || manifest.app !== undefined) {
					return { value: 'unsupported_extension_type', error: 'Para Code can install extensions only' };
				}
				if (typeof manifest.manifest_version !== 'number' || manifest.manifest_version < 3) {
					return { value: 'manifest_error', error: 'Manifest version 2 is no longer supported' };
				}
				if (!this._hasGesture(contents)) {
					return { value: 'unknown_error', error: NEEDS_GESTURE };
				}
				const busyKey = key(id);
				if (this._busy.has(busyKey) || (this._approvals.get(busyKey) ?? 0) > this._now()) {
					return { value: 'install_in_progress', error: 'An installation of the same extension is already in progress' };
				}
				this._busy.add(busyKey);
				try {
					const result = await this._host.install(id, place, placeLabel(place));
					if (!result.ok) {
						return result.reason === 'cancelled' ? USER_CANCELLED
							: result.reason === 'busy' ? { value: 'install_in_progress', error: 'An installation of the same extension is already in progress' }
								: { value: 'install_error', error: result.detail ? `${result.reason}: ${result.detail}` : result.reason };
					}
					this._approvals.set(busyKey, this._now() + APPROVAL_TTL_MS);
					return { value: '' };
				} finally {
					this._busy.delete(busyKey);
				}
			}
			case 'completeInstall': {
				const id = args[0];
				const until = paradisIsExtensionId(id) ? this._approvals.get(key(id)) : undefined;
				if (paradisIsExtensionId(id)) {
					this._approvals.delete(key(id));
				}
				if (until === undefined || until <= this._now() || !paradisIsExtensionId(id)) {
					return { error: `${String(id)} does not match a previous call to beginInstallWithManifest3` };
				}
				// Chrome はページの callback に答えてから management のイベントを出す
				const installed = this._installed(place).find(entry => entry.id === id);
				if (installed) {
					setTimeout(() => this._notify(place, 'onInstalled', [this._info(installed)]), 0);
				}
				return {};
			}
			case 'getExtensionStatus': {
				const id = args[0];
				if (!paradisIsExtensionId(id)) {
					return { error: 'Invalid id' };
				}
				if (this._installed(place).some(installed => installed.id === id)) {
					return { value: 'enabled' };
				}
				const manifest = parseManifest(args[1]);
				return { value: manifest && (typeof manifest.manifest_version !== 'number' || manifest.manifest_version < 3) ? 'deprecated_manifest_version' : 'installable' };
			}
			case 'management.getAll':
				// 入れてある一覧は人を見分ける印になりうるので、ストアのタブにだけ、その場所の分だけ見せる
				return { value: this._installed(place).map(installed => this._info(installed)) };
			case 'management.uninstall': {
				const id = args[0];
				const installed = paradisIsExtensionId(id) ? this._installed(place).find(entry => entry.id === id) : undefined;
				if (!installed) {
					return { error: `Failed to find extension with id ${String(id)}.` };
				}
				if (!this._hasGesture(contents)) {
					return { error: NEEDS_GESTURE };
				}
				// ページから黙って外させない
				const accepted = await this._host.confirmRemove(installed.name).catch(() => false);
				if (!accepted || this._placeFor(contents, frame) !== place) {
					return { error: `Extension ${installed.id} uninstall canceled by user.` };
				}
				await this._host.removeFrom(installed.id, place);
				setTimeout(() => this._notify(place, 'onUninstalled', [installed.id]), 0);
				return {};
			}
			case 'management.setEnabled': {
				const [id, enabled] = args;
				// ストアは有効にすることしか求めない。切り替えは Para Code の管理画面で
				return enabled === true && paradisIsExtensionId(id) && this._installed(place).some(installed => installed.id === id)
					? {}
					: { error: 'Turn extensions on or off in the Para Code extension manager' };
			}
			default:
				return { error: 'Invalid arguments' };
		}
	}

	/**
	 * ストアのページに見せる、その場所で有効な拡張機能。ストアから入れたものだけ（フォルダから入れたものの id は乱数の key から
	 * 作った、その人だけの変わらない値なので、Google のページに渡さない。ストアがボタンに使うのはストアの id だけ）。
	 */
	private _installed(place: string): readonly IParadisWebStoreInstalled[] {
		return this._host.listEnabled(place).filter(installed => installed.source === 'webstore');
	}

	/** ストアのページが読む chrome.management.ExtensionInfo の一部。 */
	private _info(installed: IParadisWebStoreInstalled): Record<string, unknown> {
		return {
			id: installed.id, name: installed.name, shortName: installed.name, version: installed.version, enabled: true, mayDisable: true,
			isApp: false, type: 'extension', installType: installed.source === 'webstore' ? 'normal' : 'development',
		};
	}

	/** その場所のストアのタブ（一番外の文書がストア、共有中でない）にだけ知らせる。 */
	private _notify(place: string, event: 'onInstalled' | 'onUninstalled', args: unknown[]): void {
		for (const contents of this._host.allContents?.() ?? electron.webContents?.getAllWebContents() ?? []) {
			try {
				if (!contents.isDestroyed() && this._placeFor(contents, contents.mainFrame) === place) {
					contents.mainFrame.send(PARADIS_WEB_STORE_EVENT_CHANNEL, { event, args });
				}
			} catch {
				// 途中で閉じた
			}
		}
	}
}
