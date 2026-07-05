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
