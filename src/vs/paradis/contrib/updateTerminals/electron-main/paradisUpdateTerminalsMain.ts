/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「再起動して更新」の前の関門（main プロセス側）。
//
// 1. 開いているウィンドウそれぞれに、更新すると取り残されるターミナルを聞く（この PC の常駐の姿も
//    同時に聞く）
// 2. 1つでもあれば、答えたウィンドウのうち前面のものに1つの確認を出させる（接続先ごとに枠を分ける）
// 3. 「終わらせて更新」なら、各ウィンドウに接続先のものを止めさせ、合図が届くのを待つ。それから
//    更新を続ける。「あとで更新」・30 秒答えなしなら更新しない（Ready のまま）
// 4. この PC の常駐は、main の終了処理（`onWillShutdown`）に入ってから止める。先に止めると、pty host
//    が「予期せず終わった」と読んで同じ版の常駐を起こし直すため
//
// 確認を終了の途中（renderer の veto）で出さないのは、`lifecycleMainService` がウィンドウを
// 1つずつ閉じるため。後ろのウィンドウで止めると、前のウィンドウだけ先に閉じてしまう。

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IChannel, IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogMainService } from '../../../../platform/dialogs/electron-main/dialogMainService.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IParadisUpdateQuitGate, paradisSetUpdateQuitGate } from '../../../../platform/update/common/paradisUpdateQuitGate.js';
import { IUpdateService, StateType } from '../../../../platform/update/common/update.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { paradisParseKeepTerminalsChoice } from '../../../common/paradisTerminalKeepPlan.js';
import { PARADIS_PTY_DAEMON_ENABLED, PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE, PARADIS_PTY_HOST_DAEMON_ENABLED } from '../../ptyDaemon/common/paradisPtyDaemonSettingKey.js';
import { paradisPtyDaemonPathsFor } from '../../ptyDaemon/electron-main/paradisPtyHostStarterFactory.js';
import { IParadisDaemonLedgerScope, ParadisDaemonStatusCollector } from '../../ptyDaemon/node/paradisDaemonStatusCollector.js';
import {
	IParadisUpdateLocalDaemon,
	IParadisUpdateTerminalSummary,
	IParadisUpdateTerminalsMainService,
	IParadisUpdateTerminalsWindowService,
	IParadisUpdateWindowReport,
	ParadisAfterStopPhase,
	PARADIS_UPDATE_CONFIRM_TIMEOUT_MS,
	PARADIS_UPDATE_TERMINALS_MAIN_CHANNEL,
	PARADIS_UPDATE_TERMINALS_WINDOW_CHANNEL,
	paradisLocalTerminalsAcrossUpdate,
	paradisMergeUpdateReports,
	paradisNextAfterStopPhase,
	paradisPickConfirmWindow,
	paradisResolveUpdateConfirmAnswer,
	paradisShouldConfirmUpdate,
	paradisShouldStopDaemonOnQuit,
	paradisUpdateAppliesOnQuitHere,
	paradisUpdateGroupCount,
} from '../common/paradisUpdateTerminals.js';

/** ウィンドウに聞くときの上限。答えないウィンドウは数に入れない（更新を止めない）。 */
const COLLECT_TIMEOUT_MS = 4_000;
/** 止める合図が届くのを待つ上限（ウィンドウごと）。 */
const STOP_TIMEOUT_MS = 15_000;
/** 常駐へ聞く・止めるときの上限。 */
const DAEMON_TIMEOUT_MS = 10_000;

/** main の IPC サーバーのうち、ここで使うところ。 */
export interface IParadisUpdateTerminalsServer {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
	getChannel(channelName: string, filter: (client: { ctx: string }) => boolean): IChannel;
	readonly connections: readonly { readonly ctx: string }[];
}

class ParadisUpdateTerminalsMain extends Disposable implements IParadisUpdateQuitGate, IParadisUpdateTerminalsMainService {

	private readonly collector: ParadisDaemonStatusCollector;
	/** 「終わらせて更新」で止めた後、更新が本当に始まるかを見張る。 */
	private afterStop: ParadisAfterStopPhase | undefined;
	/** この起動のうちに「準備ができました」を出した（接続先, 版）。 */
	private readonly readyNoticesClaimed = new Set<string>();

