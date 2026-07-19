// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** PCにAgent live生成文のappend差分を明示交渉するencoding名。 */
export const AGENT_LIVE_APPEND_ENCODING = 'agent-live-append-v1';

type AgentLiveSource = 'hook' | 'transcript' | 'codex-daemon' | 'pty';

/** append差分を適用できるAgent生成中メッセージの最小状態。 */
export interface AgentLiveMessageState {
	readonly phase: 'thinking' | 'tool' | 'message' | 'permission';
	readonly source: AgentLiveSource;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly text?: string;
	readonly final?: boolean;
}

/** 検証済みappend差分の適用結果。 */
export interface AppliedAgentLiveAppendPatch {
	readonly live: AgentLiveMessageState;
	readonly liveRevision: number;
}

const PATCH_KEYS = new Set(['baseRevision', 'revision', 'source', 'startedAt', 'updatedAt', 'append', 'final']);
const SOURCES = new Set<AgentLiveSource>(['hook', 'transcript', 'codex-daemon', 'pty']);
const MAX_LIVE_TEXT_LENGTH = 6_000;

/**
 * revisionとmessageの同一性を検証できた場合だけappendを適用する。
 * 失敗時は既存表示を変更せず、呼び出し側が全量再同期できるようundefinedを返す。
 */
export function applyAgentLiveAppendPatch(
	existing: AgentLiveMessageState | undefined,
	existingRevision: number | undefined,
	value: unknown,
): AppliedAgentLiveAppendPatch | undefined {
	if (existing?.phase !== 'message' || typeof existingRevision !== 'number' || !Number.isSafeInteger(existingRevision) || existingRevision < 0
		|| value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const patch = value as Record<string, unknown>;
	if (Object.keys(patch).some(key => !PATCH_KEYS.has(key))
		|| patch['baseRevision'] !== existingRevision
		|| !Number.isSafeInteger(patch['revision']) || patch['revision'] !== existingRevision + 1
		|| typeof patch['source'] !== 'string' || !SOURCES.has(patch['source'] as AgentLiveSource)
		|| patch['source'] !== existing.source
		|| typeof patch['startedAt'] !== 'number' || !Number.isFinite(patch['startedAt']) || patch['startedAt'] !== existing.startedAt
		|| typeof patch['updatedAt'] !== 'number' || !Number.isFinite(patch['updatedAt'])
		|| typeof patch['append'] !== 'string'
		|| (patch['final'] !== undefined && patch['final'] !== true)) {
		return undefined;
	}
	const text = (existing.text ?? '') + patch['append'];
	if (text.length > MAX_LIVE_TEXT_LENGTH) {
		return undefined;
	}
	return {
		live: {
			phase: 'message',
			source: existing.source,
			startedAt: existing.startedAt,
			updatedAt: patch['updatedAt'],
			text,
			...(patch['final'] === true ? { final: true } : {}),
		},
		liveRevision: patch['revision'] as number,
	};
}
