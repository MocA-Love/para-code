/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャット表示の入力欄のマイク。upstream の音声入力（IChatSpeechToTextService）をそのまま使い、
// 書き起こしを入力欄のカーソルの位置へ流し込む（upstream の startDictation はエディタ専用なので使えない）。
//
// surface は 'editor' で始める。'chat' にすると upstream の Copilot のチャットのマイクが光る
// （voiceInputModeActionViewItem・dictationMicGlow が 'chat' を見ている）。
//
// macOS 26 より古い Mac・Windows・Linux では認識の中身が無い。upstream のマイクは出ないが、
// ここはマイクを出して、押したら使えない理由を入力欄の上に出す（自分で `dictation.enabled` を
// false にした人には出さない）。

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { platform } from '../../../../base/common/process.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILocalTranscriptionService } from '../../../../platform/localTranscription/common/localTranscription.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { INativeWorkbenchEnvironmentService } from '../../../../workbench/services/environment/electron-browser/environmentService.js';
import { paradisSpeechEngineAvailability, paradisSpeechEngineUnavailableMessage } from '../../dictation/common/paradisSpeechEngine.js';
import { IParadisAgentChatDictation, IParadisAgentChatDictationTarget } from '../browser/paradisAgentChatComposer.js';

const DICTATION_ENABLED_SETTING = 'dictation.enabled';

/** マイクを出すか。自分で切った人には出さない。認識の中身が無い OS では案内のために出す。 */
export function paradisAgentChatShowsMicrophone(setting: { readonly value?: boolean; readonly userValue?: boolean; readonly workspaceValue?: boolean; readonly workspaceFolderValue?: boolean; readonly policyValue?: boolean }, unavailable: boolean): boolean {
	const turnedOff = setting.policyValue === false || setting.userValue === false || setting.workspaceValue === false || setting.workspaceFolderValue === false;
	if (turnedOff) {
		return false;
	}
	return unavailable || setting.value !== false;
}

/**
 * 入力欄の中で書き起こしを差し替える範囲。書き起こしは毎回それまでの全文で届くので、
 * 前回入れた分を今回の文で置き換える。途中で利用者が打ったら、そこまでの書き起こしは確定として扱い、
 * 以後の分だけをカーソルの位置へ入れる。
 */
export class ParadisAgentChatTranscriptRegion {
	private anchor = 0;
	private inserted = 0;
	/** 書き起こしのうち、既に確定として入力欄に残した分の長さ。 */
	private consumed = 0;
	private lastText = '';

	constructor(private readonly textarea: HTMLTextAreaElement) { }

	/** 書き起こしを始める。選んでいた文は書き起こしで置き換える。 */
	begin(): void {
		const start = this.textarea.selectionStart;
		this.textarea.setRangeText('', start, this.textarea.selectionEnd, 'end');
		this.anchor = start;
		this.inserted = 0;
		this.consumed = 0;
		this.lastText = '';
	}

	/** それまでの全文を入れる。 */
	render(text: string): void {
		this.lastText = text;
		const piece = text.slice(this.consumed);
		this.textarea.setRangeText(piece, this.anchor, this.anchor + this.inserted, 'end');
		this.inserted = piece.length;
	}

	/** 利用者が入力欄を書き換えた。以後はカーソルの位置へ続きを入れる。 */
	userEdited(): void {
		this.consumed = this.lastText.length;
		this.anchor = this.textarea.selectionStart;
		this.inserted = 0;
	}
}

export class ParadisAgentChatDictation extends Disposable implements IParadisAgentChatDictation {

	private readonly button: HTMLButtonElement;
	private readonly unavailableMessage: string | undefined;
	private readonly session = this._register(new DisposableStore());
	private readonly region: ParadisAgentChatTranscriptRegion;
	/** この入力欄が今の音声入力の持ち主か。 */
	private active = false;
	private stopping = false;

