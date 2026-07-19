/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** MobileがAgent live生成文のappend差分を明示交渉するencoding名。 */
export const PARADIS_AGENT_LIVE_APPEND_ENCODING = 'agent-live-append-v1';

type AgentLiveSource = 'hook' | 'transcript' | 'codex-daemon' | 'pty';

interface IAgentLiveTextState {
	readonly phase: 'thinking' | 'tool' | 'message' | 'permission';
	readonly source: AgentLiveSource;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly text?: string;
	readonly final?: boolean;
}

/** Mobileが厳密なrevision検査後に適用するAgent live append差分。 */
export interface IParadisAgentLiveAppendPatch {
	readonly baseRevision: number;
	readonly revision: number;
	readonly source: AgentLiveSource;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly append: string;
	readonly final?: true;
}

/** exact negotiationに応じて選択される全量またはappend応答。 */
export type ParadisAgentLivePayload =
	| { readonly live: IAgentLiveTextState; readonly liveRevision: number }
	| { readonly liveAppend: IParadisAgentLiveAppendPatch };

const PATCHABLE_KEYS = new Set(['phase', 'source', 'startedAt', 'updatedAt', 'text', 'final']);
const encoder = new TextEncoder();

/** 同一messageのprefix追記を、全文より小さいrevision付きpatchへ変換する。 */
export function paradisCreateAgentLiveAppendPatch(
	previous: IAgentLiveTextState | undefined,
	current: IAgentLiveTextState,
	baseRevision: number,
	revision: number,
): IParadisAgentLiveAppendPatch | undefined {
	if (previous?.phase !== 'message' || current.phase !== 'message'
		|| previous.source !== current.source || previous.startedAt !== current.startedAt
		|| !Number.isSafeInteger(baseRevision) || baseRevision < 0 || revision !== baseRevision + 1
		|| Object.keys(previous).some(key => !PATCHABLE_KEYS.has(key))
		|| Object.keys(current).some(key => !PATCHABLE_KEYS.has(key))) {
		return undefined;
	}
	const previousText = previous.text ?? '';
	const currentText = current.text ?? '';
	if (!currentText.startsWith(previousText) || (current.final !== undefined && current.final !== true)) {
		return undefined;
	}
	const patch: IParadisAgentLiveAppendPatch = {
		baseRevision,
		revision,
		source: current.source,
		startedAt: current.startedAt,
		updatedAt: current.updatedAt,
		append: currentText.slice(previousText.length),
		...(current.final === true ? { final: true } : {}),
	};
	const patchBytes = encoder.encode(JSON.stringify({ liveAppend: patch })).byteLength;
	const fullBytes = encoder.encode(JSON.stringify({ live: current, liveRevision: revision })).byteLength;
	return patchBytes < fullBytes ? patch : undefined;
}

/** exact negotiationで有効なpatchを作れる場合だけ差分を選び、それ以外は完全liveを維持する。 */
export function paradisAgentLivePayloadForEncoding(
	encoding: unknown,
	previous: IAgentLiveTextState | undefined,
	current: IAgentLiveTextState,
	baseRevision: number,
	revision: number,
): ParadisAgentLivePayload {
	if (encoding === PARADIS_AGENT_LIVE_APPEND_ENCODING) {
		const liveAppend = paradisCreateAgentLiveAppendPatch(previous, current, baseRevision, revision);
		if (liveAppend !== undefined) {
			return { liveAppend };
		}
	}
	return { live: current, liveRevision: revision };
}
