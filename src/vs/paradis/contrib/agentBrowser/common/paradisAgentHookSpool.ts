/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code が止まっている間（更新・再起動の最中）に届かなかった hook の控え（W2-20）。
//
// notify スクリプトは、受け口に届かなかった hook を `<userData>/agent-hook-spool/pane-<ハッシュ>.jsonl`
// に 1 行ずつ書く（ハッシュはペイントークンの SHA-256。トークンそのものはディスクに書かない）。
// Para Code は起動してペインの同期が済んだ後に、生きているペインの分だけを読んで流し直す。
//
// 流し直しの決まり（Q116 A / Q20-1）:
//  - 状態は、控えのうち最後の 1 件で決める。
//  - 完了は「確認待ち」の印だけを付け、鳴らさない。
//  - 許可要求と質問は、最後の 1 件で、しかも 10 分以内のものだけを扱う。承認カードは、画面に
//    その確認が今も出ていることをウィンドウ側で確かめてから出す（再起動の後の画面を見ずに答えると、
//    別の確認に答えてしまう恐れがあるため）。
// ここは判断だけを持つ純関数の置き場。読み書きは node 側にある。

import { paradisNormalizeAgentHookEvent, ParadisAgentStatus } from './paradisAgentBrowser.js';

/** 控えの置き場（ポートファイルと同じフォルダの下）。 */
export const PARADIS_AGENT_HOOK_SPOOL_DIR_NAME = 'agent-hook-spool';
/** 1 ファイルの上限。これを超える書き足しはスクリプトが諦める。 */
export const PARADIS_AGENT_HOOK_SPOOL_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** ファイル数の上限。 */
export const PARADIS_AGENT_HOOK_SPOOL_MAX_FILES = 1024;
/** これより古い控えは捨てる。 */
export const PARADIS_AGENT_HOOK_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** payload を控える大きさの上限（これを超えるものはイベント名と時刻だけを控える）。 */
export const PARADIS_AGENT_HOOK_SPOOL_MAX_PAYLOAD_BYTES = 256 * 1024;
/** 許可要求・質問を流し直してよい古さ。 */
export const PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS = 10 * 60 * 1000;

/**
 * 控えないイベント。ツールの開始・終了と応答の途中経過は数が多く、再起動の後には transcript から
 * 同じことが分かるので控えない（Orca も Pre/PostToolUse を控えない）。
 */
export const PARADIS_AGENT_HOOK_SPOOL_SKIPPED_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'MessageDisplay'];

/** 控えの 1 行。 */
export interface IParadisSpooledAgentHook {
	readonly event: string;
	/** hook が起きた時刻（epoch ミリ秒）。 */
	readonly at: number;
	readonly payload: Readonly<Record<string, unknown>> | undefined;
}

/**
 * 控えのファイルを読む。壊れた行・古すぎる行・控えないはずのイベントは捨て、時刻順に並べる。
 * 1 行の形は `{"v":1,"event":"Stop","t":<epoch 秒>,"payload":<hook の JSON か null>}`。
 */
export function paradisParseAgentHookSpool(text: string, now: number): IParadisSpooledAgentHook[] {
	const records: IParadisSpooledAgentHook[] = [];
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) {
			continue;
		}
		let parsed: { v?: unknown; event?: unknown; t?: unknown; payload?: unknown };
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed?.v !== 1 || typeof parsed.event !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(parsed.event) || typeof parsed.t !== 'number' || !Number.isFinite(parsed.t)) {
			continue;
		}
		const at = parsed.t * 1000;
		if (at > now + 60_000 || now - at > PARADIS_AGENT_HOOK_SPOOL_MAX_AGE_MS || PARADIS_AGENT_HOOK_SPOOL_SKIPPED_EVENTS.includes(parsed.event)) {
			continue;
		}
		const payload = typeof parsed.payload === 'object' && parsed.payload !== null && !Array.isArray(parsed.payload) ? parsed.payload as Record<string, unknown> : undefined;
		records.push({ event: parsed.event, at, payload });
	}
	// 同じ秒の中の並びは書いた順（安定ソート）。
	return records.sort((a, b) => a.at - b.at);
}

/** 流し直した結果として取る状態。 */
export type ParadisAgentHookReplayState =
	| { readonly kind: 'none' }
	| { readonly kind: 'status'; readonly status: Exclude<ParadisAgentStatus, 'permission' | 'question'> | 'idle'; readonly at: number; readonly quiet: boolean }
	| { readonly kind: 'prompt'; readonly status: 'permission' | 'question'; readonly record: IParadisSpooledAgentHook };

function stringField(record: IParadisSpooledAgentHook, name: string): string | undefined {
	const value = record.payload?.[name];
	return typeof value === 'string' ? value : undefined;
}

/** 控えの 1 件を状態へ直す（受け口の `_handleAgentHook` と同じ読み替え）。 */
export function paradisReplayedHookStatus(record: IParadisSpooledAgentHook): ParadisAgentStatus | 'idle' | undefined {
	const normalized = paradisNormalizeAgentHookEvent(record.event, stringField(record, 'message'));
	if (record.event === 'PermissionRequest' && stringField(record, 'tool_name') === 'AskUserQuestion') {
		return 'question';
	}
	return normalized;
}

/**
 * 控えから、流し直した後の状態を 1 つ決める。状態を変える最後の 1 件だけを見る。
 * 完了（review）は鳴らさない印（quiet）として返す。許可要求・質問は 10 分以内のときだけ返す
 * （それより古いものは、今も待っているかを控えからは言えないので何もしない）。
 */
export function paradisPlanAgentHookReplay(records: readonly IParadisSpooledAgentHook[], now: number): ParadisAgentHookReplayState {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		const status = paradisReplayedHookStatus(record);
		if (status === undefined) {
			continue;
		}
		if (status === 'permission' || status === 'question') {
			return now - record.at <= PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS
				? { kind: 'prompt', status, record }
				: { kind: 'none' };
		}
		return { kind: 'status', status, at: record.at, quiet: status === 'review' };
	}
	return { kind: 'none' };
}

/** ウィンドウ側へ渡す「画面で確かめてほしい確認」。 */
export interface IParadisReplayedAgentPrompt {
	readonly token: string;
	readonly status: 'permission' | 'question';
}
