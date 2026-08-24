/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 閉じるときに、この PC の常駐 (pty デーモン) へターミナルを残すかどうかを答える役。
//
// 常駐を作っただけではターミナルは残らない。閉じる側 (`terminalService._onWillShutdown`) は
// リロード以外で `instance.dispose()` を呼び、プロセスを1本ずつ明示的に終了させるからで、
// **残すには「残す」と答える役が要る**。接続先 (SSH) 用の同じ役が既にあり、こちらはその
// ローカル版になる。判断の中身は共有してある (`paradisTerminalKeepPlan`)。
//
// 答えるのは**この PC のターミナルだけ**。同じウィンドウに接続先のターミナルが混ざっていても、
// そちらは接続先用の役が答える。両方に `true` と答えると、繋ぎ直す相手が居ない端末まで
// 「残す」扱いになり、猶予時間ぶん孤児として残るだけになる。

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisShutdownTerminal, paradisRegisterTerminalShutdownPolicy } from '../../../../workbench/contrib/terminal/browser/paradisTerminalShutdownPolicy.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ShutdownReason } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisListParkedTerminalEditorInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { paradisDaemonHandlesTerminal, paradisParseKeepTerminalsChoice, paradisPlanTerminalKeep, paradisRememberedKeepChoice } from '../../../common/paradisTerminalKeepPlan.js';
import { IParadisPtyDaemonStatusService, PARADIS_PTY_DAEMON_CHANNEL } from '../common/paradisPtyDaemonStatus.js';
import { PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE } from '../common/paradisPtyDaemonSettingKey.js';

