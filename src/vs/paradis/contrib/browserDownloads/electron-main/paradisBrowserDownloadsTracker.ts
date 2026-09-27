/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのダウンロードを main プロセスで1か所に集めて、renderer の一覧（URL バー右の
// ボタンとポップオーバー）へ流す。
//
// 権威は main にある: DownloadItem は main にしか無く、ファイルを開く・Finder で見せるのも main
// の shell でしか行えない。renderer から届くのは main が振った id だけで、パスは受け取らない
// （renderer が任意のパスを開かせる口にならないようにする）。
//
// Electron に依存する部分（shell、DownloadItem）はコンストラクタで受け取り、テストでは偽物を渡す。

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { IParadisBrowserDownloadItem, IParadisBrowserDownloadsMainService, ParadisBrowserDownloadState, paradisIsOpenableDownload } from '../common/paradisBrowserDownloads.js';

/** Electron の `DownloadItem` のうち、ここで使う部分だけ。 */
export interface IParadisTrackedDownloadItem {
	getFilename(): string;
	getSavePath(): string;
	getURL(): string;
	getState(): 'progressing' | 'completed' | 'cancelled' | 'interrupted';
	getReceivedBytes(): number;
	getTotalBytes(): number;
	getStartTime(): number;
	cancel(): void;
	on(event: 'updated', listener: () => void): unknown;
	on(event: 'done', listener: () => void): unknown;
}

/** main でファイルを開く手段。本物は Electron の `shell`。 */
export interface IParadisDownloadsShell {
	/** 既定のアプリで開く。失敗したときは空でない文字列（エラー）を返す。 */
	openPath(path: string): Promise<string>;
	showItemInFolder(path: string): void;
	exists(path: string): boolean;
	/**
	 * 完了したファイルに OS の隔離の印（macOS の com.apple.quarantine、Windows の Zone.Identifier）が
	 * 付いているか確かめ、無ければ付ける。開いたときに OS の警告（Gatekeeper / SmartScreen）を通させるため。
	 * 印が付いている（付けた・元から付いていた・印の仕組みが無い OS）なら true、付けられなければ false。
	 */
	ensureQuarantine(path: string, sourceUrl: string): Promise<boolean>;
}

/** ダウンロードがどのセッションから来たか。 */
export interface IParadisDownloadOrigin {
	/** エージェント専用の保存領域（Agent スコープ）。 */
	readonly agentSession: boolean;
	/** 名前付きプロファイルの ID。 */
	readonly profileId?: string;
}

/** 一覧に残す最大件数。超えたら終わったものから古い順に落とす（進行中は落とさない）。 */
const PARADIS_MAX_DOWNLOADS = 30;
/** 進み具合の通知の間隔。`updated` はチャンクごとに来るので、そのまま流すと IPC が詰まる。 */
const PARADIS_PROGRESS_THROTTLE_MS = 250;

interface ITrackedEntry {
	readonly id: string;
	readonly item: IParadisTrackedDownloadItem;
	readonly startTime: number;
	/** ダウンロードを始めた時点で決めた、エージェントのタブ由来か。 */
	readonly fromAgent: boolean;
	/** `done` を受けた後の最終状態。受ける前は item から毎回読む。 */
	finalState: ParadisBrowserDownloadState | undefined;
	/** 隔離の印: 付けている途中（この間は完了として見せない）・付いた・付けられなかった。 */
	quarantine: 'pending' | 'ok' | 'failed' | undefined;
}

export class ParadisBrowserDownloadsTracker extends Disposable implements IParadisBrowserDownloadsMainService {

	private readonly _onDidChangeDownloads = this._register(new Emitter<readonly IParadisBrowserDownloadItem[]>());
	readonly onDidChangeDownloads = this._onDidChangeDownloads.event;

