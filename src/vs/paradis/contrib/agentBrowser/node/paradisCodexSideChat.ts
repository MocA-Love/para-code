/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex 0.171（alpha）のサイドチャット（`tui_workspace` の横の会話）を、hook の transcript_path から見分ける。
//
// サイドチャットは表の会話から fork した別の thread。保存するもの（codex-rs/tui の `SideChatStorage::Attached`）は
// 自分の rollout を持ち、先頭行の session_meta に `attached_thread: true` と `forked_from_id`（表の会話）が入る
// （codex-rs/protocol/src/protocol.rs の `SessionMeta`、state DB では threads の `attached_thread_parent_id`）。
// 一時的なものは rollout を持たないので、hook の transcript_path は null になる（呼び出し側で見る）。
// 0.167.2 には無い機能なので、0.171.0-alpha.10 のソースの形で作った。

import { open, type FileHandle } from 'fs/promises';

/** session_meta の行の上限（base_instructions を含むので大きい。paradisMobileAgentChat の上限と同じ）。 */
const SESSION_META_MAX_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** rollout のパス → サイドチャットか。session_meta は書いた後に変わらないので使い回す。 */
const sideChatCache = new Map<string, boolean>();
const SIDE_CHAT_CACHE_LIMIT = 256;

/** rollout の先頭行（session_meta）が、保存したサイドチャット（`attached_thread: true`）のものか。 */
export function paradisCodexSessionMetaIsSideChat(firstLine: string): boolean | undefined {
	try {
		const meta: unknown = JSON.parse(firstLine);
		if (typeof meta !== 'object' || meta === null || (meta as { type?: unknown }).type !== 'session_meta') {
			return undefined;
		}
		const payload = (meta as { payload?: unknown }).payload;
		return typeof payload === 'object' && payload !== null && (payload as { attached_thread?: unknown }).attached_thread === true;
	} catch {
		return undefined;
	}
}

/**
 * rollout が保存したサイドチャットのものか。読めない（ファイルが無い・先頭行が書きかけ）ときは false（今までどおり表の会話の
 * 候補として扱う）。読めたものだけ覚える。
 */
export async function paradisCodexRolloutIsSideChat(rolloutPath: string): Promise<boolean> {
	const cached = sideChatCache.get(rolloutPath);
	if (cached !== undefined) {
		return cached;
	}
	let handle: FileHandle;
	try {
		handle = await open(rolloutPath, 'r');
	} catch {
		return false;
	}
	let sideChat: boolean | undefined;
	try {
		const chunks: Buffer[] = [];
		let total = 0;
		while (total < SESSION_META_MAX_BYTES) {
			const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, SESSION_META_MAX_BYTES - total));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
			if (bytesRead === 0) {
				break;
			}
			const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
			if (newline !== -1) {
				chunks.push(chunk.subarray(0, newline));
				sideChat = paradisCodexSessionMetaIsSideChat(Buffer.concat(chunks).toString('utf8'));
				break;
			}
			chunks.push(chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
	} catch {
		sideChat = undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
	if (sideChat === undefined) {
		return false;
	}
	sideChatCache.set(rolloutPath, sideChat);
	while (sideChatCache.size > SIDE_CHAT_CACHE_LIMIT) {
		const oldest = sideChatCache.keys().next();
		if (oldest.done === true) {
			break;
		}
		sideChatCache.delete(oldest.value);
	}
	return sideChat;
}
