/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
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

/**
 * 見出しを畳んだ側（{@link IParadisAgentChatService.setHeaderHidden}）の台帳。畳んだ側が返された IDisposable を dispose すると
 * 戻る。畳んだ側が戻し忘れても「ターミナルに戻る」と「最新を取得できていません」が見えないままにならないよう、ペインが閉じた・
 * チャット表示が閉じた・別の会話に替わったときも、そのペインの畳みを全部戻す（その後の dispose は何もしない）。
 */
export class ParadisAgentChatHeaderHides extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<number>());
	/** 畳むかどうかが変わったペイン。 */
	readonly onDidChange: Event<number> = this._onDidChange.event;
	/** ペインごとの、畳んでいる側と、畳んだときの会話（まだ無ければ undefined。最初に現れた会話を覚える）。 */
	private readonly holds = new Map<number, { readonly owners: Set<object>; token: string | undefined }>();

	isHidden(instanceId: number): boolean {
		return this.holds.has(instanceId);
	}

	/** 畳む。返り値を dispose すると、ほかに畳んでいる側が無ければ戻る。 */
	hide(instanceId: number, token: string | undefined): IDisposable {
		const owner = {};
		let entry = this.holds.get(instanceId);
		const changed = entry === undefined;
		if (entry === undefined) {
			entry = { owners: new Set(), token };
			this.holds.set(instanceId, entry);
		}
		entry.owners.add(owner);
		if (changed) {
			this._onDidChange.fire(instanceId);
		}
		return toDisposable(() => {
			const current = this.holds.get(instanceId);
			if (current?.owners.delete(owner) && current.owners.size === 0) {
				this.holds.delete(instanceId);
				this._onDidChange.fire(instanceId);
			}
		});
	}

	/** そのペインの畳みを全部戻す（ペインが閉じた・チャット表示が閉じた）。 */
	release(instanceId: number): void {
		if (this.holds.delete(instanceId)) {
			this._onDidChange.fire(instanceId);
		}
	}

	/** ペインの会話が替わっていたら、そのペインの畳みを全部戻す。 */
	checkTokens(tokenFor: (instanceId: number) => string | undefined): void {
		for (const [instanceId, entry] of [...this.holds]) {
			const token = tokenFor(instanceId);
			if (entry.token === undefined) {
				entry.token = token;
			} else if (token !== entry.token) {
				this.release(instanceId);
			}
		}
	}

	override dispose(): void {
		this.holds.clear();
		super.dispose();
	}
}
