/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { PARADIS_CLAUDE_SETTING_VALUE_PATTERN } from './paradisAgentSlashCommand.js';

/** モバイルからのエージェントの操作（shared process が新しさを確かめてからウィンドウへ回すもの）に共通の項目。 */
interface IParadisMobileAgentActionBase {
	readonly id: number;
	readonly token: string;
	readonly requestId: string;
	readonly epoch: string;
	readonly windowId: number;
	/**
	 * 種類ごとの任意の項目。形はそれぞれを使う所の読み手（`paradisReadSlashCheck` など）が確かめるので、ここでは見ない
	 * （ここで断ると、古いアプリ・新しいアプリが送る形を受けられなくなる）。
	 */
	readonly agent?: unknown;
	readonly slashCheck?: unknown;
	readonly interaction?: unknown;
	readonly expectOption?: unknown;
	readonly expectPromptHash?: unknown;
	readonly approvalPiece?: unknown;
	readonly questionChecks?: unknown;
}

/** 発言を送る。 */
export interface IParadisMobileAgentSendMessage extends IParadisMobileAgentActionBase {
	readonly kind: 'sendMessage';
	readonly text: string;
}

/** Claude Code のモデル・effort を変える。 */
export interface IParadisMobileAgentClaudeSetting extends IParadisMobileAgentActionBase {
	readonly kind: 'claudeSetting';
	readonly setting: 'model' | 'effort';
	readonly value: string;
}

/** PC で開いている画面（/config など）を Esc で閉じる。 */
export interface IParadisMobileAgentClosePanel extends IParadisMobileAgentActionBase {
	readonly kind: 'closePanel';
}

/** 質問・承認に答えるキーを打つ。 */
export interface IParadisMobileAgentInteraction extends IParadisMobileAgentActionBase {
	readonly kind: 'interaction';
	readonly parts: readonly string[];
	readonly delayMs: number;
	readonly readyMarker?: string;
}

export type ParadisMobileAgentAction = IParadisMobileAgentSendMessage | IParadisMobileAgentClaudeSetting | IParadisMobileAgentClosePanel | IParadisMobileAgentInteraction;

function isIntegerNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value);
}

/**
 * JSON として読んだ `action/sendMessage`・`action/claudeSetting`・`action/closePanel`・`action/interaction` の要求を、
 * 種類ごとの形に読む。形が合わなければ `undefined`（そのまま捨てる）。`action/approvalOptions` は扱わない。
 */
export function paradisDecodeMobileAgentAction(value: unknown): ParadisMobileAgentAction | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const msg = value as { readonly [key: string]: unknown };
	const { t, id, token, requestId, epoch, windowId } = msg;
	if (!isIntegerNumber(windowId) || typeof id !== 'number' || typeof token !== 'string' || typeof requestId !== 'string' || typeof epoch !== 'string') {
		return undefined;
	}
	const base: IParadisMobileAgentActionBase = {
		id, token, requestId, epoch, windowId,
		agent: msg.agent,
		slashCheck: msg.slashCheck,
		interaction: msg.interaction,
		expectOption: msg.expectOption,
		expectPromptHash: msg.expectPromptHash,
		approvalPiece: msg.approvalPiece,
		questionChecks: msg.questionChecks,
	};
	if (t === 'action/sendMessage' && typeof msg.text === 'string') {
		return { ...base, kind: 'sendMessage', text: msg.text };
	}
	const { setting, value: settingValue } = msg;
	if (t === 'action/claudeSetting' && (setting === 'model' || setting === 'effort') && typeof settingValue === 'string' && PARADIS_CLAUDE_SETTING_VALUE_PATTERN.test(settingValue)) {
		return { ...base, kind: 'claudeSetting', setting, value: settingValue };
	}
	if (t === 'action/closePanel') {
		return { ...base, kind: 'closePanel' };
	}
	const { parts, delayMs, readyMarker } = msg;
	if (t === 'action/interaction' && Array.isArray(parts) && parts.length > 0 && parts.length <= 500
		&& parts.every(part => typeof part === 'string' && part.length <= 10_000)
		&& isIntegerNumber(delayMs) && delayMs >= 0 && delayMs <= 1_000
		&& (readyMarker === undefined || (typeof readyMarker === 'string' && readyMarker.length > 0 && readyMarker.length <= 64))) {
		return { ...base, kind: 'interaction', parts: parts as string[], delayMs, ...(readyMarker !== undefined ? { readyMarker } : {}) };
	}
	return undefined;
}
