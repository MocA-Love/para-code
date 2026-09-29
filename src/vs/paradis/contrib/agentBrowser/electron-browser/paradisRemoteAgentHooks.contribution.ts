/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Sequencer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { paradisWriteRollingBackupUri } from '../../../common/paradisRollingFileBackupUri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { PARADIS_AGENT_HOOKS_ENABLED_SETTING, PARADIS_NOTIFY_HOOK_RELATIVE_PATH, paradisAgentHooksEnabled } from '../common/paradisAgentHooks.js';
import { paradisUpsertClaudeMcpJson, paradisUpsertCodexMcpToml } from '../common/paradisMcpSetupEncoding.js';
import { PARADIS_REMOTE_AGENT_TUNNEL_SETTING } from './paradisRemoteAgentTunnel.contribution.js';
import { paradisRemoteUserHome } from '../common/paradisRemoteUserHome.js';

/**
 * 既存設定を保ったまま接続先Claude用para-browser MCPをマージする。
 * 手元のClaudeへ書くものと同一なので、組み立ては共通のencoderに任せる。
 */
export function paradisMergeRemoteClaudeMcpJson(existingRaw: string | undefined, port: number): string | undefined {
	return paradisUpsertClaudeMcpJson(existingRaw, port);
}

/** 接続先への hook 導入を再試行し、ゲートウェイ番号の変化に追従する。 */
export class ParadisRemoteAgentHooksController extends Disposable {

	/** 接続先へ書き込んだゲートウェイの番号。変わったら書き直す目印。 */
	private installedPort: number | undefined;
	private isPolling = false;
	/** 最初の導入（4段階の再試行）が決着したか。決着まで外からの知らせは受け取らない。 */
	private hasSettledInitialInstall = false;

	constructor(
		private readonly install: () => Promise<number | undefined>,
		private readonly readEndpoint: () => Promise<number | undefined>,
		private readonly delay: (delayMs: number) => Promise<void>,
		private readonly interval: (callback: () => Promise<void>, intervalMs: number) => IDisposable,
		private readonly logService: Pick<ILogService, 'info' | 'warn'>,
		/**
		 * 番号が変わったことを向こうから知らせてくる経路。
		 *
		 * 番号は戻りトンネルが張り直されるたびに変わる。定期の見直しだけに任せると、気付くまでの
		 * 間、接続先の通知スクリプトは死んだ番号へ投げ続ける。再送は無いので、承認待ちや完了の
		 * ような一度きりの知らせはそのまま消える。無くても見直しで追いつくので任意。
		 */
		onDidChangePort?: Event<number | undefined>,
	) {
		super();
		if (onDidChangePort !== undefined) {
			this._register(onDidChangePort(port => void this.onPortAnnounced(port)));
		}
		void this.installWithRetry();
	}

	/** 接続先が使えるまで既定の4段階で hook 導入を再試行する。 */
	private async installWithRetry(): Promise<void> {
		const delaysMs = [0, 2000, 5000, 15000];
		for (let attempt = 0; attempt < delaysMs.length; attempt++) {
			if (this._store.isDisposed) {
				return;
			}
			if (delaysMs[attempt] > 0) {
				await this.delay(delaysMs[attempt]);
			}
			if (this._store.isDisposed) {
				return;
			}
			const installedPort = await this.install();
			if (installedPort !== undefined) {
				if (this._store.isDisposed) {
					return;
				}
				this.installedPort = installedPort;
				this.startWatching();
				return;
			}
		}
		// 4段階とも張れなかった。ここで諦めきらず、後段のポーリングへ引き継ぐ。トンネル側は
		// クールダウン明けに自分から追い直すので、いずれ番号が付けばここで拾える
		this.logService.warn('[paradis] could not install the agent hooks after the initial retries; will keep checking');
		this.startWatching();
	}

	/**
	 * 最初の導入が決着したので、以後の見直しを受け付ける。
	 *
	 * ここより前は `installWithRetry` が唯一の導入者で、その待ち時間中に番号の知らせが来ても
	 * 受け取らない（受け取ると `install()` が二重に走る）。知らせを取りこぼしても、`installWithRetry`
	 * 自身が毎回その時点の番号を読みに行くので同じ結果に落ち着く。
	 */
	private startWatching(): void {
		this.hasSettledInitialInstall = true;
		this.watchForPortChanges();
	}

