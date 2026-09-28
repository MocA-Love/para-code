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
// 流し直しの決まり（Q116 A / Q20-1、レビュー M3〜M5）:
//  - 控えるのは、受け口に届かなかったときと、受け口が「そのペインはまだ同期していない」（503）と
//    答えたときだけ。知らない・終わったペインへの hook（404）は控えない（永久に控え続けないため）。
//  - 控えに残すのは状態の判断に要るもの（イベント名・session_id・transcript_path・cwd・tool_name、
//    許可要求の通知かどうか）だけ。依頼の文面やツールの入力の中身は残さない。
//  - 流し直すのは、前の Para Code が最後に生きていた時刻より後で、しかも 1 時間以内のものだけ。
//    それより前のものは、受け口の返事が遅れて控えてしまった重複の恐れがある。同じ hook の ID が
//    この起動で既に届いていれば流さない。
//  - 状態は、控えのうち最後の 1 件で決める。「作業中」は流し直さない（今も作業中かは控えから言えない）。
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
/** 許可要求・質問を流し直してよい古さ。 */
export const PARADIS_AGENT_HOOK_REPLAY_PROMPT_WINDOW_MS = 10 * 60 * 1000;
/** そもそも流し直してよい古さ。 */
export const PARADIS_AGENT_HOOK_REPLAY_MAX_AGE_MS = 60 * 60 * 1000;
/**
 * 前の Para Code が生きていたことを書き残す間隔（`alive` ファイル）。
 *
 * shared process は終了のときに dispose されない（実機で確認、2026-09-29）ので、閉じるときの書き込みは
 * 当てにできない。終了の仕組みに新しい依頼を足すより、間隔を短くして境目のずれ（この間に控えた重複が
 * 流れうる幅）を 15 秒に抑える方を選んだ。書くのは数字 1 つで、15 秒ごとでも負担は無い。
 */
export const PARADIS_AGENT_HOOK_SPOOL_ALIVE_INTERVAL_MS = 15 * 1000;
/** 前の Para Code が生きていた最後の時刻を書き残すファイル名（控えのフォルダの中）。 */
export const PARADIS_AGENT_HOOK_SPOOL_ALIVE_FILE = 'alive';
/**
 * 受け口が、トークンを知らなくても「まだ同期していないだけ」と答える時間。shared process の起動と、
 * ウィンドウがつながってからこの間は 503 を返し、hook は控えに回る。それを過ぎて知らないトークンは 404。
 */
export const PARADIS_AGENT_HOOK_SYNC_GRACE_MS = 60 * 1000;
/** hook の ID（notify スクリプトが 1 回ごとに振る）の形。 */
export const PARADIS_AGENT_HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** hook の ID を渡すクエリ名。 */
export const PARADIS_AGENT_HOOK_ID_PARAM = 'hid';

/**
 * 控えないイベント。ツールの開始・終了と応答の途中経過は数が多く、再起動の後には transcript から
 * 同じことが分かるので控えない（Orca も Pre/PostToolUse を控えない）。
 */
export const PARADIS_AGENT_HOOK_SPOOL_SKIPPED_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'MessageDisplay'];

/** 控えの 1 行。 */
export interface IParadisSpooledAgentHook {
	/** hook の ID（無い行もある）。 */
	readonly id?: string;
	readonly event: string;
	/** hook が起きた時刻（epoch ミリ秒）。 */
	readonly at: number;
	readonly payload: Readonly<Record<string, unknown>> | undefined;
}

/**
 * 控えのファイルを読む。壊れた行・古すぎる行・`after` より前の行・控えないはずのイベント・同じ ID の
 * 2 度目は捨て、時刻順に並べる。1 行の形は
 * `{"v":1,"id":"<ID>","event":"Stop","t":<epoch 秒>,"payload":<状態の判断に要る項目だけのオブジェクト>}`。
 */
export function paradisParseAgentHookSpool(text: string, now: number, after: number = 0): IParadisSpooledAgentHook[] {
	const seenIds = new Set<string>();
	const records: IParadisSpooledAgentHook[] = [];
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) {
			continue;
		}
		let parsed: { v?: unknown; id?: unknown; event?: unknown; t?: unknown; payload?: unknown };
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed?.v !== 1 || typeof parsed.event !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(parsed.event) || typeof parsed.t !== 'number' || !Number.isFinite(parsed.t)) {
			continue;
		}
		const at = parsed.t * 1000;
		if (at > now + 60_000 || now - at > Math.min(PARADIS_AGENT_HOOK_SPOOL_MAX_AGE_MS, PARADIS_AGENT_HOOK_REPLAY_MAX_AGE_MS) || at < after || PARADIS_AGENT_HOOK_SPOOL_SKIPPED_EVENTS.includes(parsed.event)) {
			continue;
		}
		const id = typeof parsed.id === 'string' && PARADIS_AGENT_HOOK_ID_PATTERN.test(parsed.id) ? parsed.id : undefined;
		if (id !== undefined) {
			if (seenIds.has(id)) {
				continue;
			}
			seenIds.add(id);
		}
		const payload = typeof parsed.payload === 'object' && parsed.payload !== null && !Array.isArray(parsed.payload) ? parsed.payload as Record<string, unknown> : undefined;
		records.push({ ...(id !== undefined ? { id } : {}), event: parsed.event, at, payload });
	}
	// 同じ秒の中の並びは書いた順（安定ソート）。
	return records.sort((a, b) => a.at - b.at);
}

/** 流し直した結果として取る状態。 */
export type ParadisAgentHookReplayState =
	| { readonly kind: 'none' }
	| { readonly kind: 'status'; readonly status: 'review' | 'idle'; readonly at: number; readonly quiet: boolean }
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
 * （それより古いものは、今も待っているかを控えからは言えないので何もしない）。作業中（working）は
 * 流し直さない（控えの後にもう終わっているかもしれず、確かめる手段が無い）。
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
		if (status === 'working') {
			return { kind: 'none' };
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