	/** 新しい順。 */
	private readonly _entries: ITrackedEntry[] = [];
	private _nextId = 1;
	/** エージェントが作った印の付いたプロファイル（renderer から知らされる）。 */
	private _agentProfileIds: ReadonlySet<string> = new Set();
	private _throttleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _shell: IParadisDownloadsShell,
		private readonly _downloadsDirectory: () => string,
		private readonly _now: () => number = Date.now,
	) {
		super();
		this._register({ dispose: () => this._clearThrottle() });
	}

	/** `will-download` から呼ばれる。保存先は呼び出し側で決めてある（決まっていないこともある）。 */
	track(item: IParadisTrackedDownloadItem, origin: IParadisDownloadOrigin = { agentSession: false }): void {
		if (this._store.isDisposed) {
			return;
		}
		const entry: ITrackedEntry = {
			fromAgent: origin.agentSession || (origin.profileId !== undefined && this._agentProfileIds.has(origin.profileId)),
			quarantine: undefined,
			id: `download-${this._nextId++}`,
			item,
			// getStartTime() は秒（小数）。取れない場合は今の時刻で代用する。
			startTime: item.getStartTime() > 0 ? Math.round(item.getStartTime() * 1000) : this._now(),
			finalState: undefined,
		};
		this._entries.unshift(entry);
		this._trim();
		item.on('updated', () => this._scheduleFire());
		item.on('done', () => {
			entry.finalState = item.getState();
			// 保存ダイアログを出してユーザーが閉じた（保存先が無いまま取り消された）ものは、
			// ダウンロードが始まってすらいないので一覧に残さない。
			if (entry.finalState === 'cancelled' && !item.getSavePath()) {
				this._removeEntry(entry.id);
			}
			const savePath = item.getSavePath();
			if (entry.finalState === 'completed' && savePath) {
				// 印を付け終えるまでは完了として見せない（付ける前に「開く」を押されないように）。
				entry.quarantine = 'pending';
				this._shell.ensureQuarantine(savePath, item.getURL()).then(ok => ok, () => false).then(ok => {
					entry.quarantine = ok ? 'ok' : 'failed';
					this._fireNow();
				});
			}
			this._fireNow();
		});
		this._fireNow();
	}

	async list(): Promise<readonly IParadisBrowserDownloadItem[]> {
		return this._snapshot();
	}

	async cancel(id: string): Promise<void> {
		const entry = this._find(id);
		if (entry && this._stateOf(entry) === 'progressing') {
			entry.item.cancel();
		}
	}

	async open(id: string): Promise<boolean> {
		const entry = this._find(id);
		if (!entry || this._stateOf(entry) !== 'completed') {
			return false;
		}
		const path = entry.item.getSavePath();
		// renderer 側でもボタンを出していないが、ここでも断る（renderer を信用しない）。
		if (!path || entry.fromAgent || entry.quarantine !== 'ok' || !paradisIsOpenableDownload(basename(path)) || !this._shell.exists(path)) {
			return false;
		}
		return (await this._shell.openPath(path)) === '';
	}

	async showInFolder(id: string): Promise<boolean> {
		const entry = this._find(id);
		const path = entry?.item.getSavePath();
		if (!path || !this._shell.exists(path)) {
			return false;
		}
		this._shell.showItemInFolder(path);
		return true;
	}

	async remove(id: string): Promise<void> {
		const entry = this._find(id);
		if (entry && this._stateOf(entry) !== 'progressing') {
			this._removeEntry(id);
			this._fireNow();
		}
	}

	async clearFinished(): Promise<void> {
		const before = this._entries.length;
		for (let i = this._entries.length - 1; i >= 0; i--) {
			if (this._stateOf(this._entries[i]) !== 'progressing') {
				this._entries.splice(i, 1);
			}
		}
		if (this._entries.length !== before) {
			this._fireNow();
		}
	}

	async setAgentProfiles(profileIds: readonly string[]): Promise<void> {
		this._agentProfileIds = new Set(Array.isArray(profileIds) ? profileIds.filter(id => typeof id === 'string') : []);
	}

	async openDownloadsFolder(): Promise<boolean> {
		const directory = this._downloadsDirectory();
		if (!this._shell.exists(directory)) {
			return false;
		}
		return (await this._shell.openPath(directory)) === '';
	}

	private _find(id: string): ITrackedEntry | undefined {
		return typeof id === 'string' ? this._entries.find(entry => entry.id === id) : undefined;
	}

	private _removeEntry(id: string): void {
		const index = this._entries.findIndex(entry => entry.id === id);
		if (index >= 0) {
			this._entries.splice(index, 1);
		}
	}

	private _stateOf(entry: ITrackedEntry): ParadisBrowserDownloadState {
		if (entry.quarantine === 'pending') {
			return 'progressing';
		}
		return entry.finalState ?? entry.item.getState();
	}

	private _trim(): void {
		for (let i = this._entries.length - 1; i >= 0 && this._entries.length > PARADIS_MAX_DOWNLOADS; i--) {
			if (this._stateOf(this._entries[i]) !== 'progressing') {
				this._entries.splice(i, 1);
			}
		}
	}

	private _snapshot(): IParadisBrowserDownloadItem[] {
		return this._entries.map(entry => {
			const savePath = entry.item.getSavePath();
			const filename = savePath ? basename(savePath) : basename(entry.item.getFilename());
			return {
				id: entry.id,
				filename,
				savePath,
				url: entry.item.getURL(),
				state: this._stateOf(entry),
				receivedBytes: entry.item.getReceivedBytes(),
				totalBytes: entry.item.getTotalBytes(),
				openable: paradisIsOpenableDownload(filename) && entry.quarantine === 'ok',
				fromAgent: entry.fromAgent,
				startTime: entry.startTime,
			};
		});
	}

	private _scheduleFire(): void {
		if (this._throttleTimer !== undefined || this._store.isDisposed) {
			return;
		}
		this._throttleTimer = setTimeout(() => {
			this._throttleTimer = undefined;
			this._fire();
		}, PARADIS_PROGRESS_THROTTLE_MS);
	}

	private _fireNow(): void {
		this._clearThrottle();
		this._fire();
	}

	private _clearThrottle(): void {
		if (this._throttleTimer !== undefined) {
			clearTimeout(this._throttleTimer);
			this._throttleTimer = undefined;
		}
	}

	private _fire(): void {
		if (!this._store.isDisposed) {
			this._onDidChangeDownloads.fire(this._snapshot());
		}
	}
}
