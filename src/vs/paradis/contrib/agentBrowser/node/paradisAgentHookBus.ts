/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process 内のエージェントhookイベントバス。
// ParadisAgentBrowserService (/agent-hook HTTPエンドポイント) が発火し、
// ParadisMobileAgentChat (mobileRelay) 等が購読する。両サービスは sharedProcessMain.ts で
// 独立に register されるため、モジュールシングルトンの Emitter で疎結合に接続する
// （同一プロセス内でのみ成立する前提。IPC は介さない）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { PARADIS_AGENT_BACKGROUND_TASK_STALE_MS } from '../common/paradisAgentStatusStale.js';

/** notify.sh (v2) がPOSTするhook JSONから抽出した、1回のhook発火の内容。 */
export interface IParadisAgentHookEvent {
	/** ペイントークン（PARA_CODE_TERMINAL_PANE_ID）。ターミナルペインの識別子。 */
	readonly token: string;
	/** hookイベント名（SessionStart / Stop / PermissionRequest 等、CLI固有の生の名前）。 */
	readonly event: string;
	/** hook stdin JSON の session_id（Claude Code / Codex とも全イベントで入る）。 */
	readonly sessionId: string | undefined;
	/** hook stdin JSON の transcript_path（Claude: ~/.claude/projects/**.jsonl、Codex: rollout）。 */
	readonly transcriptPath: string | undefined;
	/** hook stdin JSON の cwd。 */
	readonly cwd: string | undefined;
	/** hook stdin JSON の tool_name（PreToolUse / PostToolUse のみ）。 */
	readonly toolName?: string;
	/** hook stdin JSON の tool_input（PreToolUse のみ。AskUserQuestion のライブ質問検出に使う）。 */
	readonly toolInput?: unknown;
	/** hook stdin JSON の tool_use_id（ツール開始・完了の対応付け。未提供のCLIもある）。 */
	readonly toolUseId?: string;
	/** MessageDisplay: 同一assistantメッセージで安定するID。 */
	readonly messageId?: string;
	/** MessageDisplay: 今回新たに完成した行のバッチ。 */
	readonly messageDelta?: string;
	/** MessageDisplay: 同一メッセージ内の0起点バッチ番号。 */
	readonly messageIndex?: number;
	/** MessageDisplay: 最後のバッチか。 */
	readonly messageFinal?: boolean;
	/** イベント固有フィールドを保持した、サイズ制限済みのhook stdin JSON。 */
	readonly payload?: Readonly<Record<string, unknown>>;
	/** 受信時刻（epoch ms）。 */
	readonly at: number;
}

const HOOK_PAYLOAD_MAX_DEPTH = 5;
const HOOK_PAYLOAD_MAX_ENTRIES = 100;
const HOOK_PAYLOAD_MAX_STRING = 10_000;

function sanitizeHookValue(value: unknown, depth: number): unknown {
	if (typeof value === 'string') {
		return value.slice(0, HOOK_PAYLOAD_MAX_STRING);
	}
	if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
		return value;
	}
	if (depth >= HOOK_PAYLOAD_MAX_DEPTH) {
		return Array.isArray(value) ? [] : {};
	}
	if (Array.isArray(value)) {
		return value.slice(0, HOOK_PAYLOAD_MAX_ENTRIES).map(entry => sanitizeHookValue(entry, depth + 1));
	}
	if (typeof value === 'object' && value !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value).slice(0, HOOK_PAYLOAD_MAX_ENTRIES)) {
			if (key !== '__proto__' && key !== 'prototype' && key !== 'constructor'
				&& entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol') {
				result[key.slice(0, 200)] = sanitizeHookValue(entry, depth + 1);
			}
		}
		return result;
	}
	return undefined;
}

/** hook固有payloadを転送可能なJSONオブジェクトへ制限する。 */
export function paradisSanitizeAgentHookPayload(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return sanitizeHookValue(value, 0) as Readonly<Record<string, unknown>>;
}

const emitter = new Emitter<IParadisAgentHookEvent>();

/** hookイベントの購読（shared process 内限定）。 */
export const onParadisAgentHookEvent: Event<IParadisAgentHookEvent> = emitter.event;

