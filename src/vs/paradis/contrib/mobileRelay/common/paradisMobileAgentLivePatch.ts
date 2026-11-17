/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** MobileがAgent live生成文のappend差分を明示交渉するencoding名。 */
export const PARADIS_AGENT_LIVE_APPEND_ENCODING = 'agent-live-append-v1';
/**
 * 生成中の文を 6,000 字で切らずに追記で送る encoding 名（agent.live-append.v2）。差分の形は v1 と同じで、
 * 窓の始まりの位置 `textOffset`（先頭から落とした字数）を足したもの。PC が capability を広告しているときだけアプリが求める。
 */
export const PARADIS_AGENT_LIVE_APPEND_V2_ENCODING = 'agent-live-append-v2';
/** v1・交渉なしの購読と PC のチャット欄へ渡す生成中の文の長さ（v2 より前の上限。超えたら先頭に「…」を付けて末尾だけ残す）。 */
export const PARADIS_AGENT_LIVE_LEGACY_TEXT_LIMIT = 6_000;
/** 生成中の文として持っておく窓の長さ。これを超えた先頭は落とし、落とした字数を `textOffset` に足す。 */
export const PARADIS_AGENT_LIVE_TEXT_WINDOW = 64 * 1024;

type AgentLiveSource = 'hook' | 'transcript' | 'codex-daemon' | 'pty';

interface IAgentLiveTextState {
	readonly phase: 'thinking' | 'tool' | 'message' | 'permission';
	readonly source: AgentLiveSource;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly text?: string;
	/** `text` の前に落とした字数（窓の始まりの位置）。0 のときは付けない。 */
	readonly textOffset?: number;
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
	/** v2 だけ: 追記した後の窓の始まりの位置（0 のときは付けない）。 */
	readonly textOffset?: number;
	readonly final?: true;
}

/** exact negotiationに応じて選択される全量またはappend応答。 */
export type ParadisAgentLivePayload<T extends IAgentLiveTextState = IAgentLiveTextState> =
	| { readonly live: T; readonly liveRevision: number }
	| { readonly liveAppend: IParadisAgentLiveAppendPatch };

const PATCHABLE_KEYS = new Set(['phase', 'source', 'startedAt', 'updatedAt', 'text', 'final']);
const PATCHABLE_V2_KEYS = new Set([...PATCHABLE_KEYS, 'textOffset']);
const encoder = new TextEncoder();

/** 窓の始まりの位置（付いていなければ 0）。 */
function offsetOf(state: IAgentLiveTextState): number {
	return state.textOffset ?? 0;
}

/**
 * 生成中の文を窓に収める。`text` は窓の始まり `offset` からの文で、窓より長ければ先頭を落として位置を進める。
 */
export function paradisAgentLiveTextWindow(text: string, offset: number): { readonly text: string; readonly textOffset?: number } {
	const dropped = Math.max(0, text.length - PARADIS_AGENT_LIVE_TEXT_WINDOW);
	const textOffset = offset + dropped;
	const kept = dropped > 0 ? text.slice(dropped) : text;
	return textOffset > 0 ? { text: kept, textOffset } : { text: kept };
}

/**
 * v1・交渉なしの購読と PC のチャット欄へ渡す形（v2 より前と同じ）。窓の位置は外し、6,000 字を超える文は
 * 先頭に「…」を付けて末尾の 5,999 字だけにする。
 */
export function paradisLegacyAgentLive<T extends IAgentLiveTextState>(state: T): T {
	const text = state.text;
	const tooLong = text !== undefined && (offsetOf(state) > 0 || text.length > PARADIS_AGENT_LIVE_LEGACY_TEXT_LIMIT);
	if (state.textOffset === undefined && !tooLong) {
		return state;
	}
	const { textOffset: _textOffset, ...rest } = state;
	// allow-any-unicode-next-line
	return (tooLong ? { ...rest, text: `…${text.slice(-(PARADIS_AGENT_LIVE_LEGACY_TEXT_LIMIT - 1))}` } : rest) as T;
}

/** 購読の encoding に合わせた全量の live（v2 はそのまま、それ以外は {@link paradisLegacyAgentLive}）。 */
export function paradisAgentLiveForEncoding<T extends IAgentLiveTextState>(encoding: unknown, state: T): T {
	return encoding === PARADIS_AGENT_LIVE_APPEND_V2_ENCODING ? state : paradisLegacyAgentLive(state);
}

