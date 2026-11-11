/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 終わったエージェントの休止（paradis.agentHibernation.enabled・idleMinutes）が働いているかを Sentry で読めるようにする
// （q.html Q611）。休止を試みた 1 回ごとに `para.agentHibernation.hibernate`、起こした 1 回ごとに
// `para.agentHibernation.resume` の時間の無い transaction を送る（休止は 1 つのタブで数十分に 1 回までなので、まとめない）。
//
// renderer から送るので、値は span を作るときに全部渡す（await の後に足すと失われる）。送るのは決まった語・回数・ミリ秒と
// 設定の値だけ。会話の ID・タブの名前・フォルダは送らない。`session` は Sentry が消す語なので、理由の語は言い換える。

import { ParadisSpanAttributes, recordParadisUsageSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisUsageSwitch } from '../../sentry/common/paradisUsageTally.js';
import { ParadisHibernationRefusal } from './paradisAgentHibernation.js';

/** 休止を試みた結末。shared process が断った理由に、窓の側の失敗を足したもの。 */
export type ParadisHibernationAttemptOutcome =
	| 'ok'
	/** 再開の台帳に会話が無く、印を付けられなかった（止めていない）。 */
	| 'no_ledger'
	/** shared process へ頼めなかった（IPC の失敗）。 */
	| 'ipc_failed'
	| ParadisHibernationRefusalWord;

/** shared process の断りの理由を送る語にする。 */
const REFUSAL_WORDS = {
	'not-eligible': 'not_eligible',
	'remote': 'remote',
	'no-session': 'no_conversation',
	'session-changed': 'conversation_changed',
	'status-changed': 'status_changed',
	'awaiting-user': 'awaiting_user',
	'no-owner': 'no_owner',
	'owner-not-alive': 'owner_not_alive',
	'daemon-hosted': 'daemon_hosted',
	'outside-pane': 'outside_pane',
	'background-shell': 'background_shell',
	'no-snapshot': 'no_snapshot',
	'kill-failed': 'kill_failed',
} as const satisfies Record<ParadisHibernationRefusal, string>;

type ParadisHibernationRefusalWord = typeof REFUSAL_WORDS[ParadisHibernationRefusal];

/** 断りの理由の語（テストが Sentry に消されないかを全部確かめる）。 */
export const PARADIS_HIBERNATION_REFUSAL_WORDS: readonly string[] = Object.values(REFUSAL_WORDS);

export function paradisHibernationRefusalWord(reason: ParadisHibernationRefusal): ParadisHibernationRefusalWord {
	return REFUSAL_WORDS[reason] ?? 'not_eligible';
}

/** 送るときの設定の値。 */
export interface IParadisHibernationSettings {
	readonly enabled: boolean;
	/** 休止までの分（設定の値を範囲に収めたもの）。 */
	readonly idleMinutes: number;
}

function settingAttributes(settings: IParadisHibernationSettings): ParadisSpanAttributes {
	return {
		safe_set_enabled: paradisUsageSwitch(settings.enabled),
		safe_set_idle_minutes: Math.round(settings.idleMinutes),
	};
}

function ms(value: number | undefined): number {
	return value === undefined || !Number.isFinite(value) ? -1 : Math.max(0, Math.round(value));
}

/** `para.agentHibernation.hibernate` の値。`idleMs` は最後に見た・触った・終わった時刻から止めるまで。 */
export function paradisHibernationAttemptAttributes(outcome: ParadisHibernationAttemptOutcome, settings: IParadisHibernationSettings, idleMs: number | undefined, detail?: { readonly killed: boolean; readonly bypass: boolean }): ParadisSpanAttributes {
	return {
		...settingAttributes(settings),
		safe_outcome: outcome,
		safe_idle_ms: ms(idleMs),
		...(detail !== undefined ? { safe_sigkill: detail.killed, safe_bypass: detail.bypass } : {}),
	};
}

/**
 * 再開を試みた結果（electron-browser/paradisAgentHibernationController.ts の `ParadisHibernationResumeOutcome` と同じ並び。
 * common から electron-browser を読めないので写してある。食い違えば controller の呼び出しが型で落ちる）。
 */
export type ParadisHibernationResumeOutcomeName = 'sent' | 'no-offer' | 'no-shell-integration' | 'not-at-prompt' | 'folder-missing' | 'unknown-shell' | 'typed' | 'folder-change-failed' | 'busy' | 'failed';

/** 起こした結末の語（`sent` 以外は送れなかった理由）。 */
const RESUME_WORDS = {
	'sent': 'sent',
	'no-offer': 'no_offer',
	'no-shell-integration': 'no_shell_integration',
	// `prompt` は Sentry が値ごと消す語なので言い換える
	'not-at-prompt': 'not_at_shell_input',
	'folder-missing': 'folder_missing',
	'unknown-shell': 'unknown_shell',
	'typed': 'typed',
	'folder-change-failed': 'folder_change_failed',
	'busy': 'busy',
	'failed': 'failed',
} as const satisfies Record<ParadisHibernationResumeOutcomeName, string>;

/** 起こした結末の語（テストが Sentry に消されないかを全部確かめる）。 */
export const PARADIS_HIBERNATION_RESUME_WORDS: readonly string[] = [...Object.values(RESUME_WORDS), 'error'];

/**
 * `para.agentHibernation.resume` の値。`hibernatedMs` は止めてから起こすまで（再起動をまたいで分からなければ -1）、
 * `inputs` は休止中のタブへ打たれた入力の数。
 */
export function paradisHibernationResumeAttributes(outcome: ParadisHibernationResumeOutcomeName | 'error', trigger: 'visible' | 'mobile', settings: IParadisHibernationSettings, hibernatedMs: number | undefined, inputs: number): ParadisSpanAttributes {
	return {
		...settingAttributes(settings),
		safe_outcome: outcome === 'error' ? 'error' : RESUME_WORDS[outcome] ?? 'failed',
		safe_trigger: trigger,
		safe_hibernated_ms: ms(hibernatedMs),
		safe_inputs_while_hibernated: Math.max(0, Math.round(inputs)),
	};
}

/** 1 件の transaction として送る（renderer で await の後に呼んでも値が残るよう、作るときに全部渡す）。 */
export function recordParadisHibernation(operation: 'hibernate' | 'resume', attributes: ParadisSpanAttributes): void {
	recordParadisUsageSpan('agentHibernation', operation, attributes);
}