	/** 接続先側の番号が変わった（初めて張れた場合を含む）ときだけ hook 一式を再導入する。 */
	private watchForPortChanges(): void {
		this._register(this.interval(async () => {
			if (this._store.isDisposed || this.isPolling) {
				return;
			}
			this.isPolling = true;
			try {
				await this.reinstallIfChanged(await this.readEndpoint());
			} catch {
				// 取れないときは次の周期で試す
			} finally {
				this.isPolling = false;
			}
		}, 30_000));
	}

	/** 向こうから番号の変化を知らされたとき。定期の見直しと同じ道を、同じく1本だけ通す。 */
	private async onPortAnnounced(port: number | undefined): Promise<void> {
		if (this._store.isDisposed || !this.hasSettledInitialInstall || this.isPolling) {
			// 最初の導入の最中、または今まさに書き直している最中。取りこぼしても
			// 導入側／直後の見直しが同じ番号を読み直すので拾える
			return;
		}
		this.isPolling = true;
		try {
			await this.reinstallIfChanged(port);
		} catch {
			// 書けなかったときは次の周期で試す
		} finally {
			this.isPolling = false;
		}
	}

	/**
	 * 知らされた番号が今書いてあるものと違えば、hook 一式を書き直す。
	 *
	 * 呼び口は「向こうからの知らせ」と「定期の見直し」の2つ。どちらから来ても同じ判断をさせ、
	 * 走るのは常に1本だけにする（古い導入が新しい番号を上書きしないため）。
	 */
	private async reinstallIfChanged(port: number | undefined): Promise<void> {
		// port が undefined はまだ張れていないだけ。installedPort も undefined ならこれまでと
		// 変わっていないので、install() を空振りさせない
		if (this._store.isDisposed || port === undefined || port === this.installedPort) {
			return;
		}
		this.logService.info(`[paradis] host port changed (${this.installedPort} -> ${port}); updating the host`);
		const installedPort = await this.install();
		if (!this._store.isDisposed && installedPort !== undefined) {
			this.installedPort = installedPort;
		}
	}
}

/** {@link ParadisRemoteAgentHookFiles} が接続先とやり取りするための口。 */
export interface IParadisRemoteAgentHookFilesHost {
	readonly fileService: Pick<IFileService, 'exists' | 'readFile' | 'writeFile' | 'copy' | 'realpath' | 'stat'>;
	readonly logService: Pick<ILogService, 'info' | 'warn'>;
	/** 接続先の名前（ログ用）。 */
	readonly remoteAuthority: string | undefined;
	/** 接続先のホーム。まだ接続先を指していなければ undefined。 */
	resolveHome(): Promise<URI | undefined>;
	/** hook を差し込んだ中身を返す（判断は shared process 側）。 */
	buildHooksJson(cli: 'claude' | 'codex', current: string | undefined): Promise<string | undefined>;
	/** Para Code が置いた hook だけを外した中身を返す（判断は shared process 側）。 */
	buildRemovalJson(current: string): Promise<string | undefined>;
}

/**
 * 接続先の hook 設定ファイル（Claude の settings.json / Codex の hooks.json）の読み書きを受け持つ。
 *
 * 設置（ポートが変わるたびの書き直し）と、自動設置の設定の切り替え（オンで置く・オフで外す）は、
 * どちらも同じファイルを読んで書き戻す。並んで走ると、取り外しの直後に設置側が古い判断で
 * hook を書き戻したり、片方の書き込みをもう片方が上書きしたりする。ここを通るものは
 * {@link runExclusive} で1本ずつ流す。
 */
export class ParadisRemoteAgentHookFiles {

	private readonly sequencer = new Sequencer();

	/**
	 * 設定の切り替えのうち、まだ接続先へ反映できていないもの。
	 *
	 * 切り替えた時点で接続先のホームが分からない（繋がった直後など）と、その場では何もできない。
	 * 捨てると「オフにしたのに接続先に hook が残る」ので、覚えておいて次の周回（30秒ごとの
	 * 見直し、または次の設置）で反映する。
	 */
	private pending: 'install' | 'remove' | undefined;

	/** 反映に続けて失敗した回数。30秒ごとの見直しで同じ警告を出し続けないよう、1, 2, 4, 8… 回目だけ出す。 */
	private consecutiveFailures = 0;

	constructor(
		private readonly host: IParadisRemoteAgentHookFilesHost,
		/** hook の自動設置が有効か。オフに切り替わった瞬間だけ、接続先からも取り外すために覚えておく。 */
		private enabled: boolean,
	) { }

