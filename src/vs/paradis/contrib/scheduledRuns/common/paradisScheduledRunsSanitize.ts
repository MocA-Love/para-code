/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャネル越しに届いた値の形を確かめる。shared process はどのウィンドウからの呼び出しも
// 受けるので、型の上で正しくても実行時の形は信じない。

import {
	IParadisScheduledRunDraft,
	IParadisScheduledRunReport,
	IParadisScheduledRunSpace,
	IParadisScheduledRunTarget,
	ParadisScheduledRunReason,
} from './paradisScheduledRuns.js';

const REPORT_STATUSES: ReadonlySet<string> = new Set(['running', 'needsAttention', 'completed', 'timedOut', 'failed', 'cancelled']);
const REASONS: ReadonlySet<string> = new Set<ParadisScheduledRunReason>([
	'dailyLimit', 'overlap', 'tooSoon', 'missedTooOld', 'noWindowTooOld', 'disabled', 'deleted',
	'timeoutWhileWaiting', 'timeoutNoStatus', 'timeout', 'terminalClosed', 'windowClosed', 'userStopped',
	'repositoryMissing', 'launchFailed', 'heartbeatLost',
]);

/** 記録に残す詳細文の上限。 */
const MAX_DETAIL_LENGTH = 500;
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max = MAX_ID_LENGTH): string | undefined | false {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	return typeof value === 'string' && value.length <= max ? value : false;
}

function sanitizeTarget(value: unknown): IParadisScheduledRunTarget | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { kind, repositoryUri, repositoryName } = value;
	const baseRef = optionalString(value.baseRef);
	if ((kind !== 'repository' && kind !== 'newSpace')
		|| typeof repositoryUri !== 'string' || repositoryUri.length === 0 || repositoryUri.length > 2000
		|| typeof repositoryName !== 'string' || repositoryName.length > 200
		|| baseRef === false) {
		return undefined;
	}
	return { kind, repositoryUri, repositoryName, ...(baseRef !== undefined ? { baseRef } : {}) };
}

/** 画面から届いた下書き。形が違えば undefined（中身の妥当性は `paradisValidateScheduledRunDraft` で見る）。 */
export function paradisSanitizeScheduledRunDraft(value: unknown): IParadisScheduledRunDraft | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { name, schedule, agentId, prompt, dailyLimit } = value;
	const id = optionalString(value.id);
	const modelId = optionalString(value.modelId);
	const effortId = optionalString(value.effortId);
	const permissionId = optionalString(value.permissionId);
	const target = sanitizeTarget(value.target);
	if (typeof name !== 'string' || name.length > MAX_TEXT_LENGTH
		|| typeof schedule !== 'string' || schedule.length > 200
		|| typeof agentId !== 'string' || agentId.length > MAX_ID_LENGTH
		|| typeof prompt !== 'string' || prompt.length > MAX_TEXT_LENGTH
		|| typeof dailyLimit !== 'number'
		|| id === false || modelId === false || effortId === false || permissionId === false
		|| !target) {
		return undefined;
	}
	return {
		...(id !== undefined ? { id } : {}),
		name, schedule, agentId, prompt, dailyLimit, target,
		...(modelId !== undefined ? { modelId } : {}),
		...(effortId !== undefined ? { effortId } : {}),
		...(permissionId !== undefined ? { permissionId } : {}),
	};
}

function sanitizeSpace(value: unknown): IParadisScheduledRunSpace | undefined | false {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		return false;
	}
	const { stateKey, name, branch, uri } = value;
	if (typeof stateKey !== 'string' || stateKey.length > 2000
		|| typeof name !== 'string' || name.length > 500
		|| typeof branch !== 'string' || branch.length > 500
		|| typeof uri !== 'string' || uri.length > 2000) {
		return false;
	}
	return { stateKey, name, branch, uri };
}

/** ウィンドウから届いた状態の報告。 */
export function paradisSanitizeScheduledRunReport(value: unknown): IParadisScheduledRunReport | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { runId, status, reason, detail, sawAgentStatus, paneToken } = value;
	const space = sanitizeSpace(value.space);
	if (typeof runId !== 'string' || runId.length > MAX_ID_LENGTH
		|| typeof status !== 'string' || !REPORT_STATUSES.has(status)
		|| (reason !== undefined && (typeof reason !== 'string' || !REASONS.has(reason)))
		|| (detail !== undefined && typeof detail !== 'string')
		|| (sawAgentStatus !== undefined && typeof sawAgentStatus !== 'boolean')
		|| (paneToken !== undefined && (typeof paneToken !== 'string' || paneToken.length === 0 || paneToken.length > MAX_ID_LENGTH))
		|| space === false) {
		return undefined;
	}
	return {
		runId,
		status: status as IParadisScheduledRunReport['status'],
		...(reason !== undefined ? { reason: reason as ParadisScheduledRunReason } : {}),
		...(typeof detail === 'string' ? { detail: detail.slice(0, MAX_DETAIL_LENGTH) } : {}),
		...(space !== undefined ? { space } : {}),
		...(sawAgentStatus === true ? { sawAgentStatus } : {}),
		...(typeof paneToken === 'string' ? { paneToken } : {}),
	};
}
