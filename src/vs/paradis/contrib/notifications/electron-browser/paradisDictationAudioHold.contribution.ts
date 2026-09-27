/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 音声入力（upstream 内蔵のディクテーション）の間、Para Code の読み上げ（Aivis）と通知音を止める
// （q.html Q38 案A「読み上げが話している間は、声を拾わないよう読み上げを止めます」）。
//
// 音声入力はチャット・エディタ・ターミナルのどの入口から始めても、内蔵エンジンなら
// IChatSpeechToTextService を通る。マイクはモデルの準備中から開いているので、状態が Idle 以外、
// または開始・停止の途中（isBusy）の間を「音声入力中」とみなす。拡張機能（vscode-speech 等）の
// 音声入力は ISpeechService のセッションで見る。
//
// 外部の aivis-mcp（ターミナルのエージェントが直接喋らせるもの）はここでは止めない。止める口
// （`aivis --mute`）はおやすみモードと共有で、解除のときにおやすみモードやユーザー自身のミュートまで
// 解いてしまうため（paradisAivisMuteBridgeChannel.ts 参照）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { ISpeechService } from '../../../../workbench/contrib/speech/common/speechService.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';

class ParadisDictationAudioHold extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDictationAudioHold';

	private active = false;

	constructor(
		@IChatSpeechToTextService private readonly speechToTextService: IChatSpeechToTextService,
		@ISpeechService private readonly speechService: ISpeechService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const update = () => this.update();
		this._register(this.speechToTextService.onDidChangeState(update));
		this._register(this.speechToTextService.onDidChangePreparingModel(update));
		this._register(this.speechService.onDidStartSpeechToTextSession(update));
		this._register(this.speechService.onDidEndSpeechToTextSession(update));
		this._register({ dispose: () => this.send(false) });
	}

	private update(): void {
		const active = this.speechToTextService.state !== ChatSpeechToTextState.Idle
			|| this.speechToTextService.isBusy
			|| this.speechService.hasActiveSpeechToTextSession;
		if (active !== this.active) {
			this.send(active);
		}
	}

	private send(active: boolean): void {
		if (active === this.active) {
			return;
		}
		this.active = active;
		this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('setDictationActive', [active])
			.catch(error => this.logService.trace('[ParadisNotifications] setDictationActive failed', String(error)));
	}
}

registerWorkbenchContribution2(ParadisDictationAudioHold.ID, ParadisDictationAudioHold, WorkbenchPhase.AfterRestored);