	/** 反映待ちの切り替えがあるか（テスト・ログ用）。 */
	get pendingChange(): 'install' | 'remove' | undefined {
		return this.pending;
	}

	/** 接続先の hook 設定ファイルを触る処理を、他と重ならないように流す。 */
	runExclusive<T>(task: () => Promise<T>): Promise<T> {
		return this.sequencer.queue(task);
	}

	/** 自動設置の設定が切り替わった。値は今すぐ変え、接続先への反映は順番待ちに入れる。 */
	setEnabled(enabled: boolean): Promise<void> {
		if (enabled === this.enabled) {
			return Promise.resolve();
		}
		// 走っている最中の設置も、次のファイルへ進む前・書く前にこれを見直す
		this.enabled = enabled;
		this.pending = enabled ? 'install' : 'remove';
		return this.runExclusive(() => this.applyPending());
	}

	/** ホームが分からず保留していた切り替えがあれば、もう一度反映を試みる。 */
	async retryPending(): Promise<void> {
		if (this.pending !== undefined) {
			await this.runExclusive(() => this.applyPending());
		}
	}

	private async applyPending(): Promise<void> {
		const change = this.pending;
		if (change === undefined) {
			return;
		}
		try {
			const home = await this.host.resolveHome();
			if (home === undefined) {
				return; // 保留したまま。次の周回で試し直す
			}
			if (await this.sync(home)) {
				this.consecutiveFailures = 0;
				this.host.logService.info(`[paradis] ${change === 'install' ? 'installed' : 'removed'} the agent hooks on ${this.host.remoteAuthority} after the setting changed`);
			} else {
				this.reportFailure(undefined);
			}
		} catch (error) {
			this.reportFailure(error);
		}
	}

	private reportFailure(error: unknown): void {
		this.consecutiveFailures++;
		// 2 のべき乗の回だけ出す（1, 2, 4, 8… 回目）。恒常的に失敗していても、ログは対数でしか増えない
		if ((this.consecutiveFailures & (this.consecutiveFailures - 1)) === 0) {
			this.host.logService.warn(`[paradis] could not apply the agent hook setting on the host (failed ${this.consecutiveFailures} time(s) in a row; will retry)`, error);
		}
	}

	/**
	 * 接続先の hook を今の設定に合わせる。{@link runExclusive} の中から呼ぶこと。
	 *
	 * オンなら置き、オフで取り外しが保留されていれば外す。オフのまま起動しただけなら触らない
	 * （手で入れた接続先の hook を、繋いだだけで消さない）。1ファイルごとに設定を見直すので、
	 * 途中で切り替わっても古い判断のまま書き進めない。すべて済んだときだけ保留を消す。
	 *
	 * @returns すべてのファイルに反映できたか。読めない・書き換えが続いたファイルがあれば false で、
	 *   そのときは保留を残して次の周回で試し直す。
	 */
	async sync(home: URI): Promise<boolean> {
		const change = this.pending;
		const files: readonly [URI, 'claude' | 'codex'][] = [
			[joinPath(home, '.claude', 'settings.json'), 'claude'],
			[joinPath(home, '.codex', 'hooks.json'), 'codex'],
		];
		let applied = true;
		for (const [file, cli] of files) {
			if (this.enabled) {
				applied = await this.mergeJson(
					file,
					async current => this.enabled
						? this.host.buildHooksJson(cli, current)
						// 組み立てる前にオフへ切り替わった。置かずに、後に続く取り外しに任せる
						: current,
					// 組み立てた後、書く直前にもう一度見る（問い合わせの間に切り替わることがある）
					() => this.enabled,
				) && applied;
			} else if (this.pending === 'remove') {
				applied = await this.mergeJson(file, async current => current === undefined ? undefined : this.host.buildRemovalJson(current)) && applied;
			}
		}
		if (applied && this.pending === change) {
			this.pending = undefined;
		}
		return applied;
	}