	constructor(
		private readonly server: IParadisUpdateTerminalsServer,
		private readonly windowsMainService: IWindowsMainService,
		private readonly dialogMainService: IDialogMainService,
		private readonly configurationService: IConfigurationService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly productService: IProductService,
		private readonly updateService: IUpdateService,
		lifecycleMainService: ILifecycleMainService,
		private readonly logService: ILogService,
	) {
		super();
		this.collector = this._register(new ParadisDaemonStatusCollector(logService));

		this._register(this.updateService.onStateChange(state => {
			if (this.afterStop === undefined) {
				return;
			}
			this.afterStop = paradisNextAfterStopPhase(this.afterStop, state.type);
			if (this.afterStop === 'cancelled') {
				void this.cancelAfterStop(`the update moved to "${state.type}"`);
			}
		}));

		// この PC の常駐は、終了処理に入ってから止める（{@link paradisShouldStopDaemonOnQuit}）。
		// ウィンドウを全部閉じた macOS で Ready のまま終了した場合もここで拾う。
		this._register(lifecycleMainService.onWillShutdown(event => {
			const scope = this.perBuildDaemonScope();
			if (!scope || !paradisShouldStopDaemonOnQuit({
				stateType: this.updateService.state.type,
				appliesOnQuit: paradisUpdateAppliesOnQuitHere(),
				daemonStranded: true,
				choice: this.daemonChoice(),
			})) {
				return;
			}
			event.join('paradis.updateTerminals.daemon', this.stopLocalDaemon(scope));
		}));
	}

	async confirmBeforeQuitAndInstall(): Promise<boolean> {
		const windows = this.windowsMainService.getWindows().filter(window => window.isReady && this.isConnected(window.id));
		// ウィンドウへの問い合わせと常駐への問い合わせは並べて待つ。
		const [answers, localDaemon] = await Promise.all([
			Promise.all(windows.map(async window => {
				try {
					const report = await raceTimeout(this.windowService(window.id).collect().then(value => ({ value })), COLLECT_TIMEOUT_MS);
					return { window, answered: report !== undefined, report: report?.value };
				} catch (error) {
					// Agent Sessions のウィンドウなど、この口を持たないウィンドウ。関わりが無い。
					this.logService.trace(`[paradisUpdateTerminals] window ${window.id} did not answer`, error);
					return { window, answered: false, report: undefined };
				}
			})),
			this.getLocalDaemon(),
		]);
		const answered = answers.filter(entry => entry.answered);
		const summary = paradisMergeUpdateReports(answered.map(entry => entry.report).filter((report): report is IParadisUpdateWindowReport => report !== undefined), localDaemon);
		if (!paradisShouldConfirmUpdate(summary)) {
			return true;
		}

		const answer = await this.ask(summary, answered.map(entry => entry.window.id));
		this.logService.info(`[paradisUpdateTerminals] ${summary.groups.map(group => `${paradisUpdateGroupCount(group)} on ${group.isRemote ? 'a remote' : 'this machine'}`).join(', ')}: ${answer === 'update' ? 'ending them and updating' : 'updating later'}`);
		if (answer !== 'update') {
			return false;
		}

		// 答えたウィンドウすべてに止めさせる（止める対象はウィンドウが自分で選び直す。設定が
		// `never` のものなどは何もしない）。合図が届くのを待ってから更新を続ける。
		// この PC の常駐は、ここではなく終了処理に入ってから止める。
		await Promise.all(answered.map(async ({ window }) => {
			try {
				const done = await raceTimeout(this.windowService(window.id).stopForUpdate().then(() => true), STOP_TIMEOUT_MS);
				if (!done) {
					this.logService.warn(`[paradisUpdateTerminals] window ${window.id} did not finish stopping its terminals in time; updating anyway`);
				}
			} catch (error) {
				this.logService.warn(`[paradisUpdateTerminals] window ${window.id} could not stop its terminals`, error);
			}
		}));

		// 止めている間に更新の状態が変わっていたら、更新は行われない。止めたものは戻らないので知らせる。
		if (this.updateService.state.type !== StateType.Ready) {
			await this.cancelAfterStop(`the update is no longer ready ("${this.updateService.state.type}")`);
			return false;
		}
		this.afterStop = 'waiting';
		return true;
	}

