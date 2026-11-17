// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** PCにAgent live生成文のappend差分を明示交渉するencoding名。 */
export const AGENT_LIVE_APPEND_ENCODING = 'agent-live-append-v1';
/**
 * 生成中の文を 6,000 字で切らずに追記で受け取る encoding 名（agent.live-append.v2。PC の `paradisMobileAgentLivePatch.ts`）。
 * PC が capability を広告しているときだけ求める。差分の形は v1 と同じで、窓の始まりの位置 `textOffset` が付く。
 */
export const AGENT_LIVE_APPEND_V2_ENCODING = 'agent-live-append-v2';

type AgentLiveSource = 'hook' | 'transcript' | 'codex-daemon' | 'pty';

/** append差分を適用できるAgent生成中メッセージの最小状態。 */
export interface AgentLiveMessageState {
	readonly phase: 'thinking' | 'tool' | 'message' | 'permission';
	readonly source: AgentLiveSource;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly text?: string;
	/** `text` の前に PC が落とした字数（窓の始まりの位置。v2 だけ。0 のときは無い）。 */
	readonly textOffset?: number;
	readonly final?: boolean;
}

/** 検証済みappend差分の適用結果。 */
export interface AppliedAgentLiveAppendPatch {
	readonly live: AgentLiveMessageState;
	readonly liveRevision: number;
}

const PATCH_KEYS = new Set(['baseRevision', 'revision', 'source', 'startedAt', 'updatedAt', 'append', 'textOffset', 'final']);
const SOURCES = new Set<AgentLiveSource>(['hook', 'transcript', 'codex-daemon', 'pty']);
/** 生成中の文の窓の長さ（PC の `PARADIS_AGENT_LIVE_TEXT_WINDOW`）。v1 の PC は 6,000 字までしか送らない。 */
const MAX_LIVE_TEXT_LENGTH = 64 * 1024;

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
		|| (patch['textOffset'] !== undefined && (!Number.isSafeInteger(patch['textOffset']) || (patch['textOffset'] as number) <= 0))
		|| (patch['final'] !== undefined && patch['final'] !== true)) {
		return undefined;
	}
	// v2 の PC は窓が進むと先頭を落とし、新しい窓の始まりの位置を付ける。手元の窓の始まりより前・追記した文の外は受けない
	const existingOffset = existing.textOffset ?? 0;
	const textOffset = (patch['textOffset'] as number | undefined) ?? 0;
	const combined = (existing.text ?? '') + patch['append'];
	if (textOffset < existingOffset || textOffset - existingOffset > combined.length) {
		return undefined;
	}
	const text = combined.slice(textOffset - existingOffset);
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
			...(textOffset > 0 ? { textOffset } : {}),
			...(patch['final'] === true ? { final: true } : {}),
		},
		liveRevision: patch['revision'] as number,
	};
}
