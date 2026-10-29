/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import { PARADIS_CODEX_OVERLOAD_CONTINUE_TEXT, ParadisCodexAutoContinuePhase } from '../common/paradisCodexOverloadContinue.js';

/** shared process からの「自動で continue を送って」（`ParadisMobileAgentChat` の Codex の混み合いの続き）。 */
export interface IParadisCodexAutoContinueRequest {
	readonly t: 'action/autoContinue';
	readonly id: number;
	readonly token: string;
	readonly requestId: string;
	/** 失敗したターンが終わった時刻。これより後にペインへ打鍵があれば送らない（書きかけにつながる）。 */
	readonly since: number;
}

/** 端末のフォーカスの報告（`ESC [ I` / `ESC [ O`）。利用者の入力ではない。 */
const FOCUS_REPORT = /^(?:\x1b\[[IO])+$/;

/** 読めた中身が自動の continue の依頼か。 */
export function paradisReadCodexAutoContinueRequest(value: unknown): IParadisCodexAutoContinueRequest | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const msg = value as Record<string, unknown>;
	return msg.t === 'action/autoContinue' && typeof msg.id === 'number' && Number.isInteger(msg.id)
		&& typeof msg.token === 'string' && msg.token.length > 0 && typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 64
		&& typeof msg.since === 'number' && Number.isFinite(msg.since)
		? { t: 'action/autoContinue', id: msg.id, token: msg.token, requestId: msg.requestId, since: msg.since }
		: undefined;
}

/**
 * ウィンドウ側で、自動の continue をペインへ打つ。打つ前に shared process に引き受けを確かめ（待つ間にユーザーが送って
 * いたら断られる）、失敗したターンの後にペインへ打鍵があったら打たない。
 */
export class ParadisCodexAutoContinueWindow extends Disposable {
	/** ペイン（instanceId）→ 最後に利用者の入力があった時刻。 */
	private readonly lastInputAt = new Map<number, number>();

	constructor(
		terminalService: Pick<ITerminalService, 'createOnInstanceEvent' | 'onDidDisposeInstance'>,
		private readonly findInstance: (instanceId: number, token: string) => ITerminalInstance | undefined,
		private readonly report: (token: string, requestId: string, phase: ParadisCodexAutoContinuePhase) => Promise<boolean>,
		private readonly now: () => number = Date.now,
	) {
		super();
		const inputs = this._register(terminalService.createOnInstanceEvent(instance => Event.map(instance.onDidInputData, data => ({ instanceId: instance.instanceId, data }))));
		this._register(inputs.event(({ instanceId, data }) => {
			if (!FOCUS_REPORT.test(data)) {
				this.lastInputAt.set(instanceId, this.now());
			}
		}));
		this._register(terminalService.onDidDisposeInstance(instance => this.lastInputAt.delete(instance.instanceId)));
	}

	async handle(request: IParadisCodexAutoContinueRequest): Promise<void> {
		const instance = this.findInstance(request.id, request.token);
		if (instance === undefined) {
			return; // このウィンドウのペインではない
		}
		if ((this.lastInputAt.get(instance.instanceId) ?? 0) > request.since) {
			await this.report(request.token, request.requestId, 'typed');
			return;
		}
		if (!(await this.report(request.token, request.requestId, 'claim'))) {
			return; // 待つ間に取りやめた
		}
		const outcome = await paradisSendAgentMessageToTui(
			PARADIS_CODEX_OVERLOAD_CONTINUE_TEXT,
			(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
			async () => this.findInstance(request.id, request.token) === instance,
		);
		if (!outcome.executed) {
			await this.report(request.token, request.requestId, 'failed');
		}
	}
}