	/** 止めた後で更新が行われなかったとき。全ウィンドウの合図を取り消し、止めたウィンドウは知らせる。 */
	private async cancelAfterStop(reason: string): Promise<void> {
		this.afterStop = undefined;
		this.logService.warn(`[paradisUpdateTerminals] terminals were ended to update, but the update did not happen: ${reason}`);
		await Promise.all(this.windowsMainService.getWindows().filter(window => this.isConnected(window.id)).map(async window => {
			try {
				await raceTimeout(this.windowService(window.id).cancelUpdateQuit(), COLLECT_TIMEOUT_MS);
			} catch {
				// この口を持たないウィンドウ。
			}
		}));
	}

	/** 答えたウィンドウのうち前面のものに確認を出させる。答えたウィンドウが無ければ main から出す。 */
	private async ask(summary: IParadisUpdateTerminalSummary, answeredIds: readonly number[]): Promise<'update' | 'later'> {
		const targetId = paradisPickConfirmWindow(answeredIds, this.windowsMainService.getFocusedWindow()?.id, this.windowsMainService.getLastActiveWindow()?.id);
		const target = targetId !== undefined ? this.windowsMainService.getWindowById(targetId) : undefined;
		if (!target) {
			return this.askWithoutWindow(summary);
		}
		target.focus({ mode: FocusMode.Force });
		try {
			// ウィンドウの側でも 30 秒で畳む。こちらはウィンドウが答えなくなったときの保険。
			const answer = await raceTimeout(this.windowService(target.id).confirm(summary), PARADIS_UPDATE_CONFIRM_TIMEOUT_MS + 5_000);
			return paradisResolveUpdateConfirmAnswer(answer);
		} catch (error) {
			this.logService.warn('[paradisUpdateTerminals] the window could not show the confirmation; updating later', error);
			return 'later';
		}
	}

	/**
	 * 答えるウィンドウが無い（macOS でウィンドウを全部閉じた、開いているのが Agent Sessions のウィンドウ
	 * だけ）ときの確認。ここで尋ねずに「あとで」にすると、ウィンドウを開かない限り更新できなくなるので、
	 * main から OS の確認を出す。
	 */
	private async askWithoutWindow(summary: IParadisUpdateTerminalSummary): Promise<'update' | 'later'> {
		const lines = summary.groups.map(group => localize('paradis.updateTerminals.native.line', "{0}: {1} 個", group.hostLabel, paradisUpdateGroupCount(group)));
		const { response } = await this.dialogMainService.showMessageBox({
			type: 'warning',
			message: localize('paradis.updateTerminals.title', "接続先のターミナルを終わらせて更新しますか？"),
			detail: [localize('paradis.updateTerminals.native.detail', "更新すると、残したターミナルは新しい版から開き直せません。次のものが終了します。"), ...lines].join('\n'),
			buttons: [
				localize('paradis.updateTerminals.native.later', "あとで更新"),
				localize('paradis.updateTerminals.native.update', "終わらせて更新"),
			],
			defaultId: 0,
			cancelId: 0,
		});
		return response === 1 ? 'update' : 'later';
	}

	async getLocalDaemon(): Promise<IParadisUpdateLocalDaemon | undefined> {
		const scope = this.perBuildDaemonScope();
		if (!scope) {
			return undefined;
		}
		try {
			const status = await raceTimeout(this.collector.collect(scope), DAEMON_TIMEOUT_MS);
			if (!status?.running) {
				return undefined;
			}
			return {
				stranded: true,
				terminalCount: status.terminalCount,
				choice: this.daemonChoice(),
				hostLabel: localize('paradis.updateTerminals.localHost', "この PC の常駐"),
			};
		} catch (error) {
			this.logService.warn('[paradisUpdateTerminals] could not ask the pty daemon what it holds', error);
			return undefined;
		}
	}

