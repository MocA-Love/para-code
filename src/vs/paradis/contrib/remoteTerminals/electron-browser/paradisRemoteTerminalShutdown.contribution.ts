/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（SSH など）を開いているウィンドウを閉じたとき、そこで動いているターミナルを
// 終了させずに接続先へ残す。
//
// なぜできるのか: 接続先のターミナルの実体は接続先のサーバー側のプロセスで、ウィンドウを
// 閉じても死なない。upstream が終了させているのは、閉じる直前に renderer から明示的に
// 「畳んでよい」と伝えているからで、代わりに「切り離すだけ」と伝えれば残る
// （リロードのときに既にそうしている。違いは理由の判定だけ）。
//
// なぜ聞くのか: 残すのが常に正しいとは限らない。作業を終えて閉じた人にとっては、接続先に
// プロセスが残り続けるのは意図しない資源の占有になる。既定は毎回尋ね、選択を覚えられる。
//
// ローカルのウィンドウには一切関わらない（判断役が最初に接続先の有無で降りる）。ローカルで
// 閉じたときにターミナルが終了するのは今までどおり。

import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { IParadisShutdownTerminal, paradisRegisterTerminalShutdownPolicy } from '../../../../workbench/contrib/terminal/browser/paradisTerminalShutdownPolicy.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ShutdownReason } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisListParkedTerminalEditorInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { paradisParseKeepRemoteTerminalsChoice, paradisPlanRemoteTerminalShutdown, paradisRememberedChoice } from '../common/paradisRemoteTerminalShutdown.js';

const PARADIS_KEEP_REMOTE_TERMINALS_KEY = 'paradis.remote.keepTerminalsAliveOnClose';

// 設定 UI 上は他の Para Code 設定と同じ1セクションに入るよう、id と title を揃える。
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_KEEP_REMOTE_TERMINALS_KEY]: {
			type: 'string',
			enum: ['ask', 'always', 'never'],
			enumDescriptions: [
				localize('paradis.remote.keepTerminalsAliveOnClose.ask', "接続先につながっているウィンドウを閉じるたびに確認する"),
				localize('paradis.remote.keepTerminalsAliveOnClose.always', "常に接続先でターミナルを実行したまま残す"),
				localize('paradis.remote.keepTerminalsAliveOnClose.never', "ローカルのウィンドウと同様、常にターミナルを終了する"),
			],
			default: 'ask',
			description: localize('paradis.remote.keepTerminalsAliveOnClose', "接続先で動いているターミナルを、開いていたウィンドウを閉じたときにどう扱うかを設定します。残したターミナルは次に同じ接続先へつなぎ直したときに、タブと分割レイアウトごと復元されます。再接続の猶予期間が過ぎると接続先側で終了し、復元されなかったターミナルも次に同じ接続先へつないだ直後に終了します。アプリ全体を終了するときは確認せず、覚えている選択に従うか、なければターミナルを残したまま終了します。ローカルのウィンドウや、接続先ウィンドウ内のローカルターミナルには影響しません。"),
		},
	},
});