	/**
	 * ファイルを読んで書き戻す。読めない・壊れている場合は**何もしない**
	 * （ユーザーの設定を壊すくらいなら、実行状態が出ない方がまし）。
	 *
	 * 中身を組み立てている間（shared process への問い合わせを挟む）に、エージェントや別の
	 * Para Code が同じファイルを書き換えることがある。そのまま書くと向こうの変更を消すので、
	 * 書く直前に読み直し、変わっていたら読み直した中身から組み立て直す。
	 *
	 * 書き込みは一時ファイルを経由しない。接続先のファイルは IFileService 越しにしか触れず、
	 * そこでの原子的な書き込みは元の mode（`~/.claude.json` の 0600 など）を引き継げない
	 * （一時ファイルは umask の既定で作られ、それが元の名前に置き換わる）。symlink にも使えない。
	 *
	 * @param stillWanted 書く直前に呼ぶ。false なら書かずに終える（済んだものとして true を返す。
	 *   その後の扱いは呼び出し側の保留が決める）。
	 * @returns 反映できた（書いた・書く必要が無かった）か。読めない、または3回とも組み立てている間に
	 *   書き換えられたときは false。
	 */
	async mergeJson(file: URI, update: (current: string | undefined) => string | undefined | Promise<string | undefined>, stillWanted?: () => boolean): Promise<boolean> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const read = await this.readTextIfPossible(file);
			if (read === undefined) {
				return false;
			}
			const updated = await update(read.text);
			if (updated === undefined || updated === read.text) {
				return true;
			}
			const latest = await this.readTextIfPossible(file);
			if (latest === undefined) {
				return false;
			}
			if (latest.text !== read.text) {
				continue; // 組み立てている間に書き換えられた。読み直した中身からやり直す
			}
			if (stillWanted && !stillWanted()) {
				return true;
			}
			// 接続先の利用者の設定なので、書き換える前の中身を1つだけ隣へ控える（写せなくても止めない）
			if (read.text !== undefined) {
				await paradisWriteRollingBackupUri(this.host.fileService, file, error => this.host.logService.warn(`[ParadisRemoteAgentHooks] could not back up ${file.path}: ${error}`), { keepOriginal: true });
			}
			await this.host.fileService.writeFile(file, VSBuffer.fromString(updated));
			return true;
		}
		return false;
	}

	/** @returns 無ければ `{ text: undefined }`、読めなければ undefined */
	private async readTextIfPossible(file: URI): Promise<{ readonly text: string | undefined } | undefined> {
		if (!await this.host.fileService.exists(file)) {
			return { text: undefined };
		}
		try {
			const content = await this.host.fileService.readFile(file);
			return { text: content.value.toString() };
		} catch {
			return undefined;
		}
	}
}

/**
 * SSH で繋いだ先にも、エージェントの通知 hook 一式を置く。
 *
 * hook の仕組みそのものは shared process 側（paradisAgentHooksSetup.ts）にあるが、あちらは
 * homedir() で動くので常に手元にしか置かれない。接続先で動くエージェントには何も無く、
 * 実行状態のドットもモバイルのチャットミラーも動かないままになる。
 *
 * 置くのは3つ:
 *  - notify スクリプト（手元と同じもの。shared process から本文をもらう）
 *  - ポートファイル（スクリプトが通知先の番号を読むところ。接続先の sshd が割り当てた
 *    動的な番号で、手元のゲートウェイの番号とは一致しない）
 *  - Claude / Codex の設定への hook 定義（既にあるものは触らない）
 *
 * 通知は接続先の 127.0.0.1 へ飛ぶ。それが手元まで戻ってくる経路（戻りトンネル）を実際に
 * 張るのは shared process 側（paradisRemoteAgentTunnel.ts）で、ここは `ensureRemoteAgentTunnel`
 * を呼んで「今回張れた番号」をもらい、接続先の各設定ファイルへ焼き込むだけ。
 */