	async claimReadyNotice(hostKey: string, version: string): Promise<boolean> {
		const key = `${hostKey}\n${version}`;
		if (this.readyNoticesClaimed.has(key)) {
			return false;
		}
		this.readyNoticesClaimed.add(key);
		return true;
	}

	private async stopLocalDaemon(scope: IParadisDaemonLedgerScope): Promise<void> {
		try {
			const done = await raceTimeout(this.collector.stopActive(scope).then(() => true), DAEMON_TIMEOUT_MS);
			if (done) {
				this.logService.info('[paradisUpdateTerminals] stopped the pty daemon of this build before updating');
			} else {
				this.logService.warn('[paradisUpdateTerminals] the pty daemon did not stop in time; updating anyway');
			}
		} catch (error) {
			this.logService.warn('[paradisUpdateTerminals] could not stop the pty daemon', error);
		}
	}

	private daemonChoice() {
		return paradisParseKeepTerminalsChoice(this.configurationService.getValue(PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE));
	}

	/**
	 * 版で区切られた常駐の台帳。更新をまたげる方式（`reattachAcrossUpdates`）を使っているときは
	 * undefined（更新後も繋ぎ直せるので対象外）。
	 *
	 * 更新をまたげる方式も、話す言葉の版（`PARADIS_PTY_PROTOCOL_VERSION`）が上がる更新では
	 * 繋ぎ直せない。ただ、用意できた更新の版がどれかはここから分からないので、対象にしていない。
	 */
	private perBuildDaemonScope(): IParadisDaemonLedgerScope | undefined {
		const acrossUpdate = paradisLocalTerminalsAcrossUpdate(
			this.configurationService.getValue(PARADIS_PTY_DAEMON_ENABLED) === true,
			this.configurationService.getValue(PARADIS_PTY_HOST_DAEMON_ENABLED) === true,
		);
		if (acrossUpdate !== 'stranded') {
			return undefined;
		}
		const paths = paradisPtyDaemonPathsFor(this.environmentMainService, this.productService);
		return { ledgerDirs: [paths.ledgerDir], activeBuildKey: paths.buildKey };
	}

	private isConnected(windowId: number): boolean {
		const ctx = `window:${windowId}`;
		return this.server.connections.some(connection => connection.ctx === ctx);
	}

	private windowService(windowId: number): IParadisUpdateTerminalsWindowService {
		const ctx = `window:${windowId}`;
		return ProxyChannel.toService<IParadisUpdateTerminalsWindowService>(this.server.getChannel(PARADIS_UPDATE_TERMINALS_WINDOW_CHANNEL, client => client.ctx === ctx));
	}
}

/** `app.ts` から1行で呼べる登録。関門と、ウィンドウから main へのチャネルを立てる。 */
export function paradisRegisterUpdateTerminals(
	server: IParadisUpdateTerminalsServer,
	windowsMainService: IWindowsMainService,
	dialogMainService: IDialogMainService,
	configurationService: IConfigurationService,
	environmentMainService: IEnvironmentMainService,
	productService: IProductService,
	updateService: IUpdateService,
	lifecycleMainService: ILifecycleMainService,
	logService: ILogService,
): IDisposable {
	const store = new DisposableStore();
	const main = store.add(new ParadisUpdateTerminalsMain(server, windowsMainService, dialogMainService, configurationService, environmentMainService, productService, updateService, lifecycleMainService, logService));
	store.add(paradisSetUpdateQuitGate(main));
	// 公開するのはこの2つだけ（クラスの他のメソッドをウィンドウから呼べないようにする）。
	const surface: IParadisUpdateTerminalsMainService = {
		getLocalDaemon: () => main.getLocalDaemon(),
		claimReadyNotice: (hostKey, version) => main.claimReadyNotice(hostKey, version),
	};
	server.registerChannel(PARADIS_UPDATE_TERMINALS_MAIN_CHANNEL, ProxyChannel.fromService<string>(surface, store));
	return store;
}
