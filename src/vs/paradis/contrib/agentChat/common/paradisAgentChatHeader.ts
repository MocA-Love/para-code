/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ParadisAgentKind, PARADIS_AGENT_DESCRIPTORS, paradisAgentDescriptor } from './paradisAgentDescriptor.js';
import { IParadisAgentChatState } from './paradisAgentChatState.js';
import { paradisPendingCodexQuestion } from './paradisAgentChatTimeline.js';

/** チャット表示の見出しに出すもの（{@link IParadisAgentChatService.headerState} で外へも出す）。 */
export interface IParadisAgentChatHeaderState {
	/** エージェントの種類。会話がまだ読めていなければ undefined。 */
	readonly agent: ParadisAgentKind | undefined;
	/** 画面に出す名前（「Claude Code」など）。会話がまだ読めていなければ空。 */
	readonly agentName: string;
	/** 会話の記録から取ったモデルと強さ（「claude-opus-4-5 · high」）。分からなければ空。 */
	readonly model: string;
	/** 状態の文（質問待ち・許可待ち・最新を取得できていない・終了・作業中）。何も無ければ空。 */
	readonly status: string;
	/** 利用者の対応が要る（質問・許可を待っている、最新を取得できていない）。 */
	readonly attention: boolean;
	/** 作業中（質問・許可を待っていない）。 */
	readonly busy: boolean;
}

export function paradisAgentChatHeaderState(state: IParadisAgentChatState | undefined): IParadisAgentChatHeaderState {
	const agentName = state === undefined ? '' : (paradisAgentDescriptor(state.agent) ?? PARADIS_AGENT_DESCRIPTORS.claude).displayName;
	const model = [state?.info?.model, state?.info?.effort].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');
	let status = '';
	if (state?.interaction?.kind === 'question' || (state?.agent === 'codex' && paradisPendingCodexQuestion(state.messages) !== undefined)) {
		status = localize('paradisAgentChat.statusQuestion', "質問に答えるのを待っています");
	} else if (state?.interaction?.kind === 'approval') {
		status = localize('paradisAgentChat.statusApproval', "許可を待っています");
	} else if (state?.info?.transcriptStale === true) {
		// SSH の接続先の会話を手元へ写せていない。下の会話は古いままのことがある
		status = localize('paradisAgentChat.statusStale', "この会話は最新を取得できていません");
	} else if (state?.agentExited) {
		status = localize('paradisAgentChat.statusExited', "終了しました");
	} else if (state?.busy) {
		status = localize('paradisAgentChat.statusBusy', "作業中");
	}
	const waiting = state?.interaction !== null && state?.interaction !== undefined;
	return {
		agent: state?.agent,
		agentName,
		model,
		status,
		attention: waiting || state?.info?.transcriptStale === true,
		busy: state?.busy === true && !waiting,
	};
}

/** 会話の写しの変化のうち、見出しに出すものが変わったときだけ知らせる。 */
export class ParadisAgentChatHeaderWatch extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private signature: string;

	constructor(private readonly session: { readonly state: IParadisAgentChatState | undefined; readonly onDidChange: Event<void> }) {
		super();
		this.signature = JSON.stringify(paradisAgentChatHeaderState(session.state));
		this._register(session.onDidChange(() => {
			const next = JSON.stringify(paradisAgentChatHeaderState(this.session.state));
			if (next !== this.signature) {
				this.signature = next;
				this._onDidChange.fire();
			}
		}));
	}
}