/** hookイベントの発火（ParadisAgentBrowserService の /agent-hook ハンドラ専用）。 */
export function fireParadisAgentHookEvent(event: IParadisAgentHookEvent): void {
	emitter.fire(event);
}

// --- ターン終了シグナル（transcript由来） ----------------------------------------------------------
//
// Codex の usage limit エラーや中断（turn_aborted）は Stop 系 hook を発火しないため、
// transcript（rollout JSONL）の event_msg が唯一の検出点。ParadisMobileAgentChat の tailer が
// 検出して発火し、ParadisAgentBrowserService がペイン実行状態（working の解除）に反映する。

const turnEndedEmitter = new Emitter<{ readonly token: string; readonly at: number }>();

/** transcript由来のターン終了の購読（shared process 内限定）。 */
export const onParadisAgentTurnEnded: Event<{ readonly token: string; readonly at: number }> = turnEndedEmitter.event;

/** transcript由来のターン終了の発火（ParadisMobileAgentChat の tailer 専用）。 */
export function fireParadisAgentTurnEnded(token: string): void {
	turnEndedEmitter.fire({ token, at: Date.now() });
}

// --- ペインアクティビティ（transcript由来の実行状態） ---------------------------------------------
//
// hookイベントだけでは分からない「transcriptを読まないと分からない状態」を、
// ParadisMobileAgentChat の tailer が学習してここへ書き込み、ParadisAgentBrowserService の
// ペイン実行状態 (working/permission/question/review) の判定材料にする:
//  - pendingQuestion: AskUserQuestion が回答待ち（同じ tool_use_id の tool_result 未出現）
//  - backgroundTasks: バックグラウンドのサブエージェント等が実行中（task-notification 未着）
// hookイベントバスと同じモジュールシングルトン方式（shared process 内限定）。

/** 1ペインのtranscript由来アクティビティ。 */
export interface IParadisAgentPaneActivity {
	/** 実行中バックグラウンドタスクID → 起動時刻 (epoch ms)。 */
	readonly backgroundTasks: ReadonlyMap<string, number>;
	/** 回答待ちの質問 (AskUserQuestion) があるか。 */
	readonly pendingQuestion: boolean;
}

/** 完了通知が来ないまま残ったバックグラウンドタスクを無視するまでの時間。 */
const activities = new Map<string, IParadisAgentPaneActivity>();
const activityEmitter = new Emitter<{ readonly token: string; readonly activity: IParadisAgentPaneActivity }>();

/** ペインアクティビティの変化の購読（shared process 内限定）。 */
export const onParadisAgentPaneActivity: Event<{ readonly token: string; readonly activity: IParadisAgentPaneActivity }> = activityEmitter.event;

/** ペインアクティビティの更新（ParadisMobileAgentChat の tailer 専用）。 */
export function setParadisAgentPaneActivity(token: string, activity: IParadisAgentPaneActivity): void {
	if (activity.backgroundTasks.size === 0 && !activity.pendingQuestion) {
		activities.delete(token);
	} else {
		activities.set(token, activity);
	}
	activityEmitter.fire({ token, activity });
}

/** 現在のペインアクティビティ（無ければ「何もしていない」）。 */
export function getParadisAgentPaneActivity(token: string): IParadisAgentPaneActivity {
	return activities.get(token) ?? { backgroundTasks: new Map(), pendingQuestion: false };
}

/** terminal/pane終了時にtoken由来のtranscript activityを即時破棄する。 */
export function clearParadisAgentPaneActivity(token: string): void {
	if (activities.delete(token)) {
		activityEmitter.fire({ token, activity: { backgroundTasks: new Map(), pendingQuestion: false } });
	}
}

/**
 * 実行中とみなせるバックグラウンドタスク数。完了通知(task-notification)を取りこぼした
 * エントリで 'working' が永久に残らないよう、古すぎるものは数えない。
 */
export function paradisCountLiveBackgroundTasks(token: string, now: number): number {
	let count = 0;
	for (const openedAt of getParadisAgentPaneActivity(token).backgroundTasks.values()) {
		if (now - openedAt < PARADIS_AGENT_BACKGROUND_TASK_STALE_MS) {
			count++;
		}
	}
	return count;
}
