/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Stop後のバックグラウンド補正が取り残された場合だけ完了へ降格するまでの時間。 */
const PARADIS_BACKGROUND_COMPLETION_STALE_MS = 15 * 60 * 1000;
/**
 * バックグラウンドタスクを「動いている」とみなす、最後に動いている印を見てからの時間。印はサブエージェントの hook
 * （`agent_id` 付き）・子の transcript の更新・Workflow の実行のフォルダの更新（paradisMobileAgentChat.ts）。
 * 印の拾えない Bash は起動からの時間。
 */
export const PARADIS_AGENT_BACKGROUND_TASK_STALE_MS = PARADIS_BACKGROUND_COMPLETION_STALE_MS;
/**
 * 印が途絶えても、完了の知らせ（task-notification）が無いサブエージェント・Workflow は「分からない」として
 * この時間までは動いている側に数える（印が無いだけで完了にしない）。過ぎたら知らせを取りこぼしたとみなす。
 */
export const PARADIS_AGENT_BACKGROUND_TASK_UNKNOWN_MAX_MS = 60 * 60 * 1000;

/**
 * 最後の印からの経過 `sinceLastSign` のタスクを、まだ動いている側に数えるか。`expiring` は印を拾えない種類
 * （Bash。起動からの時間で切る）。
 */
export function paradisBackgroundTaskCounts(sinceLastSign: number, expiring: boolean): boolean {
	return sinceLastSign < (expiring ? PARADIS_AGENT_BACKGROUND_TASK_STALE_MS : PARADIS_AGENT_BACKGROUND_TASK_UNKNOWN_MAX_MS);
}
/**
 * UserPromptSubmit の本文が、バックグラウンドの Bash・Monitor・サブエージェントの完了の知らせ（Claude Code が
 * `<task-notification>` を本文にして親を起こす）か。利用者が始めたターンではない。
 */
export function paradisIsHarnessNotificationPrompt(prompt: unknown): boolean {
	return typeof prompt === 'string' && prompt.trimStart().startsWith('<task-notification>');
}

/** 同じターンで前に出した完了の通知（ターンと、そのときバックグラウンドタスクが残っていなかったか）。 */
export interface IParadisAnnouncedReview {
	readonly turn: number;
	readonly certain: boolean;
}

/**
 * 確認待ち（review）を鳴らさないか。同じ利用者のターンで既に完了の通知を出していれば鳴らさない。ただし前の通知が
 * バックグラウンドタスクを残したままの（不確かな）完了で、今回は残りが無い（`certain`）なら、本当に終わったことを
 * 知らせるためにもう 1 回だけ鳴らす。ターンが分からない（`turn` が undefined）ときは鳴らす。
 */
export function paradisIsRepeatedReview(turn: number | undefined, announced: IParadisAnnouncedReview | undefined, certain: boolean): boolean {
	return turn !== undefined && announced?.turn === turn && (announced.certain || !certain);
}

/** 2秒pollが60秒連続失敗したらrenderer側の古いsnapshotを破棄する。 */
export const PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD = 30;

export function paradisShouldClearAgentStatusAfterPollFailures(consecutiveFailures: number): boolean {
	return consecutiveFailures >= PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD;
}

/**
 * 長時間の通常ツールを除外し、取り残されたバックグラウンド補正だけを降格する。まだ数えるバックグラウンドタスクが
 * ある（`liveBackgroundTasks` > 0）間は降格しない（印が途絶えただけで完了にしない）。
 */
export function paradisShouldSweepStaleWorkingStatus(status: string, backgroundCompletionFallback: boolean | undefined, changedAt: number, now: number, liveBackgroundTasks: number = 0): boolean {
	return status === 'working' && backgroundCompletionFallback === true && liveBackgroundTasks === 0 && now - changedAt > PARADIS_BACKGROUND_COMPLETION_STALE_MS;
}

/** Keeps a token's last stable scope through a transient terminal detach/reattach window. */
export class ParadisAgentTokenScopeMemory {
	private readonly stateKeys = new Map<string, string>();

	resolve(token: string, observedStateKey: string | undefined, allowRemembered: boolean): string | undefined {
		if (observedStateKey !== undefined) {
			this.stateKeys.set(token, observedStateKey);
			return observedStateKey;
		}
		return allowRemembered ? this.stateKeys.get(token) : undefined;
	}

	prune(liveTokens: ReadonlySet<string>): void {
		for (const token of this.stateKeys.keys()) {
			if (!liveTokens.has(token)) {
				this.stateKeys.delete(token);
			}
		}
	}
}