	constructor(
		private readonly target: IParadisAgentChatDictationTarget,
		@IChatSpeechToTextService private readonly speechToTextService: IChatSpeechToTextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHoverService hoverService: IHoverService,
		@ILocalTranscriptionService localTranscriptionService: ILocalTranscriptionService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
	) {
		super();
		this.unavailableMessage = localTranscriptionService.isSupported ? undefined : paradisSpeechEngineUnavailableMessage(paradisSpeechEngineAvailability(platform, environmentService.os.release));
		this.region = new ParadisAgentChatTranscriptRegion(target.textarea);
		this.button = append(target.container, $('button.paradis-agent-chat-mic')) as HTMLButtonElement;
		this.button.type = 'button';
		this._register(hoverService.setupDelayedHover(this.button, () => ({ content: this.label() })));
		this._register(addDisposableListener(this.button, EventType.CLICK, () => this.toggle()));
		// マウスで押しても入力欄のフォーカスとカーソルの位置を奪わない
		this._register(addDisposableListener(this.button, EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._register(addDisposableListener(target.textarea, EventType.INPUT, () => {
			if (this.active) {
				this.region.userEdited();
			}
		}));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DICTATION_ENABLED_SETTING)) {
				this.update();
			}
		}));
		this._register(speechToTextService.onDidChangeState(state => {
			// 失敗・別の入口からの取り消しで終わった
			if (this.active && !this.stopping && state === ChatSpeechToTextState.Idle) {
				this.end();
			}
			this.update();
		}));
		this.update();
	}

	detach(): void {
		if (!this.active) {
			return;
		}
		this.stopping = true;
		void this.speechToTextService.stopAndTranscribe();
		this.end();
	}

	override dispose(): void {
		this.detach();
		super.dispose();
	}

	private label(): string {
		if (this.active) {
			return localize('paradisAgentChat.dictationStop', "音声入力を止める");
		}
		return this.unavailableMessage ?? localize('paradisAgentChat.dictationStart', "音声入力");
	}

	private update(): void {
		const visible = paradisAgentChatShowsMicrophone(this.configurationService.inspect<boolean>(DICTATION_ENABLED_SETTING), this.unavailableMessage !== undefined);
		this.button.style.display = visible ? '' : 'none';
		this.button.classList.toggle('active', this.active);
		this.button.classList.toggle('unavailable', this.unavailableMessage !== undefined);
		this.button.replaceChildren(renderIcon(this.active ? Codicon.debugStop : Codicon.mic));
		this.button.setAttribute('aria-label', this.label());
		this.button.setAttribute('aria-pressed', String(this.active));
	}

	private async toggle(): Promise<void> {
		if (this.active) {
			await this.finish();
			return;
		}
		if (this.unavailableMessage !== undefined) {
			this.target.showNotice(this.unavailableMessage);
			return;
		}
		if (this.speechToTextService.isBusy) {
			this.target.showNotice(localize('paradisAgentChat.dictationBusy', "ほかの場所で音声入力をしています。終わってからもう一度押してください"));
			return;
		}
		this.target.showNotice(undefined);
		this.target.textarea.focus();
		this.region.begin();
		this.active = true;
		this.session.add(this.speechToTextService.onDidUpdateTranscript(transcript => {
			if (this.active) {
				this.region.render(transcript.text);
				this.target.didEdit();
			}
		}));
		this.update();
		try {
			await this.speechToTextService.start(getWindow(this.button), 'editor');
		} catch (error) {
			this.end();
			this.target.showNotice(toErrorMessage(error));
			return;
		}
		// 始められなかった（理由は upstream が通知で出す）
		if (this.active && this.speechToTextService.state === ChatSpeechToTextState.Idle) {
			this.end();
		}
	}

	private async finish(): Promise<void> {
		this.stopping = true;
		this.update();
		try {
			const text = await this.speechToTextService.stopAndTranscribe();
			if (this.active && text !== undefined) {
				this.region.render(text);
				this.target.didEdit();
			}
		} finally {
			this.end();
			this.target.textarea.focus();
		}
	}

	private end(): void {
		this.active = false;
		this.stopping = false;
		this.session.clear();
		this.update();
	}
}