class ParadisRemoteTerminalShutdown extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.remoteTerminalShutdown';

	/**
	 * 返事を待つ上限。ここを過ぎたら残す側で進む（閉じられないままにしない）。
	 * OS のログアウトや再起動は数十秒で応答しないアプリを強制終了するので、それより短く取る。
	 * 強制終了されると detach が届かず、猶予タイマーの無いプロセスを接続先に残してしまう。
	 */
	private static readonly ANSWER_TIMEOUT_MS = 30 * 1000;

	/**
	 * 今回の閉じる操作について決まった答え。理由ごとに持つのは、閉じるのを取り消して別の理由で
	 * 閉じ直したときに、前の答えを使い回さないため。
	 */
	private _decision: { readonly reason: ShutdownReason; readonly keep: boolean } | undefined;

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(paradisRegisterTerminalShutdownPolicy({
			prepare: reason => this.prepare(reason),
			shouldKeepProcessesAlive: reason => this._decision?.reason === reason && this._decision.keep,
			shouldKeepProcessAlive: (reason, terminal) => this.shouldKeepProcessAlive(reason, terminal),
			warn: message => this.logService.warn(`[paradisRemoteTerminalShutdown] ${message}`),
		}));
	}

	private async prepare(reason: ShutdownReason): Promise<void> {
		this._decision = undefined;
		const keepable = this.countPersistentTerminals();
		const plan = paradisPlanRemoteTerminalShutdown({
			isQuit: reason === ShutdownReason.QUIT,
			// 接続先を開いていないウィンドウには関わらない。ローカルのターミナルの実体はこの PC の
			// プロセスで、残しても次に開いたときに繋ぎ直す相手が居ない（アプリごと終わる）。
			hasRemoteAuthority: this.environmentService.remoteAuthority !== undefined,
			isReload: reason === ShutdownReason.RELOAD,
			choice: paradisParseKeepRemoteTerminalsChoice(this.configurationService.getValue(PARADIS_KEEP_REMOTE_TERMINALS_KEY)),
			persistentTerminalCount: keepable,
		});
		if (plan === 'end') {
			return;
		}
		this._decision = { reason, keep: plan === 'keep' ? true : await this.askUser() };
		// 「残したはずが残っていない」を後から調べられるようにしておく。閉じた後のウィンドウには
		// 何も残らないので、ここで書かないと調べる手掛かりが一切なくなる。
		this.logService.info(`[paradisRemoteTerminalShutdown] closing (reason ${reason}, ${keepable} keepable terminal(s)): ${this._decision.keep ? 'leaving the remote terminals running' : 'ending the terminals'}`);
	}

	private shouldKeepProcessAlive(reason: ShutdownReason, terminal: IParadisShutdownTerminal): boolean {
		return this._decision?.reason === reason && this._decision.keep
			// 接続先の端末だけ。同じウィンドウの中の手元の端末を残しても、次に開いたときに
			// 繋ぎ直す相手が居ない（手元の pty host に孤児として残るだけになる）。
			&& terminal.hasRemoteAuthority
			&& terminal.shouldPersist;
	}

	/**
	 * 閉じる直前に尋ねる。閉じる処理を止めているので、返事が来るまでウィンドウは閉じない。
	 *
	 * 答えずに閉じられた（Esc など）ときは残す側に倒す。残したものは次に接続すれば出てくるし、
	 * 接続先の猶予時間を過ぎれば勝手に片付く。終了させる方は取り返しがつかない。
	 */
	private async askUser(): Promise<boolean> {
		// 返事を待つ間ウィンドウは閉じない。閉じる処理には打ち切りが無いので、答えが来ないまま
		// だとアプリを終了できなくなる。待つのをやめたときは残す側へ倒す。
		// ダイアログ自体は畳めない（`prompt` に取り消しの口が無い）ので、打ち切ったことだけ伝える。
		// 伝えないと、閉じた後に遅れて押された答えで「覚えておく」が書かれ、実際に取った行動と
		// 逆の選択が記憶されうる。
		const abandoned = { value: false };
		const answered = await raceTimeout(
			this.promptUser(abandoned),
			ParadisRemoteTerminalShutdown.ANSWER_TIMEOUT_MS,
			() => { abandoned.value = true; },
		);
		if (answered === undefined) {
			this.logService.warn('[paradisRemoteTerminalShutdown] no answer in time; leaving the remote terminals running');
			return true;
		}
		return answered;
	}

	private async promptUser(abandoned: { value: boolean }): Promise<boolean> {
		const { result, checkboxChecked } = await this.dialogService.prompt<boolean>({
			type: 'question',
			message: localize('paradis.remote.keepTerminals.message', "接続先でターミナルを実行したまま残しますか?"),
			detail: localize('paradis.remote.keepTerminals.detail', "このウィンドウを閉じても実行され続け、次に接続したときにタブとレイアウトごと戻ってきます。"),
			buttons: [
				{
					label: localize('paradis.remote.keepTerminals.keep', "実行したまま残す(&&L)"),
					run: () => true,
				},
				{
					label: localize('paradis.remote.keepTerminals.end', "終了する(&&E)"),
					run: () => false,
				},
			],
			checkbox: { label: localize('paradis.remote.keepTerminals.remember', "この選択を記憶する") },
		});
		const keep = result ?? true;
		if (checkboxChecked === true && !abandoned.value) {
			// 保存の失敗で閉じる処理を止めない。覚えられなくても、次回また尋ねるだけで済む。
			this.configurationService.updateValue(PARADIS_KEEP_REMOTE_TERMINALS_KEY, paradisRememberedChoice(keep), ConfigurationTarget.USER)
				.catch(error => this.logService.warn('[paradisRemoteTerminalShutdown] could not remember the choice', error));
		}
		return keep;
	}

	/**
	 * 残せるターミナルの本数（表示中・背面・別スペースへ待避中をまとめて数える）。
	 *
	 * 実際に畳む側は `terminalService._onWillShutdown` と `terminalEditorInput` の
	 * `onWillShutdown` で、そちらの列挙元と一致させること。片方だけに列挙元が増えると、
	 * 「数えたのに残らない」（尋ねたのに全部死ぬ）か「残るのに尋ねない」になる。
	 */
	private countPersistentTerminals(): number {
		const counted = new Set<number>();
		// 判断本体 (`shouldKeepProcessAlive`) と同じ条件で数える。ここだけ緩いと、手元の端末しか
		// 開いていない接続先ウィンドウでも尋ねてしまい、「残すと答えたのに消えた」になる。
		const add = (instance: ITerminalInstance): void => {
			if (!instance.isDisposed && instance.shouldPersist && instance.hasRemoteAuthority) {
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
		// エディタタブとして開いた端末のうち、別スペースへ待避しているものは上のどちらにも現れない。
		// 数え漏らすと「1本も無い」と判断して尋ねず、そのまま終了させてしまう。
		for (const instance of paradisListParkedTerminalEditorInstances()) {
			add(instance);
		}
		return counted.size;
	}
}

registerWorkbenchContribution2(ParadisRemoteTerminalShutdown.ID, ParadisRemoteTerminalShutdown, WorkbenchPhase.AfterRestored);