class ParadisPtyDaemonShutdown extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.ptyDaemonShutdown';

	/**
	 * 返事を待つ上限。閉じる処理には打ち切りが無いので、答えが来ないままだとアプリを終了できない。
	 *
	 * OS のログアウトや再起動は数十秒で応答しないアプリを強制終了するので、それより短く取る
	 * （接続先用の役と同じ理由・同じ値）。強制終了されると detach が届かないが、常駐の側は
	 * それを自分で拾える（`paradisShouldDaemonExit` の猶予）ので、接続先ほどの実害は無い。
	 */
	private static readonly ANSWER_TIMEOUT_MS = 30 * 1000;

	/**
	 * 常駐が動いているかを main へ聞くときの上限。
	 *
	 * 閉じる処理の直列パス上なので、返らないままだとウィンドウが閉じられなくなる。相手は同じ
	 * マシンの main なので、生きていれば一往復で済む。
	 */
	private static readonly STATUS_TIMEOUT_MS = 2_000;

	private readonly status: IParadisPtyDaemonStatusService;
	private decision: { reason: ShutdownReason; keep: boolean } | undefined;

	/**
	 * 最後に確かめられた「常駐が動いているか」。
	 *
	 * 閉じる瞬間に聞けなかったときの答えに使う。**聞けないことを「動いていない」と読んではいけない。**
	 * 動いている常駐の端末を「動いていない」と扱うと `dispose()` へ回り、残せたはずの作業がその場で
	 * 失われる。
	 *
	 * 逆に誤った場合 (常駐は本当に死んでいた) に失うものはゼロではない。ウィンドウ単位の答えが
	 * true になるので `terminalService` が `persistTerminalState()` を飛ばし、**次に開いたときの
	 * タブとスクロールバックの復元が消える** (プロセスはどのみち死んでいるので、失うのは復元だけ。
	 * レイアウト情報の方は、死んだ id を pty host が落とすので無害)。
	 *
	 * それでも天秤は楽観側に傾いている。悲観に倒して外すと**生きているエージェントの作業がその場で
	 * 消える**のに対し、楽観に倒して外して失うのは、どのみち死んでいたプロセスの見た目だけだから。
	 * 「失うものが無い」からではなく、**釣り合わない**から楽観に倒す。
	 *
	 * なお、この値は*最後に確かめられた*姿であって、確かめられなかった回数は数えていない。
	 */
	private lastKnownRunning: boolean | undefined;

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.status = ProxyChannel.toService<IParadisPtyDaemonStatusService>(mainProcessService.getChannel(PARADIS_PTY_DAEMON_CHANNEL));

		this._register(paradisRegisterTerminalShutdownPolicy({
			prepare: reason => this.prepare(reason),
			shouldKeepProcessesAlive: reason => this.decision?.reason === reason && this.decision.keep,
			shouldKeepProcessAlive: (reason, terminal) => this.shouldKeepProcessAlive(reason, terminal),
			warn: message => this.logService.warn(`[paradisPtyDaemonShutdown] ${message}`),
		}));

		// 閉じる瞬間に main が詰まっていると聞けないので、余裕のあるうちに読んでおく。
		//
		// **起動直後に1回だけ、では足りない。** 常駐が起きるのはウィンドウが接続を要求した
		// ときで (`ptyHostService` の "Start the pty host when a window requests a connection")、
		// 復元するターミナルが1本も無いウィンドウでは、この contribution が走る時点ではまだ
		// 起きていない。そこで焼いた `false` を後から直す経路が無いと、フォールバックが
		// 狙いと正反対 (動いている常駐の端末を終了させる) に働く。
		//
		// だから端末が作られたときにも読み直す。常駐が起きるのはまさにその瞬間なので、
		// 「本当に常駐が居るウィンドウ」では必ず true が焼ける。
		//
		// 接続先を開いているウィンドウでは読みに行かない。ここが聞くのは**この PC の main**で、
		// そちらの答えは接続先の端末について何も言っていない。`prepare` が先に降りるので焼いた
		// 値が使われることはないが、要らない往復を接続先のウィンドウから出し続ける理由も無い。
		if (this.environmentService.remoteAuthority !== undefined) {
			return;
		}
		void this.isDaemonRunning();
		this._register(this.terminalService.onDidCreateInstance(() => void this.isDaemonRunning()));
	}

	private async prepare(reason: ShutdownReason): Promise<void> {
		this.decision = undefined;

		// 接続先のウィンドウでは何も答えない。**このウィンドウにもローカルの端末は居る**
		// (「Create New Integrated Terminal (Local)」で作れる) が、残しても誰も繋ぎ直さない。
		// 接続先を開いているウィンドウは、開くときに `_reconnectToRemoteTerminals()` だけを呼び、
		// `_reconnectToLocalTerminals()` は永久に走らない (`terminalService.ts` の
		// `isPersistentRemote` 分岐)。レイアウトも接続先のバックエンドにしか書かれない。
		// 残すと、常駐の中で猶予時間ぶんメモリを抱えたまま誰にも拾われずに消える。
		if (this.environmentService.remoteAuthority !== undefined) {
			return;
		}

		const keepable = this.countKeepableTerminals();
		const input = {
			isReload: reason === ShutdownReason.RELOAD,
			isQuit: reason === ShutdownReason.QUIT,
			choice: paradisParseKeepTerminalsChoice(this.configurationService.getValue(PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE)),
			persistentTerminalCount: keepable,
		};

		// 常駐が動いているかを聞く前に、聞いても答えが変わらないかを確かめる。`canOutliveWindow`
		// が false のときの答えは必ず `end` なので、true と仮定して `end` になるなら聞くまでもない。
		// 判断は1箇所のままで、閉じるたびの往復だけを省ける (設定を切っている人が一番これに当たる)。
		if (paradisPlanTerminalKeep({ ...input, canOutliveWindow: true }) === 'end') {
			return;
		}

		// ここまで来て初めて聞く。設定より先に確かめるのは、`always` にしている人へ
		// 「残した」と言って実際には消える、を避けるため。
		const running = await this.isDaemonRunning();
		if (!running) {
			return;
		}
		// `running` をそのまま渡す。ここに `true` と書くと、`paradisPlanTerminalKeep` が
		// `canOutliveWindow` を見る条件を1つでも増やした瞬間、この呼び出しだけが嘘をつく。
		const plan = paradisPlanTerminalKeep({ ...input, canOutliveWindow: running });
		this.decision = { reason, keep: plan === 'keep' ? true : await this.askUser(keepable) };
		// 閉じた後のウィンドウには何も残らないので、ここで書かないと後から追えない。
		this.logService.info(`[paradisPtyDaemonShutdown] closing (reason ${reason}, ${keepable} keepable terminal(s)): ${this.decision.keep ? 'leaving them with the daemon' : 'ending them'}`);
	}

	/** 常駐が動いているか。上限付きで聞き、聞けなければ最後に見えていた姿を使う。 */
	private async isDaemonRunning(): Promise<boolean> {
		try {
			const status = await raceTimeout(this.status.getStatus(), ParadisPtyDaemonShutdown.STATUS_TIMEOUT_MS);
			if (status) {
				this.lastKnownRunning = status.running;
				return status.running;
			}
			this.logService.warn('[paradisPtyDaemonShutdown] the main process did not say whether a daemon is running in time');
		} catch (error) {
			this.logService.warn('[paradisPtyDaemonShutdown] could not ask whether a daemon is running', error);
		}
		return this.lastKnownRunning === true;
	}

	/**
	 * その端末を残すか。
	 *
	 * 接続先の端末には答えない (`hasRemoteAuthority`)。そちらは接続先用の役の担当で、常駐は
	 * この PC のプロセスしか抱えていない。
	 */
	private shouldKeepProcessAlive(reason: ShutdownReason, terminal: IParadisShutdownTerminal): boolean {
		return this.decision?.reason === reason
			&& this.decision.keep
			// `prepare` でも降りているが、ここでも見る。`decision` が何かの拍子に残っても、
			// 担当外の端末へ true を返さないため。判定そのものは接続先側と同じ場所に置いてある
			// (2つが同時に true にならないことを、表にして固定できるようにするため)。
			&& paradisDaemonHandlesTerminal(this.environmentService.remoteAuthority !== undefined, terminal);
	}

	/**
	 * 残せる端末を数える。
	 *
	 * **判断本体 (`shouldKeepProcessAlive`) と同じ条件で数えること。** ここだけ緩いと、
	 * 残せる端末が1本も無いのに尋ねてしまい「残すと答えたのに消えた」になる。厳しいと、
	 * 尋ねずに終了させる。
	 *
	 * 列挙元も畳む側 (`terminalService._onWillShutdown` と `terminalEditorInput`) と揃える。
	 * 別スペースへ待避した端末はどちらにも現れないので、数え漏らすと尋ねずに終了させてしまう。
	 */
	private countKeepableTerminals(): number {
		if (this.environmentService.remoteAuthority !== undefined) {
			return 0;
		}
		const counted = new Set<number>();
		const add = (instance: ITerminalInstance): void => {
			if (!instance.isDisposed && paradisDaemonHandlesTerminal(false, instance)) {
				counted.add(instance.instanceId);
			}
		};
		for (const instance of this.terminalService.instances) {
			add(instance);
		}
		for (const group of this.terminalGroupService.paradisParkedGroups ?? []) {
			for (const instance of group.terminalInstances) {
				add(instance);
			}
		}
		for (const instance of paradisListParkedTerminalEditorInstances()) {
			add(instance);
		}
		return counted.size;
	}

	/** 尋ねる。答えが来ないまま上限に達したら残す側へ倒す (終わらせた作業は戻らない)。 */
	private async askUser(keepable: number): Promise<boolean> {
		const abandoned = { value: false };
		const answered = await raceTimeout(
			this.promptUser(keepable, abandoned),
			ParadisPtyDaemonShutdown.ANSWER_TIMEOUT_MS,
			() => { abandoned.value = true; },
		);
		if (answered === undefined) {
			this.logService.warn('[paradisPtyDaemonShutdown] no answer in time; leaving the terminals with the daemon');
			return true;
		}
		return answered;
	}

	private async promptUser(keepable: number, abandoned: { value: boolean }): Promise<boolean> {
		const { result, checkboxChecked } = await this.dialogService.prompt<boolean>({
			type: 'question',
			message: localize('paradis.ptyDaemon.keep.message', "この PC のターミナルを実行したまま残しますか?"),
			detail: localize('paradis.ptyDaemon.keep.detail', "{0}本のターミナルが Para Code の外の常駐へ残り、このウィンドウを閉じても実行され続けます。次に開いたときにタブとレイアウトごと戻ってきます。24時間どのウィンドウからも開かれなければ終了します。", keepable),
			buttons: [
				{ label: localize('paradis.ptyDaemon.keep.keep', "実行したまま残す(&&L)"), run: () => true },
				{ label: localize('paradis.ptyDaemon.keep.end', "終了する(&&E)"), run: () => false },
			],
			checkbox: { label: localize('paradis.ptyDaemon.keep.remember', "この選択を記憶する") },
		});
		const keep = result ?? true;
		if (checkboxChecked === true && !abandoned.value) {
			// 保存の失敗で閉じる処理を止めない。覚えられなくても、次回また尋ねるだけで済む。
			this.configurationService.updateValue(PARADIS_PTY_DAEMON_KEEP_ALIVE_ON_CLOSE, paradisRememberedKeepChoice(keep), ConfigurationTarget.USER)
				.catch(error => this.logService.warn('[paradisPtyDaemonShutdown] could not remember the choice', error));
		}
		return keep;
	}
}

registerWorkbenchContribution2(ParadisPtyDaemonShutdown.ID, ParadisPtyDaemonShutdown, WorkbenchPhase.AfterRestored);
