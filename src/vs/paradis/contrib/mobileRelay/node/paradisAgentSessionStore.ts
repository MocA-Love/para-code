/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'fs';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * ディスクへ永続化するエージェントセッション1件。ペイントークン（terminalKey由来のUUID、
 * 永続ターミナルの再接続をまたいで安定）と、その時点で確定していたtranscriptの対応を保存する。
 */
export interface IParadisPersistedAgentSession {
	readonly token: string;
	readonly agent: 'claude' | 'codex';
	readonly transcriptPath: string;
	readonly sessionId?: string;
	/** 保存時刻（ms）。TTL失効の判定に使う。 */
	readonly savedAt: number;
}

const MAX_ENTRIES = 256;
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 300;

/**
 * ペインのエージェントセッション対応表をuser data配下のJSONへ永続化する。
 *
 * shared processは全ウィンドウのセッション確定情報（hook・探索由来）をメモリでしか持たず、
 * PC再起動・shared process再起動でエージェントセッションが全て失われる。永続ターミナル
 * （ptyは生存し再接続される）側は復元されるのに、対応するセッションが消えるため、実行中の
 * エージェントがモバイルのホームから消えてしまう。tokenは永続ターミナルの識別子から導出され
 * 再起動をまたいで安定なので、この対応表を保存しておけば再起動後にペインが再同期された時点で
 * セッションを復活できる。
 */
export class ParadisAgentSessionStore {
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private pending: readonly IParadisPersistedAgentSession[] | undefined;
	private writing = Promise.resolve();

	constructor(
		private readonly filePath: string,
		private readonly logService: ILogService,
	) { }

	async load(): Promise<readonly IParadisPersistedAgentSession[]> {
		try {
			const raw = await fs.readFile(this.filePath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			const now = Date.now();
			const entries: IParadisPersistedAgentSession[] = [];
			for (const candidate of parsed.slice(0, MAX_ENTRIES)) {
				if (candidate === null || typeof candidate !== 'object') {
					continue;
				}
				const entry = candidate as Record<string, unknown>;
				if (typeof entry.token !== 'string' || entry.token.length === 0 || entry.token.length > 200
					|| (entry.agent !== 'claude' && entry.agent !== 'codex')
					|| typeof entry.transcriptPath !== 'string' || entry.transcriptPath.length === 0 || entry.transcriptPath.length > 4096
					|| (entry.sessionId !== undefined && (typeof entry.sessionId !== 'string' || entry.sessionId.length > 500))
					|| typeof entry.savedAt !== 'number' || !Number.isFinite(entry.savedAt)) {
					continue;
				}
				if (now - entry.savedAt > ENTRY_TTL_MS) {
					continue;
				}
				entries.push({
					token: entry.token,
					agent: entry.agent,
					transcriptPath: entry.transcriptPath,
					...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
					savedAt: entry.savedAt,
				});
			}
			return entries;
		} catch {
			// 初回起動（ファイル無し）・破損はどちらも空として扱う（復元は諦めるだけで害がない）。
			return [];
		}
	}

	/** 現在の対応表全量を受け取り、debounce付きで書き出す。 */
	persist(entries: readonly IParadisPersistedAgentSession[]): void {
		const now = Date.now();
		this.pending = entries
			.filter(entry => now - entry.savedAt <= ENTRY_TTL_MS)
			.slice()
			.sort((a, b) => b.savedAt - a.savedAt)
			.slice(0, MAX_ENTRIES);
		if (this.saveTimer !== undefined) {
			return;
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	/** 直近のpersist内容を即時書き出す（dispose時のデバウンス取り逃し対策）。 */
	flush(): Promise<void> {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		const entries = this.pending;
		if (entries !== undefined) {
			this.pending = undefined;
			this.writing = this.writing
				.then(() => fs.writeFile(this.filePath, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 }))
				.catch(err => this.logService.warn('[paradisAgentSessionStore] failed to persist agent sessions', err));
		}
		return this.writing;
	}
}
