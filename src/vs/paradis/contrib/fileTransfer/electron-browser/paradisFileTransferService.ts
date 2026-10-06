/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送のウィンドウ内の窓口。待ち行列（1 ウィンドウに 1 つ。タブを閉じても転送は続き、
// 左下のボタンのバッジに件数が出る）、一覧の読み取り、権限のチャネル、接続の状態をまとめて持つ。
//
// 読み書きはすべて IFileService を通す。左の file:// も右の vscode-remote:// も同じサービスで読めるので、
// Para ホストのビュー（remoteHosts）と同じく新しい通り道は作らない。接続していないホストは、shared process が
// SSH（SFTP）を張り、`paradis-sftp://` のプロバイダとして同じ IFileService に見せる（paradisSftpFileSystemProvider.ts）。権限だけは IStat に無いので、
// 手元は shared process、接続先は REH の `paradisFileModes` チャネルに聞く。古い REH には無いので、
// そのときは権限を出さない（`modesAvailable('remote')` が false）。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString, escapeMarkdownSyntaxTokens } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import Severity from '../../../../base/common/severity.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisIsSafeSshHost, paradisRemoteHostBrowser } from '../../remoteHosts/common/paradisRemoteHosts.js';
import {
	IParadisFileModeListing,
	paradisHostLabelFromAuthority,
	paradisToMachineFileUri,
	ParadisTransferSide,
	PARADIS_FILE_MODES_CHANNEL,
	IParadisFileStatInfo,
	PARADIS_FILE_MODES_MIN_VERSION,
	PARADIS_FILE_MODES_RENAME_VERSION,
	PARADIS_FILE_MODES_STAT_VERSION,
	paradisIsUnknownChannelError,
	PARADIS_FILE_TRANSFER_PENDING_OPEN_KEY,
} from '../common/paradisFileTransfer.js';
import { IParadisPaneEntry, paradisFormatDate, paradisFormatSize } from '../common/paradisFileTransferListing.js';
import {
	IParadisConflictDecision,
	IParadisTransferChild,
	IParadisTransferConflict,
	IParadisTransferItem,
	IParadisTransferSource,
	IParadisTransferStat,
	ParadisConflictAction,
	ParadisTransferQueue,
} from '../common/paradisFileTransferQueue.js';
import { IParadisTransferMetadata, ParadisFileServiceTransferFileSystem } from '../browser/paradisFileTransferFileSystem.js';
import { IParadisSftpEntry, paradisDirectTargetFor, paradisIsSafeSftpEntryName, paradisIsSftpResource, paradisSftpIdleMs, paradisSftpUri, PARADIS_SFTP_CHANNEL, PARADIS_SFTP_IDLE_SETTING, PARADIS_SFTP_SCHEME } from '../common/paradisSftp.js';
import { paradisSftpOpenError, ParadisSftpFileSystemProvider } from '../common/paradisSftpFileSystemProvider.js';
import { ParadisTransferTempJournal } from '../browser/paradisFileTransferTempJournal.js';

export interface IParadisPaneListing {
	readonly entries: readonly IParadisPaneEntry[];
	readonly truncated: boolean;
	/** 権限を読めたか（古い REH では false）。 */
	readonly modes: boolean;
}

export const IParadisFileTransferService = createDecorator<IParadisFileTransferService>('paradisFileTransferService');

export interface IParadisFileTransferService {
	readonly _serviceBrand: undefined;

	readonly queue: ParadisTransferQueue;
	/** 接続先との接続が切れた・戻った。 */
	readonly onDidChangeConnection: Event<boolean>;

	/** このウィンドウの接続先。手元のウィンドウでは undefined。 */
	readonly remoteAuthority: string | undefined;
	/** 接続先の見出し（`dev-server`）。 */
	readonly remoteLabel: string | undefined;
	/** 接続先と繋がっているか（手元のウィンドウでは false）。 */
	readonly remoteConnected: boolean;

