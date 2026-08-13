/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH で繋いだ先の transcript を読んで、手元の写しへ送る側。
//
// エージェントの会話本文を持っているのは接続先のディスクで、そこを開けるのは接続しているこの
// ウィンドウだけ（shared process には手が届かない）。読むのはここ、貯めるのは shared process、
// 読み解くのは今までどおり tailer、と役割を分けている。
//
// 追記だけを送るので、長い会話でも毎回読み直すことにはならない。ファイルが縮んだとき
// （別セッションに置き換わった）だけ写しを捨てて取り直す。

import { disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IParadisMobileRelayService, PARADIS_MOBILE_RELAY_CHANNEL } from '../common/paradisMobileRelay.js';

/** 台帳を見に行く間隔。ファイル監視が効いていれば、これは取りこぼしの受け皿になる。 */
const SYNC_INTERVAL_MS = 2000;

/** 一度に読む大きさ。大きい追記でも往復が増えすぎないところ。 */
const READ_CHUNK_BYTES = 512 * 1024;

/** 台帳が「もう写さなくていい」と答えたときの値。 */
const UNAVAILABLE = -1;

/**
 * 接続先の transcript を手元へ写し続ける contribution。接続していないウィンドウでは何もしない。
 */
export class ParadisRemoteTranscriptMirror extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.remoteTranscriptMirror';

	/** このウィンドウを指す名前。台帳の担当はこれで決まる。 */
	private readonly ownerId = generateUuid();
	private readonly service: IParadisMobileRelayService;
	private readonly remoteAuthority: string | undefined;

	/** 写している transcript: 接続先のパス → ファイル監視。 */
	private readonly tracked = new Map<string, IDisposable>();
	/** 接続先の次に読む位置。 */
	private readonly offsets = new Map<string, number>();
	private readonly reading = new Set<string>();
	private readonly readAgain = new Set<string>();
	private syncing = false;

	constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.remoteAuthority = environmentService.remoteAuthority;
		this.service = ProxyChannel.toService<IParadisMobileRelayService>(sharedProcessService.getChannel(PARADIS_MOBILE_RELAY_CHANNEL));
		if (this.remoteAuthority === undefined) {
			return;
		}
		this._register(toDisposable(() => {
			for (const watcher of this.tracked.values()) {
				watcher.dispose();
			}
			this.tracked.clear();
			// 担当を空けておく。伝えられなくても台帳側は黙った担当を時間で外す
			this.service.releaseRemoteTranscriptMirrors(this.ownerId).catch(() => undefined);
		}));
		this._register(this.fileService.onDidFilesChange(event => {
			for (const remotePath of this.tracked.keys()) {
				if (event.contains(this.remoteUri(remotePath))) {
					this.read(remotePath);
				}
			}
		}));
		this._register(disposableWindowInterval(mainWindow, () => this.sync(), SYNC_INTERVAL_MS));
		void this.sync();
	}

	private remoteUri(remotePath: string): URI {
		return URI.from({ scheme: Schemas.vscodeRemote, authority: this.remoteAuthority, path: remotePath });
	}

	/** 台帳と手元の担当を突き合わせる。 */
	private async sync(): Promise<void> {
		if (this.syncing || this._store.isDisposed) {
			return;
		}
		this.syncing = true;
		try {
			const wanted = new Set(await this.service.listRemoteTranscriptMirrors(this.ownerId));
			for (const remotePath of [...this.tracked.keys()]) {
				if (!wanted.has(remotePath)) {
					this.stop(remotePath);
				}
			}
			for (const remotePath of wanted) {
				if (this.tracked.has(remotePath)) {
					this.read(remotePath);
				} else {
					await this.adopt(remotePath);
				}
			}
		} catch (error) {
			this.logService.trace('[paradis] could not sync the transcripts to follow', error);
		} finally {
			this.syncing = false;
		}
	}

	/**
	 * 接続先にそのファイルが実在するときだけ担当を取る。
	 *
	 * 複数のウィンドウが別々のホストへ繋がっていることがある。台帳は「どのホストのものか」を
	 * 知らないので、実在を確かめた側が名乗り出る形にしている。
	 */
	private async adopt(remotePath: string): Promise<void> {
		const uri = this.remoteUri(remotePath);
		if (!await this.fileService.exists(uri).catch(() => false)) {
			return;
		}
		const offset = await this.service.beginRemoteTranscriptMirror(this.ownerId, remotePath);
		if (offset === UNAVAILABLE) {
			return;
		}
		if (this._store.isDisposed) {
			// dispose 中に begin が完了すると、先に送った release より後で担当を取り直してしまう。
			// 取得後にもう一度解放して、黙った owner を timeout まで残さない。
			await this.service.releaseRemoteTranscriptMirrors(this.ownerId).catch(() => undefined);
			return;
		}
		this.offsets.set(remotePath, offset);
		let watcher: IDisposable;
		try {
			watcher = this.fileService.watch(uri);
		} catch {
			// 監視できなくても、間隔ごとの突き合わせで追いつける
			watcher = toDisposable(() => undefined);
		}
		this.tracked.set(remotePath, watcher);
		this.logService.info(`[paradis] following the conversation on ${this.remoteAuthority}: ${remotePath}`);
		this.read(remotePath);
	}

	private stop(remotePath: string): void {
		this.tracked.get(remotePath)?.dispose();
		this.tracked.delete(remotePath);
		this.offsets.delete(remotePath);
	}

	/** 同じファイルの読みが重ならないようにしつつ、続きを読む。 */
	private read(remotePath: string): void {
		if (this.reading.has(remotePath)) {
			// 読んでいる最中に届いた分は、読み終わってからもう一周して拾う
			this.readAgain.add(remotePath);
			return;
		}
		this.reading.add(remotePath);
		this.readAppended(remotePath)
			.catch(error => this.logService.trace(`[paradis] could not read ${remotePath} on the host`, error))
			.finally(() => {
				this.reading.delete(remotePath);
				if (this.readAgain.delete(remotePath) && this.tracked.has(remotePath)) {
					this.read(remotePath);
				}
			});
	}

	private async readAppended(remotePath: string): Promise<void> {
		const uri = this.remoteUri(remotePath);
		const stat = await this.fileService.stat(uri).catch(() => undefined);
		if (stat === undefined || stat.isDirectory) {
			return;
		}
		const size = stat.size ?? 0;
		let offset = this.offsets.get(remotePath) ?? 0;
		if (size < offset) {
			// 接続先が別のセッションに置き換わった。写しを捨てて取り直す
			// （読み手はサイズが減ったのを見て会話を読み直す）
			offset = await this.service.resetRemoteTranscriptMirror(this.ownerId, remotePath);
			if (offset === UNAVAILABLE) {
				this.stop(remotePath);
				return;
			}
			this.offsets.set(remotePath, offset);
		}
		while (offset < size && this.tracked.has(remotePath) && !this._store.isDisposed) {
			const length = Math.min(READ_CHUNK_BYTES, size - offset);
			const content = await this.fileService.readFile(uri, { position: offset, length });
			if (content.value.byteLength === 0) {
				return;
			}
			const next = await this.service.appendRemoteTranscriptMirror(this.ownerId, remotePath, content.value);
			if (next === UNAVAILABLE) {
				this.stop(remotePath);
				return;
			}
			offset = next;
			this.offsets.set(remotePath, offset);
		}
	}
}

type ParadisRemoteTranscriptMirrorRegistrar = (
	id: string,
	ctor: typeof ParadisRemoteTranscriptMirror,
	phase: WorkbenchPhase,
) => void;

/** デスクトップ集約 entrypoint とテストが共有する registration 契約。 */
export function registerParadisRemoteTranscriptMirrorContribution(
	register: ParadisRemoteTranscriptMirrorRegistrar = registerWorkbenchContribution2,
): void {
	register(ParadisRemoteTranscriptMirror.ID, ParadisRemoteTranscriptMirror, WorkbenchPhase.AfterRestored);
}
