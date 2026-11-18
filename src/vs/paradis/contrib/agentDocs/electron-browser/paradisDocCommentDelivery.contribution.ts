/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のコメントを、このウィンドウのペインへ貼る係。届けてよいかは shared process の届け方の係
// （node/paradisDocCommentDelivery.ts）が決め、ここは「届けたいペインがある」の知らせを受けて、自分のペインの分だけを取り、
// 貼り付け（bracketed paste）として入れる。Enter は、貼った後に shared process で状態を確かめ直し、画面に確認の文言が
// 出ていないのを確かめてから送る（send_terminal_input・Design Mode の ⌘Enter と同じ順）。
// 退避中・別スペースのペインにも届ける（フォーカス・表示・スペースの切り替えはしない）。
//
// Design Mode の「空いたら入れる」予約（#1113）はページごと・ウィンドウのメモリ・Enter なしなので使わず、部品
// （paradisBuildPresetInsertText、画面の確認、貼った後の 250ms）だけを使う。

import { timeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisCollectLivePaneInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisAgentIdeScreenShowsPrompt } from '../../agentIde/common/paradisAgentIde.js';
import { paradisBuildPresetInsertText } from '../../terminalPresets/common/paradisTerminalPresets.js';
import {
	IParadisDocDeliveryClaim,
	PARADIS_DOC_DELIVERY_CHANNEL,
	PARADIS_DOC_DELIVERY_CLAIM_METHOD,
	PARADIS_DOC_DELIVERY_CONFIRM_METHOD,
	PARADIS_DOC_DELIVERY_FINISH_METHOD,
	PARADIS_DOC_DELIVERY_WANTED_EVENT,
	ParadisDocDeliveryOutcome,
} from '../common/paradisDocCommentDelivery.js';

/** 貼ってから Enter を送るまで待つ時間（send_terminal_input と同じ）。この間に出た確認を拾う。 */
const SUBMIT_SETTLE_MS = 250;
/** 確認の文言を探す、画面の末尾の行数。 */
const SCREEN_LINES = 40;

class ParadisDocCommentDeliveryContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDocCommentDelivery';

	/** 貼っている途中のペイン（同じペインへ重ねて貼らない）。 */
	private readonly _running = new Set<string>();

	constructor(
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
		@IParadisPaneTokenService private readonly _paneTokenService: IParadisPaneTokenService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		const channel = _sharedProcessService.getChannel(PARADIS_DOC_DELIVERY_CHANNEL);
		this._register(channel.listen<readonly string[]>(PARADIS_DOC_DELIVERY_WANTED_EVENT)(tokens => {
			if (!Array.isArray(tokens)) {
				return;
			}
			for (const token of tokens) {
				if (typeof token === 'string') {
					void this._deliver(token);
				}
			}
		}));
	}

	private _instanceOf(token: string): ITerminalInstance | undefined {
		return paradisCollectLivePaneInstances(this._terminalService, this._terminalGroupService, this._paneTokenService).find(entry => entry.token === token)?.instance;
	}

	private async _deliver(token: string): Promise<void> {
		// このウィンドウのペインでなければ何もしない（持っているウィンドウが取る）
		if (this._running.has(token) || this._instanceOf(token) === undefined) {
			return;
		}
		this._running.add(token);
		const channel = this._sharedProcessService.getChannel(PARADIS_DOC_DELIVERY_CHANNEL);
		try {
			const claim = await channel.call<IParadisDocDeliveryClaim | undefined>(PARADIS_DOC_DELIVERY_CLAIM_METHOD, [token]);
			if (!claim || typeof claim.attempt !== 'string' || typeof claim.text !== 'string') {
				return;
			}
			let outcome: ParadisDocDeliveryOutcome = 'gone';
			try {
				outcome = await this._paste(token, claim);
			} catch (error) {
				this._logService.warn('[ParadisDocComments] could not type a comment into the terminal', error);
			}
			await channel.call(PARADIS_DOC_DELIVERY_FINISH_METHOD, [claim.attempt, outcome]);
		} catch (error) {
			this._logService.warn('[ParadisDocComments] could not deliver a comment', error);
		} finally {
			this._running.delete(token);
		}
	}

	/** 貼り、必要なら Enter を送る。 */
	private async _paste(token: string, claim: IParadisDocDeliveryClaim): Promise<ParadisDocDeliveryOutcome> {
		const instance = this._instanceOf(token);
		const text = paradisBuildPresetInsertText(claim.text, false);
		if (instance === undefined || instance.isDisposed || text === undefined) {
			return 'gone';
		}
		// 画面に確認（許可・質問・選択の画面）が出ていたら貼らない（貼った文は捨てられ、数字や Enter が選択になる）
		const before = this._screenTail(instance);
		if (before !== undefined && paradisAgentIdeScreenShowsPrompt(before)) {
			return 'screen';
		}
		await instance.sendText(text, false, true);
		// 画面を読めないときは確かめようがないので Enter を送らない
		if (!claim.enter || before === undefined) {
			return 'typed';
		}
		await timeout(SUBMIT_SETTLE_MS);
		const mayEnter = await this._sharedProcessService.getChannel(PARADIS_DOC_DELIVERY_CHANNEL).call<boolean>(PARADIS_DOC_DELIVERY_CONFIRM_METHOD, [claim.attempt]);
		// 確かめてから Enter を送るまでの間に await を挟まない
		const after = this._screenTail(instance);
		if (mayEnter !== true || instance.isDisposed || after === undefined || paradisAgentIdeScreenShowsPrompt(after, text)) {
			return 'typed';
		}
		await instance.sendText('\r', false);
		return 'entered';
	}

	/** 画面の末尾の行（確認の文言を探すため）。読めなければ undefined。 */
	private _screenTail(instance: ITerminalInstance): string | undefined {
		const raw = instance.xterm?.raw;
		if (!raw) {
			return undefined;
		}
		const buffer = raw.buffer.active;
		const lines: string[] = [];
		for (let y = Math.max(0, buffer.length - SCREEN_LINES); y < buffer.length; y++) {
			const line = buffer.getLine(y);
			if (line) {
				lines.push(line.translateToString(true));
			}
		}
		return lines.join('\n');
	}
}

registerWorkbenchContribution2(ParadisDocCommentDeliveryContribution.ID, ParadisDocCommentDeliveryContribution, WorkbenchPhase.AfterRestored);