	/** 見出し。右側で `resource` が接続していないホスト（`paradis-sftp://`）なら、そのホストの別名。 */
	sideLabel(side: ParadisTransferSide, resource?: URI): string;
	/** その URI がその側のものか。 */
	owns(side: ParadisTransferSide, resource: URI): boolean;
	/** 既定の場所。手元はホーム（ワークスペースが手元ならそのフォルダー）、接続先は作業フォルダーかホーム。 */
	defaultLocation(side: ParadisTransferSide, workspaceFolder: URI | undefined): Promise<URI | undefined>;

	list(side: ParadisTransferSide, resource: URI): Promise<IParadisPaneListing>;
	modesAvailable(side: ParadisTransferSide, resource?: URI): Promise<boolean>;
	chmod(side: ParadisTransferSide, resource: URI, mode: number, recursive: boolean): Promise<void>;

	/** 反対側のフォルダーへ送る。同じ名前があれば確認する。積んだ件数を返す。 */
	transfer(sources: readonly IParadisTransferSource[], targetDirectory: URI, targetSide: ParadisTransferSide): Promise<number>;
	/** 失敗・取り消しの 1 件をやり直す（その間に同名ができていたら確かめる）。 */
	retry(item: IParadisTransferItem): Promise<void>;

	/** `~/.ssh/config` のホスト。読めない環境では空。 */
	listConfiguredHosts(): Promise<readonly string[]>;
	/** そのホストへ繋いだ新しいウィンドウを開き、繋がったら転送画面を出させる。 */
	connectAndOpen(alias: string): Promise<void>;
	/**
	 * ユーザーが画面でホストを選んだ。このウィンドウの接続先ならそのホーム（vscode-remote://）を、それ以外は
	 * SSH を直接張ってホーム（paradis-sftp://）を返す。鍵で入れない・ホストの鍵を確かめられないなどは、理由を書いたエラーで投げる。
	 */
	openHost(alias: string): Promise<URI>;
}

export class ParadisFileTransferService extends Disposable implements IParadisFileTransferService {

	declare readonly _serviceBrand: undefined;

	readonly queue: ParadisTransferQueue;

	private readonly _onDidChangeConnection = this._register(new Emitter<boolean>());
	readonly onDidChangeConnection = this._onDidChangeConnection.event;

	readonly remoteAuthority: string | undefined;
	readonly remoteLabel: string | undefined;
	private _remoteConnected: boolean;

	/** 権限のチャネルの版（無ければ 0）。古い REH の「Unknown channel」は覚えておき、繰り返し 1 秒待たない。 */
	private readonly modesSupport = new Map<ParadisTransferSide, Promise<number>>();
	/** 書いている途中の一時ファイルの控え（閉じたり切れたりして残ったものを後で片付ける）。 */
	private readonly journal: ParadisTransferTempJournal;
	/** 接続していないホスト（`paradis-sftp://`）の読み書き。 */
	private readonly sftp: ParadisSftpFileSystemProvider;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IPathService private readonly pathService: IPathService,
		@IStorageService private readonly storageService: IStorageService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.remoteAuthority = environmentService.remoteAuthority || undefined;
		this.remoteLabel = this.remoteAuthority ? paradisHostLabelFromAuthority(this.remoteAuthority) : undefined;
		this._remoteConnected = !!this.remoteAuthority;