/** 同じ生成中の文か（種類・出どころ・始まりの時刻が同じで、final は true か無し）。 */
function sameLiveMessage(previous: IAgentLiveTextState | undefined, current: IAgentLiveTextState, baseRevision: number, revision: number, keys: ReadonlySet<string>): previous is IAgentLiveTextState {
	return previous?.phase === 'message' && current.phase === 'message'
		&& previous.source === current.source && previous.startedAt === current.startedAt
		&& Number.isSafeInteger(baseRevision) && baseRevision >= 0 && revision === baseRevision + 1
		&& !Object.keys(previous).some(key => !keys.has(key))
		&& !Object.keys(current).some(key => !keys.has(key))
		&& (current.final === undefined || current.final === true);
}

/** 差分が全量より小さいときだけ差分を返す。 */
function smallerThanFull(patch: IParadisAgentLiveAppendPatch, current: IAgentLiveTextState, revision: number): IParadisAgentLiveAppendPatch | undefined {
	const patchBytes = encoder.encode(JSON.stringify({ liveAppend: patch })).byteLength;
	const fullBytes = encoder.encode(JSON.stringify({ live: current, liveRevision: revision })).byteLength;
	return patchBytes < fullBytes ? patch : undefined;
}

/** 同一messageのprefix追記を、全文より小さいrevision付きpatchへ変換する。 */
export function paradisCreateAgentLiveAppendPatch(
	previous: IAgentLiveTextState | undefined,
	current: IAgentLiveTextState,
	baseRevision: number,
	revision: number,
): IParadisAgentLiveAppendPatch | undefined {
	if (!sameLiveMessage(previous, current, baseRevision, revision, PATCHABLE_KEYS)) {
		return undefined;
	}
	const previousText = previous.text ?? '';
	const currentText = current.text ?? '';
	if (!currentText.startsWith(previousText)) {
		return undefined;
	}
	return smallerThanFull({
		baseRevision,
		revision,
		source: current.source,
		startedAt: current.startedAt,
		updatedAt: current.updatedAt,
		append: currentText.slice(previousText.length),
		...(current.final === true ? { final: true } : {}),
	}, current, revision);
}

/**
 * v2 の差分。前の窓の末尾までが今の窓の中で同じ文のまま残っていれば、その後ろの追記と今の窓の始まりの位置を送る
 * （窓が進んで先頭が落ちても全量に戻らない）。
 */
export function paradisCreateAgentLiveAppendV2Patch(
	previous: IAgentLiveTextState | undefined,
	current: IAgentLiveTextState,
	baseRevision: number,
	revision: number,
): IParadisAgentLiveAppendPatch | undefined {
	if (!sameLiveMessage(previous, current, baseRevision, revision, PATCHABLE_V2_KEYS)) {
		return undefined;
	}
	const previousText = previous.text ?? '';
	const currentText = current.text ?? '';
	const previousStart = offsetOf(previous);
	const currentStart = offsetOf(current);
	const previousEnd = previousStart + previousText.length;
	if (currentStart < previousStart || currentStart > previousEnd || currentStart + currentText.length < previousEnd
		|| previousText.slice(currentStart - previousStart) !== currentText.slice(0, previousEnd - currentStart)) {
		return undefined;
	}
	return smallerThanFull({
		baseRevision,
		revision,
		source: current.source,
		startedAt: current.startedAt,
		updatedAt: current.updatedAt,
		append: currentText.slice(previousEnd - currentStart),
		...(currentStart > 0 ? { textOffset: currentStart } : {}),
		...(current.final === true ? { final: true } : {}),
	}, current, revision);
}

/**
 * exact negotiationで有効なpatchを作れる場合だけ差分を選び、それ以外は完全liveを維持する。
 * v1・交渉なしの購読には、v2 より前と同じ 6,000 字の形（{@link paradisLegacyAgentLive}）から作る。
 */
export function paradisAgentLivePayloadForEncoding<T extends IAgentLiveTextState>(
	encoding: unknown,
	previous: T | undefined,
	current: T,
	baseRevision: number,
	revision: number,
): ParadisAgentLivePayload<T> {
	if (encoding === PARADIS_AGENT_LIVE_APPEND_V2_ENCODING) {
		const liveAppend = paradisCreateAgentLiveAppendV2Patch(previous, current, baseRevision, revision);
		return liveAppend !== undefined ? { liveAppend } : { live: current, liveRevision: revision };
	}
	const legacy = paradisLegacyAgentLive(current);
	if (encoding === PARADIS_AGENT_LIVE_APPEND_ENCODING) {
		const liveAppend = paradisCreateAgentLiveAppendPatch(previous !== undefined ? paradisLegacyAgentLive(previous) : undefined, legacy, baseRevision, revision);
		if (liveAppend !== undefined) {
			return { liveAppend };
		}
	}
	return { live: legacy, liveRevision: revision };
}
