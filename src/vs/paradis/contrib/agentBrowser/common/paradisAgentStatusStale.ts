/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Stop後のバックグラウンド補正が取り残された場合だけ完了へ降格するまでの時間。 */
const PARADIS_BACKGROUND_COMPLETION_STALE_MS = 15 * 60 * 1000;
/** background taskとStop fallbackが同じ時刻基準で収束するための上限。 */
export const PARADIS_AGENT_BACKGROUND_TASK_STALE_MS = PARADIS_BACKGROUND_COMPLETION_STALE_MS;
/** 2秒pollが60秒連続失敗したらrenderer側の古いsnapshotを破棄する。 */
export const PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD = 30;

export function paradisShouldClearAgentStatusAfterPollFailures(consecutiveFailures: number): boolean {
	return consecutiveFailures >= PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD;
}

/** 長時間の通常ツールを除外し、取り残されたバックグラウンド補正だけを降格する。 */
export function paradisShouldSweepStaleWorkingStatus(status: string, backgroundCompletionFallback: boolean | undefined, changedAt: number, now: number): boolean {
	return status === 'working' && backgroundCompletionFallback === true && now - changedAt > PARADIS_BACKGROUND_COMPLETION_STALE_MS;
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