		this.sftp = this._register(new ParadisSftpFileSystemProvider(sharedProcessService.getChannel(PARADIS_SFTP_CHANNEL)));
		this._register(fileService.registerProvider(PARADIS_SFTP_SCHEME, this.sftp));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_SFTP_IDLE_SETTING)) {
				this.configureSftp();
			}
		}));

		this.journal = this._register(new ParadisTransferTempJournal(storageService, fileService, logService));
		const fileSystem = new ParadisFileServiceTransferFileSystem(fileService, {
			lister: resource => this.listForTransfer(resource),
			metadata: this.createMetadata(),
			journal: this.journal,
		});
		this.queue = this._register(new ParadisTransferQueue({
			fileSystem,
			concurrency: 2,
			// このウィンドウの接続が切れて止まったのは、接続先（vscode-remote://）を読み書きする項目だけ
			isDisconnected: item => !!this.remoteAuthority && !this._remoteConnected && this.usesWindowConnection(item),
		}));

		const connection = remoteAgentService.getConnection();
		if (connection) {
			this._register(connection.onDidStateChange(event => {
				switch (event.type) {
					case PersistentConnectionEventType.ConnectionLost:
					case PersistentConnectionEventType.ReconnectionWait:
					case PersistentConnectionEventType.ReconnectionPermanentFailure:
						this.setRemoteConnected(false);
						break;
					case PersistentConnectionEventType.ConnectionGain:
						this.setRemoteConnected(true);
						// 繋がり直した先は別のサーバー（更新された REH）かもしれないので、権限のチャネルを聞き直す
						this.modesSupport.delete('remote');
						void this.cleanupTemps();
						// 切れて止まった転送は、繋がり直したら流し直す。書きかけは一時名なので送り先は無傷で、
						// その間に同名ができていたら（聞く相手がいないので）衝突として失敗にする
						this.queue.retryWhere(item => item.error?.kind === 'disconnected' && this.usesWindowConnection(item));
						break;
				}
			}));
		}

		// 前に閉じたウィンドウや切れた接続が残した一時ファイルを片付ける（起動直後の負荷を避けて少し待つ）
		const cleanup = this._register(new RunOnceScheduler(() => void this.cleanupTemps(), 10_000));
		cleanup.schedule();

		// 転送中にウィンドウを閉じる・再読み込みするときは確かめる（閉じると取り消しになる）
		this._register(lifecycleService.onBeforeShutdown(event => {
			const active = this.queue.getSummary().active;
			if (active > 0) {
				event.veto(this.confirmShutdown(active), 'paradis.fileTransfer.activeTransfers');
			}
		}));
	}

	private async confirmShutdown(active: number): Promise<boolean> {
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('paradis.fileTransfer.shutdown.message', "{0} 件の転送が進行中です。閉じますか?", active),
			detail: localize('paradis.fileTransfer.shutdown.detail', "閉じると転送は取り消されます。一時ファイルに書いている項目は、送り先の元のファイルがそのまま残ります。その場で書いている項目（所有者が違う・ハードリンクなどのファイル）は、書きかけになります。片付けきれなかった一時ファイルは、次に開いたときに片付けます。"),
			primaryButton: localize('paradis.fileTransfer.shutdown.close', "取り消して閉じる"),
		});
		if (!confirmed) {
			return true;
		}
		this.queue.cancelAll();
		// 取り消した実行が一時ファイルを片付け終わるのを、少しだけ待つ（衝突のダイアログを待っている項目は待たない）。
		// 時間切れなら控えに印を付け、次に開いたときにすぐ片付ける
		const finished = await Promise.race([
			this.queue.whenIdle({ ignoreAwaitingDecision: true }).then(() => true),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000)),
		]);
		if (!finished) {
			this.journal.abandonOwn();
		}
		return false;
	}

	private usesWindowConnection(item: IParadisTransferItem): boolean {
		return item.source.scheme === Schemas.vscodeRemote || item.target.scheme === Schemas.vscodeRemote;
	}

	private configureSftp(): void {
		this.sftp.configure(paradisSftpIdleMs(this.configurationService.getValue<number>(PARADIS_SFTP_IDLE_SETTING))).catch(() => undefined);
	}

	/**
	 * 心拍の途絶えた一時ファイルを片付ける。手元と、繋がっている接続先と、このウィンドウでユーザーが開いた
	 * 接続していないホストのものだけ（起動直後に勝手に SSH を張らない）。
	 */
	private async cleanupTemps(): Promise<void> {
		const removed = await this.journal.cleanup(uri => this.owns('local', uri) || (this.owns('remote', uri) && (paradisIsSftpResource(uri) || this._remoteConnected)));
		if (removed) {
			this.logService.info(`[ParadisFileTransfer] removed ${removed} leftover temporary file(s)`);
		}
	}

	/**
	 * 送り先の権限・所有者・リンク数を読み、一時ファイルの権限を合わせ、素の rename で置き換える口（権限のチャネル）。
	 * 版が足りないと確かに分かったときだけ `unsupported` を返し、一時的な失敗は投げる（その場で書くに倒さない）。
	 */
	private createMetadata(): IParadisTransferMetadata {
		return {
			fileInfo: async resource => {
				if (paradisIsSftpResource(resource)) {
					// SFTP（版 3）にはリンク数と inode が無い。リンク数は 1、同じファイルかの印は無しとして扱う
					const info = await this.sftp.statFile(resource);
					return info ? { kind: 'info', info: { mode: info.mode, ownedByMe: info.ownedByMe, linkCount: 1 } } : { kind: 'missing' };
				}
				const side = this.sideOf(resource);
				if (!side || await this.modesVersion(side) < PARADIS_FILE_MODES_STAT_VERSION) {
					return { kind: 'unsupported' };
				}
				const info = await this.modesChannel(side)?.call<IParadisFileStatInfo | undefined>('statFile', { resource: paradisToMachineFileUri(resource) });
				return info
					? { kind: 'info', info: { mode: info.mode, ownedByMe: info.ownedByMe, linkCount: info.linkCount, identity: info.identity } }
					: { kind: 'missing' };
			},
			chmod: async (resource, mode) => {
				if (paradisIsSftpResource(resource)) {
					await this.sftp.chmod(resource, mode, false);
					return;
				}
				const side = this.sideOf(resource);
				if (!side) {
					throw new Error(`no file modes channel for ${resource.scheme}`);
				}
				await this.chmod(side, resource, mode, false);
			},
			rename: async (from, to) => {
				if (paradisIsSftpResource(to)) {
					return this.sftp.posixRename(from, to);
				}
				const side = this.sideOf(to);
				if (!side || await this.modesVersion(side) < PARADIS_FILE_MODES_RENAME_VERSION) {
					return false;
				}
				await this.modesChannel(side)?.call<void>('rename', { from: paradisToMachineFileUri(from), to: paradisToMachineFileUri(to) });
				return true;
			},
		};
	}

	private sideOf(resource: URI): ParadisTransferSide | undefined {
		return this.owns('local', resource) ? 'local' : this.owns('remote', resource) ? 'remote' : undefined;
	}

	get remoteConnected(): boolean {
		return this._remoteConnected;
	}

	private setRemoteConnected(value: boolean): void {
		if (this._remoteConnected !== value) {
			this._remoteConnected = value;
			this._onDidChangeConnection.fire(value);
		}
	}

	sideLabel(side: ParadisTransferSide, resource?: URI): string {
		if (side === 'local') {
			return localize('paradis.fileTransfer.thisMachine', "このマシン");
		}
		if (resource && paradisIsSftpResource(resource)) {
			return resource.authority;
		}
		return this.remoteLabel ?? localize('paradis.fileTransfer.remote', "接続先");
	}

	owns(side: ParadisTransferSide, resource: URI): boolean {
		if (side === 'local') {
			return resource.scheme === Schemas.file;
		}
		// 接続していないホストは、このウィンドウでユーザーが開いたものだけ（タブの復元で勝手に繋がない）
		if (paradisIsSftpResource(resource)) {
			return this.sftp.isAllowed(resource.authority);
		}
		return !!this.remoteAuthority && resource.scheme === Schemas.vscodeRemote && resource.authority === this.remoteAuthority;
	}

	async defaultLocation(side: ParadisTransferSide, workspaceFolder: URI | undefined): Promise<URI | undefined> {
		if (workspaceFolder && this.owns(side, workspaceFolder)) {
			return workspaceFolder;
		}
		if (side === 'local') {
			// web では接続先が返ることがあるので file のときだけ使う（Para ホストのビューと同じ）
			const home = this.pathService.userHome({ preferLocal: true });
			return home.scheme === Schemas.file ? home : undefined;
		}
		if (!this.remoteAuthority) {
			return undefined;
		}
		const environment = await this.remoteAgentService.getEnvironment().catch(() => null);
		return environment?.userHome;
	}

	// --- 一覧と権限 --------------------------------------------------------------------------------

	private modesChannel(side: ParadisTransferSide): IChannel | undefined {
		if (side === 'local') {
			return this.sharedProcessService.getChannel(PARADIS_FILE_MODES_CHANNEL);
		}
		return this.remoteAgentService.getConnection()?.getChannel(PARADIS_FILE_MODES_CHANNEL);
	}

	async modesAvailable(side: ParadisTransferSide, resource?: URI): Promise<boolean> {
		if (resource && paradisIsSftpResource(resource)) {
			return true;
		}
		// 一覧と権限の表示は、一時的に聞けなければ権限なしで出す（次に読み直したときにもう一度聞く）
		return await this.modesVersion(side).catch(() => 0) >= PARADIS_FILE_MODES_MIN_VERSION;
	}

	/**
	 * 権限のチャネルの版。チャネルが無いと確かに分かったら（`Unknown channel`）0 を覚える。
	 * 時間切れ・切断などの一時的な失敗は覚えずに投げる（古い REH と取り違えない）。
	 */
	private modesVersion(side: ParadisTransferSide): Promise<number> {
		if (side === 'remote' && !this.remoteAuthority) {
			return Promise.resolve(0);
		}
		let support = this.modesSupport.get(side);
		if (!support) {
			const channel = this.modesChannel(side);
			support = channel
				? channel.call<number>('version').then(version => typeof version === 'number' ? version : 0, error => {
					this.logService.info(`[ParadisFileTransfer] file modes channel on ${side}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
					if (paradisIsUnknownChannelError(error)) {
						return 0;
					}
					// 切断中などの一時的な失敗は覚えない（次に聞いたときにもう一度聞く）
					this.modesSupport.delete(side);
					throw error;
				})
				: Promise.resolve(0);
			this.modesSupport.set(side, support);
		}
		return support;
	}

	async list(side: ParadisTransferSide, resource: URI): Promise<IParadisPaneListing> {
		if (paradisIsSftpResource(resource)) {
			const listing = await this.sftp.list(resource);
			return {
				entries: listing.entries.filter(entry => paradisIsSafeSftpEntryName(entry.name)).map(entry => this.toPaneEntry(resource, entry)),
				truncated: listing.truncated,
				modes: true,
			};
		}
		if (await this.modesAvailable(side)) {
			const channel = this.modesChannel(side);
			if (channel) {
				const listing = await channel.call<IParadisFileModeListing>('list', { resource: paradisToMachineFileUri(resource) });
				return {
					entries: listing.entries.map(entry => ({
						name: entry.name,
						resource: joinPath(resource, entry.name),
						kind: entry.kind === 'directory' ? 'directory' : entry.kind === 'symlink' ? 'symlink' : 'file',
						isDirectory: entry.isDirectory,
						size: entry.kind === 'directory' ? undefined : entry.size,
						mtime: entry.mtime,
						mode: entry.mode,
					})),
					truncated: listing.truncated,
					modes: true,
				};
			}
		}
		// 権限のチャネルが無い相手は IFileService で読む（子ごとに stat が飛ぶので SSH では少し重い）
		const stat = await this.fileService.resolve(resource, { resolveMetadata: true });
		return {
			entries: (stat.children ?? []).map(child => ({
				name: child.name,
				resource: child.resource,
				kind: child.isSymbolicLink ? 'symlink' : child.isDirectory ? 'directory' : 'file',
				isDirectory: child.isDirectory,
				size: child.isDirectory ? undefined : child.size,
				mtime: child.mtime,
				mode: undefined,
			})),
			truncated: false,
			modes: false,
		};
	}

	private toPaneEntry(directory: URI, entry: IParadisSftpEntry): IParadisPaneEntry {
		return {
			name: entry.name,
			resource: joinPath(directory, entry.name),
			kind: entry.kind === 'directory' ? 'directory' : entry.kind === 'symlink' ? 'symlink' : 'file',
			isDirectory: entry.isDirectory,
			size: entry.kind === 'directory' ? undefined : entry.size,
			mtime: entry.mtime,
			mode: entry.mode,
		};
	}

	async chmod(side: ParadisTransferSide, resource: URI, mode: number, recursive: boolean): Promise<void> {
		if (paradisIsSftpResource(resource)) {
			return this.sftp.chmod(resource, mode, recursive);
		}
		const channel = await this.modesAvailable(side) ? this.modesChannel(side) : undefined;
		if (!channel) {
			throw new Error(localize('paradis.fileTransfer.chmodUnavailable', "この接続先では権限を変更できません（Para Code のサーバーが古い可能性があります）"));
		}
		await channel.call<void>('chmod', { resource: paradisToMachineFileUri(resource), mode, recursive });
	}

	/** 待ち行列の下調べ用の一覧。権限のチャネルがあれば 1 往復で読む（無ければ undefined を返して IFileService に任せる）。 */
	private async listForTransfer(resource: URI): Promise<readonly IParadisTransferChild[] | undefined> {
		if (paradisIsSftpResource(resource)) {
			let listing: { entries: IParadisSftpEntry[] };
			try {
				listing = await this.sftp.list(resource);
			} catch (error) {
				if (error instanceof Error && toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
					return [];
				}
				throw error;
			}
			// 送り先の外を指しうる名前は、shared process でも捨てているが、ここでも写さない
			return listing.entries.filter(entry => paradisIsSafeSftpEntryName(entry.name)).map(entry => ({
				name: entry.name,
				resource: joinPath(resource, entry.name),
				isDirectory: entry.isDirectory,
				size: entry.size,
				mtime: entry.mtime,
				special: entry.kind === 'other',
				directoryLink: entry.kind === 'symlink' && entry.isDirectory,
				isSymbolicLink: entry.kind === 'symlink',
			}));
		}
		const side = this.sideOf(resource);
		const channel = side && await this.modesAvailable(side) ? this.modesChannel(side) : undefined;
		if (!channel) {
			return undefined;
		}
		let listing: IParadisFileModeListing;
		try {
			listing = await channel.call<IParadisFileModeListing>('list', { resource: paradisToMachineFileUri(resource) });
		} catch (error) {
			if (error instanceof Error && /\bENOENT\b/.test(error.message)) {
				return [];
			}
			throw error;
		}
		return listing.entries.map(entry => ({
			name: entry.name,
			resource: joinPath(resource, entry.name),
			isDirectory: entry.isDirectory,
			size: entry.size,
			mtime: entry.mtime,
			// ソケット・FIFO などは写さない
			special: entry.kind === 'other',
			directoryLink: entry.kind === 'symlink' && entry.isDirectory,
			isSymbolicLink: entry.kind === 'symlink',
		}));
	}

	// --- 転送 --------------------------------------------------------------------------------------

	retry(item: IParadisTransferItem): Promise<void> {
		const targetSide: ParadisTransferSide = item.direction === 'toRemote' ? 'remote' : 'local';
		return this.queue.retry(item.id, conflict => this.askConflict(conflict, targetSide));
	}

	transfer(sources: readonly IParadisTransferSource[], targetDirectory: URI, targetSide: ParadisTransferSide): Promise<number> {
		return this.queue.enqueue({
			sources,
			targetDirectory,
			targetLabel: this.sideLabel(targetSide, targetDirectory),
			direction: targetSide === 'remote' ? 'toRemote' : 'toLocal',
		}, conflict => this.askConflict(conflict, targetSide));
	}

	private async askConflict(conflict: IParadisTransferConflict, targetSide: ParadisTransferSide): Promise<IParadisConflictDecision> {
		const row = (label: string, stat: IParadisTransferStat, newer: boolean) => {
			const date = stat.mtime !== undefined ? paradisFormatDate(stat.mtime) : '-';
			const size = stat.isDirectory ? localize('paradis.fileTransfer.conflict.folder', "フォルダー") : paradisFormatSize(stat.size);
			const dateCell = newer ? localize('paradis.fileTransfer.conflict.newer', "{0}（新しい）", date) : date;
			return `| ${escapeMarkdownSyntaxTokens(label)} | ${escapeMarkdownSyntaxTokens(conflict.name)} | ${escapeMarkdownSyntaxTokens(dateCell)} | ${escapeMarkdownSyntaxTokens(size)} |`;
		};
		const sourceNewer = (conflict.sourceStat.mtime ?? 0) > (conflict.targetStat.mtime ?? 0);
		const table = [
			`| | ${localize('paradis.fileTransfer.conflict.name', "名前")} | ${localize('paradis.fileTransfer.conflict.mtime', "更新日時")} | ${localize('paradis.fileTransfer.conflict.size', "サイズ")} |`,
			'|---|---|---|---|',
			row(localize('paradis.fileTransfer.conflict.sending', "送る方"), conflict.sourceStat, sourceNewer),
			row(localize('paradis.fileTransfer.conflict.existing', "今ある方"), conflict.targetStat, !sourceNewer && conflict.targetStat.mtime !== conflict.sourceStat.mtime),
		].join('\n');
		const remaining = conflict.total - conflict.index;
		const replacedKind = conflict.targetStat.isSymbolicLink
			? localize('paradis.fileTransfer.conflict.kindLink', "リンク")
			: conflict.targetStat.isDirectory
				? localize('paradis.fileTransfer.conflict.kindFolder', "フォルダー")
				: localize('paradis.fileTransfer.conflict.kindFile', "ファイル");
		// 種類の違う同名は、置き換えると送り先がフォルダーごと消えるので、文言を変えて毎回確かめる
		const detail = conflict.kindMismatch
			? localize('paradis.fileTransfer.conflict.kindDetail', "送り先: {0}\n送り先の {1} を丸ごと取り除いてから置き換えます。{2}", dirname(conflict.target).path, replacedKind,
				targetSide === 'local'
					? localize('paradis.fileTransfer.conflict.kindTrash', "取り除いた方はゴミ箱に入ります。")
					: localize('paradis.fileTransfer.conflict.kindNoTrash', "接続先にはゴミ箱が無いため、取り除いた方は元に戻せません。"))
			: localize('paradis.fileTransfer.conflict.detail', "送り先: {0}\n上書きすると今ある方は元に戻せません。フォルダーどうしは中身を合わせ、送った項目だけを置き換えます。", dirname(conflict.target).path);
		const { result, checkboxChecked } = await this.dialogService.prompt<ParadisConflictAction | 'cancel'>({
			type: Severity.Warning,
			message: conflict.kindMismatch
				? localize('paradis.fileTransfer.conflict.kindMessage', "{0} に同じ名前の{1}があります。{1}ごと置き換えますか?（{2} 件中 {3} 件目）", this.sideLabel(targetSide, conflict.target), replacedKind, conflict.total, conflict.index)
				: localize('paradis.fileTransfer.conflict.message', "{0} に同じ名前の項目があります（{1} 件中 {2} 件目）", this.sideLabel(targetSide, conflict.target), conflict.total, conflict.index),
			detail,
			buttons: [
				{
					label: conflict.kindMismatch
						? localize('paradis.fileTransfer.conflict.replaceKind', "{0}ごと置き換える", replacedKind)
						: localize('paradis.fileTransfer.conflict.overwrite', "上書きする"),
					run: () => 'overwrite' as const,
				},
				{ label: localize('paradis.fileTransfer.conflict.rename', "名前を変えて保存（{0}）", conflict.renamedName), run: () => 'rename' as const },
				{ label: localize('paradis.fileTransfer.conflict.skip', "飛ばす"), run: () => 'skip' as const },
			],
			cancelButton: { label: localize('paradis.fileTransfer.conflict.cancelAll', "すべて取り消し"), run: () => 'cancel' as const },
			checkbox: remaining > 0 && conflict.allowApplyToAll ? { label: localize('paradis.fileTransfer.conflict.applyToAll', "以後すべてに適用（残り {0} 件）", remaining), checked: false } : undefined,
			custom: { markdownDetails: [{ markdown: new MarkdownString(table) }] },
		});
		return { action: result ?? 'cancel', applyToAll: conflict.allowApplyToAll && !!checkboxChecked };
	}

	// --- 接続していないホスト ---------------------------------------------------------------------------

	async listConfiguredHosts(): Promise<readonly string[]> {
		return await paradisRemoteHostBrowser()?.listConfiguredHosts() ?? [];
	}

	async connectAndOpen(alias: string): Promise<void> {
		if (!paradisIsSafeSshHost(alias)) {
			throw new Error(localize('paradis.fileTransfer.unsupportedHost', "このホスト名では接続できません: {0}", alias));
		}
		const authority = `ssh-remote+${alias.trim()}`;
		this.storageService.store(PARADIS_FILE_TRANSFER_PENDING_OPEN_KEY, JSON.stringify({ authority, at: Date.now() }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		await this.hostService.openWindow({ remoteAuthority: authority });
	}

	async openHost(alias: string): Promise<URI> {
		const trimmed = alias.trim();
		if (!paradisIsSafeSshHost(trimmed)) {
			throw new Error(localize('paradis.fileTransfer.unsupportedHost', "このホスト名では接続できません: {0}", alias));
		}
		if (paradisDirectTargetFor(trimmed, this.remoteAuthority) === 'window') {
			// このウィンドウが繋いでいるホストは、今の接続を使う（接続を増やさない）
			const home = await this.defaultLocation('remote', undefined);
			if (!home) {
				throw new Error(localize('paradis.fileTransfer.noRemoteHome', "接続先のホームを読めませんでした"));
			}
			return home;
		}
		// 直接の接続は小文字の別名で扱う（URI の authority が小文字になるため。OpenSSH も小文字にしてから照らす）
		const host = trimmed.toLowerCase();
		const wasAllowed = this.sftp.isAllowed(host);
		this.sftp.allowHost(host);
		this.configureSftp();
		const result = await this.sftp.openHost(host);
		const error = paradisSftpOpenError(trimmed, result);
		if (error || !result.ok) {
			if (!wasAllowed) {
				this.sftp.revokeHost(host);
			}
			throw error ?? new Error(trimmed);
		}
		// 前にこのホストへ送っていて残った書きかけを片付ける
		void this.cleanupTemps();
		return paradisSftpUri(host, result.home);
	}
}

/** 待ち行列に積む送り元を、一覧の行から作る。 */
export function paradisTransferSourceFor(entry: IParadisPaneEntry): IParadisTransferSource {
	// 選んだのがフォルダーを指すリンクなら、リンク先の中身をフォルダーとして写す（中のリンクは辿らない）
	return { resource: entry.resource, name: basename(entry.resource) || entry.name, isDirectory: entry.isDirectory, size: entry.size, mtime: entry.mtime };
}

registerSingleton(IParadisFileTransferService, ParadisFileTransferService, InstantiationType.Delayed);
