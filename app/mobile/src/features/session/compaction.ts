// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentActivityState, AgentChatMessage } from '../../store.js';

/** これより古い「圧縮中」は、終わりの知らせが落ちたものとみなして出さない（PC 側も同じくらいで閉じる）。 */
const STALE_COMPACTION_MS = 10 * 60_000;

/**
 * いま圧縮している最中なら、その始まりの時刻（モックの A6-2「会話を要約しています…」）。
 * 始まりは PC の活動の `compactions`（Claude Code は PreCompact の hook、Codex は app-server の ContextCompaction）。
 * 区切りの行（`noticeSource: 'compaction'`）が始まりより後に届いていれば、終わりの hook が遅れていても終わったとみなす。
 */
export function runningCompactionSince(activity: AgentActivityState | undefined, messages: readonly AgentChatMessage[] | undefined, now: number): number | undefined {
	let since: number | undefined;
	for (const compaction of activity?.compactions ?? []) {
		if (compaction.status === 'running' && now - compaction.startedAt < STALE_COMPACTION_MS) {
			since = since === undefined ? compaction.startedAt : Math.max(since, compaction.startedAt);
		}
	}
	if (since === undefined) {
		return undefined;
	}
	const list = messages ?? [];
	for (let index = list.length - 1; index >= 0; index--) {
		const message = list[index];
		if (message?.notice === true && message.noticeSource === 'compaction' && (message.ts ?? 0) >= since) {
			return undefined;
		}
	}
	return since;
}