class ParadisRemoteAgentHooks extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.remoteAgentHooks';

	/** 接続先のホームが取れない旨のログを、30秒ごとの見直しで出し続けないための目印。 */
	private hasWarnedAboutUnresolvedHome = false;

	/** 直前にこのウィンドウがポートファイルへ書いた番号。他人の番号を上書きしたか見分けるのに使う。 */
	private lastWrittenPort: number | undefined;

	/** 上書きの警告を、30秒ごとの見直しで出し続けないための目印。 */
	private hasWarnedAboutForeignPortFile = false;

	private readonly hookFiles: ParadisRemoteAgentHookFiles;

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
	) {
		super();
		const channel = this.sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL);
		this.hookFiles = new ParadisRemoteAgentHookFiles({
			fileService: this.fileService,
			logService: this.logService,
			remoteAuthority: this.environmentService.remoteAuthority,
			resolveHome: () => this.remoteUserHome(),
			buildHooksJson: (cli, current) => channel.call<string | undefined>('buildRemoteAgentHooksJson', [this.environmentService.remoteAuthority, cli, current]),
			buildRemovalJson: current => channel.call<string | undefined>('buildRemoteAgentHooksRemovalJson', [current]),
		}, paradisAgentHooksEnabled(this.configurationService.getValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING)));

		// SSH の接続先だけを対象にする。他の種類の接続先（WSL・コンテナ）は ssh を通らないので、
		// 置いたものへ実行権も付けられず、ソケットも引けない。戻りトンネルが設定で切られている
		// ときは、置いても宛先ポートが取れず動かない設定を接続先に残すだけなので置かない
		if (
			this.environmentService.remoteAuthority?.startsWith('ssh-remote+') === true
			&& this.configurationService.getValue<boolean>(PARADIS_REMOTE_AGENT_TUNNEL_SETTING)
		) {
			// hook の自動設置の切り替えに合わせる。オフにした瞬間だけ接続先からも取り外し、
			// オンに戻したらすぐ置き直す（次の見直しを待たない）
			this._register(this.configurationService.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(PARADIS_AGENT_HOOKS_ENABLED_SETTING)) {
					void this.hookFiles.setEnabled(paradisAgentHooksEnabled(this.configurationService.getValue(PARADIS_AGENT_HOOKS_ENABLED_SETTING)));
				}
			}));
			// ペインが増減するたび、接続先の Codex ソケットの引き込みを合わせ直す
			this._register(this.paneTokenService.onDidChange(() => {
				void this.remoteUserHome().then(home => {
					if (home !== undefined) {
						this.syncCodexSockets(home, channel);
					}
				}, () => undefined);
			}));
			this._register({
				dispose: () => {
					channel.call('releaseRemoteCodexSockets', [this.environmentService.remoteAuthority])
						.catch(() => undefined);
				}
			});
			this._register(new ParadisRemoteAgentHooksController(
				() => this.hookFiles.runExclusive(() => this.install(channel)),
				async () => {
					// 30秒ごとの見直しのついでに、ホームが分からず保留していた切り替えを反映し直す
					await this.hookFiles.retryPending();
					return channel.call<number | undefined>('ensureRemoteAgentTunnel', [this.environmentService.remoteAuthority]);
				},
				delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
				(callback, intervalMs) => disposableWindowInterval(mainWindow, callback, intervalMs),
				this.logService,
				channel.listen<number | undefined>('remoteAgentTunnelPort', [this.environmentService.remoteAuthority]),
			));
		}
	}

	/**
	 * 接続先のホーム。まだ接続先の環境が解決できていないときは undefined（判定は共通ヘルパ）。
	 *
	 * ここで返すものはそのまま書き込み先になるので、手元のホームが返っている間に進めると、
	 * 接続先向けの設定（戻りトンネルの番号など）を手元の設定ファイルへ焼き込んでしまう。
	 */
	private async remoteUserHome(): Promise<URI | undefined> {
		const home = paradisRemoteUserHome(this.environmentService.remoteAuthority, await this.pathService.userHome());
		if (home === undefined) {
			if (!this.hasWarnedAboutUnresolvedHome) {
				this.hasWarnedAboutUnresolvedHome = true;
				this.logService.warn('[paradis] the host home is not resolved yet; not installing the agent hooks (will retry)');
			}
			return undefined;
		}
		this.hasWarnedAboutUnresolvedHome = false;
		return home;
	}

	/** @returns 置けた接続先側の番号。まだ整っていないだけなら undefined（呼び出し側が試し直す） */
	private async install(channel: IChannel): Promise<number | undefined> {
		try {
			// ここから下は全て接続先のパスになる。手元のホームが返ってきている間は何もしない
			const home = await this.remoteUserHome();
			if (home === undefined) {
				return undefined;
			}
			// スクリプトはこの場所を見て通知先の番号を読む。env は手元のパスのまま届いてしまうので、
			// 場所をスクリプトへ焼き込んでもらう
			const portFile = joinPath(home, '.para-code', 'paradis-browser-mcp.json');
			const [script, remotePort] = await Promise.all([
				// 接続先を渡すと、置くスクリプトに「接続先から届いた hook」の印が焼き込まれる。
				// 受け手はこの印だけで会話の記録がどちらのディスクにあるかを決める
				channel.call<string>('getNotifyScriptContent', [portFile.path, this.environmentService.remoteAuthority]),
				channel.call<number | undefined>('ensureRemoteAgentTunnel', [this.environmentService.remoteAuthority]),
			]);
			if (remotePort === undefined) {
				// 戻りトンネルがまだ張れていない（張っている最中／今回は失敗）。番号が無いものを
				// 書いても仕方ないので、次のリトライに任せる
				return undefined;
			}

			const scriptFile = joinPath(home, PARADIS_NOTIFY_HOOK_RELATIVE_PATH);
			await this.fileService.writeFile(scriptFile, VSBuffer.fromString(script));
			// 実行権が要る。IFileService には chmod が無いので、shared process 側へ頼む
			await channel.call('markRemoteHookExecutable', [this.environmentService.remoteAuthority, scriptFile.path]);

			// 戻りトンネルが接続先で実際に受け取った番号を書いておく。固定番号ではないので、
			// 同じホストへ他ユーザーが同時に SSH していても衝突しない
			await this.warnIfPortFileBelongsToAnotherSource(portFile, remotePort);
			await this.fileService.writeFile(portFile, VSBuffer.fromString(JSON.stringify({ protocolVersion: 1, port: remotePort })));
			this.lastWrittenPort = remotePort;

			await this.installCodexLauncher(home, channel);

			// 自動設置をオフにしている間は hook だけ置かない（MCP と戻り経路は hook と関係なく使う）。
			// 保留中の取り外しがあればここで済ませる
			if (!await this.hookFiles.sync(home)) {
				// 読めない・書き換えが続いた。MCP と戻り経路は使えるので設置自体は続ける
				this.logService.warn('[paradis] could not update the agent hook settings on the host; leaving them as they are');
			}
			await this.mergeClaudeMcp(home, remotePort);
			await this.mergeCodexMcp(home, remotePort);
			this.syncCodexSockets(home, channel);
			this.logService.info(`[paradis] installed the agent hooks on ${this.environmentService.remoteAuthority} (port ${remotePort})`);
			return remotePort;
		} catch (error) {
			// 置けなくても接続そのものは使える。実行状態が出ないだけ
			this.logService.warn('[paradis] could not install the agent hooks on the host (will retry)', error);
			return undefined;
		}
	}

	/**
	 * 接続先のポートファイルが、別の接続元のものらしければ警告する。
	 *
	 * このファイルは接続先のホーム直下の決め打ちの場所で、接続元を区別しない。同じ接続先へ
	 * 2台のPCから繋ぐと後から書いた側が勝ち、先客の通知はこちらのゲートウェイへ飛んでくる
	 * （トークンを知らないので捨てられ、先客側では実行状態が黙って止まる）。
	 *
	 * 分けるには接続先で動く通知スクリプト側にも「自分はどの接続元のものか」を選ばせる必要があり、
	 * ここだけでは直せない。せめて起きていることが分かるようにログへ残す。
	 */
	private async warnIfPortFileBelongsToAnotherSource(portFile: URI, port: number): Promise<void> {
		if (this.hasWarnedAboutForeignPortFile) {
			return;
		}
		try {
			if (!await this.fileService.exists(portFile)) {
				return;
			}
			const content = await this.fileService.readFile(portFile);
			const existingPort: unknown = JSON.parse(content.value.toString())?.port;
			// 自分が前に書いた番号ならこれまでどおり。どちらでもない番号は他の接続元のもの
			if (typeof existingPort !== 'number' || existingPort === port || existingPort === this.lastWrittenPort) {
				return;
			}
			this.hasWarnedAboutForeignPortFile = true;
			this.logService.warn(`[paradis] the host already points its agent hooks at port ${existingPort}; another Para Code may be connected to this host and will stop receiving them`);
		} catch {
			// 読めない・壊れている場合は判定しない。そのまま書き直す
		}
	}

	/**
	 * Codex のペイン専用ランチャーを接続先へ置く。
	 *
	 * Codex の承認カードやモデル一覧は、TUI の画面ではなく app-server との構造化されたやり取りで
	 * 取っている。それを立てるのがこのランチャーで、PATH の先頭に置かれて `codex` の代わりに
	 * 呼ばれる。手元のものは Para Code の中にあり接続先からは見えないので、同じものを置く。
	 *
	 * 中身は素の sh スクリプトで、何か揃わなければ本物の codex をそのまま実行する作りになって
	 * いる。置くこと自体が Codex を壊す方向には働かない。
	 */
	private async installCodexLauncher(home: URI, channel: IChannel): Promise<void> {
		const appRoot = (this.environmentService as IWorkbenchEnvironmentService & { readonly appRoot?: string }).appRoot;
		if (typeof appRoot !== 'string' || appRoot.length === 0) {
			return;
		}
		// 手元のファイルを読む。接続中のウィンドウでも `file:` はこの機械を指す
		const source = URI.file(`${appRoot}/resources/paradis/bin/codex`);
		const content = await this.fileService.readFile(source).catch(() => undefined);
		if (content === undefined) {
			this.logService.warn('[paradis] could not read the Codex launcher to copy to the host');
			return;
		}
		const target = joinPath(home, '.para-code', 'bin', 'codex');
		const existing = await this.fileService.readFile(target).catch(() => undefined);
		if (existing !== undefined && existing.value.toString() === content.value.toString()) {
			return; // 既に同じもの。30秒ごとの見直しで毎回コピーし直さない
		}
		// 走っている Codex のシェルは、このファイルを開いたまま最後まで読み進める。上書きすると
		// 途中から別の中身を読んで死ぬので、別名で書いてから置き換える（開いている側は古い実体を
		// 見続ける）
		const staging = joinPath(home, '.para-code', 'bin', `codex.${generateUuid()}`);
		await this.fileService.writeFile(staging, content.value);
		await channel.call('markRemoteHookExecutable', [this.environmentService.remoteAuthority, staging.path]);
		await this.fileService.move(staging, target, true);
	}

	/**
	 * 接続先の Codex ペインのソケットを、手元の同じ場所へ引いてくるよう頼む。
	 *
	 * ペインは開いたり閉じたりするので、その都度いまある一覧を渡して同期させる。手元のソケットの
	 * 場所は shared process が決める（ウィンドウの言い値でソケットを作らせない）。
	 */
	private syncCodexSockets(home: URI, channel: IChannel): void {
		// 立てない設定なら宛先も要らない。空で送ると、既に張ってある転送はそこで畳まれる
		const tokens = this.paneTokenService.isCodexPaneAppServerEnabled()
			? this.paneTokenService.listPaneTokens().map(pane => pane.token)
			: [];
		channel.call('syncRemoteCodexSockets', [this.environmentService.remoteAuthority, joinPath(home, '.para-code').path, tokens])
			.catch(error => this.logService.trace('[paradis] could not sync the Codex sockets with the host', error));
	}

	/**
	 * 接続先の Claude Code へ para-browser MCP を登録する。
	 *
	 * MCP サーバーの実体は手元の shared process にあり、素の HTTP で話せる。接続先からは
	 * 戻り経路（paradisRemoteAgentTunnel）が接続先で受け取った番号（`port` 引数）へ届くので、
	 * そこを URL に書けばよい。シムを接続先へ置く必要はない（あれは stdio を HTTP へ橋渡しするだけのもの）。
	 *
	 * トークンはペインごとに違うため、値を焼き込まず `${PARA_CODE_TERMINAL_PANE_ID}` の
	 * まま書く。エージェントはターミナルの env を継いで起動するので、そこで解決される。
	 */
	private async mergeClaudeMcp(home: URI, port: number): Promise<void> {
		const file = joinPath(home, '.claude.json');
		await this.hookFiles.mergeJson(file, current => paradisMergeRemoteClaudeMcpJson(current, port));
	}

	/**
	 * 接続先の Codex へ para-browser MCP を登録する。
	 *
	 * Claude と同じく HTTP で繋ぐ。接続先の設定に手元のシムのパスが書かれていることがあり
	 * （設定を移した副産物）、そのままでは存在しないファイルを起動しようとして失敗するので、
	 * 既にある para-browser の節ごと置き換える。
	 *
	 * トークンはペインごとに違うので値を焼き込まず、環境変数の名前だけを渡す
	 * （Codex が起動時にその変数を読んで Bearer に載せる）。
	 */
	private async mergeCodexMcp(home: URI, port: number): Promise<void> {
		const file = joinPath(home, '.codex', 'config.toml');
		await this.hookFiles.mergeJson(file, current => paradisUpsertCodexMcpToml(current ?? '', port));
	}
}

registerWorkbenchContribution2(ParadisRemoteAgentHooks.ID, ParadisRemoteAgentHooks, WorkbenchPhase.AfterRestored);
