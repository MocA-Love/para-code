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
	/** 受信時刻（epoch ms）。 */
	readonly at: number;
}

const emitter = new Emitter<IParadisAgentHookEvent>();

/** hookイベントの購読（shared process 内限定）。 */
export const onParadisAgentHookEvent: Event<IParadisAgentHookEvent> = emitter.event;

/** hookイベントの発火（ParadisAgentBrowserService の /agent-hook ハンドラ専用）。 */
export function fireParadisAgentHookEvent(event: IParadisAgentHookEvent): void {
	emitter.fire(event);
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
const BACKGROUND_TASK_STALE_MS = 60 * 60 * 1000;

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

/**
 * 実行中とみなせるバックグラウンドタスク数。完了通知(task-notification)を取りこぼした
 * エントリで 'working' が永久に残らないよう、古すぎるものは数えない。
 */
export function paradisCountLiveBackgroundTasks(token: string, now: number): number {
	let count = 0;
	for (const openedAt of getParadisAgentPaneActivity(token).backgroundTasks.values()) {
		if (now - openedAt < BACKGROUND_TASK_STALE_MS) {
			count++;
		}
	}
	return count;
}
