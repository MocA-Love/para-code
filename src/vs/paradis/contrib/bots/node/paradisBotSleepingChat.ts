/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 眠った Bot の会話（ペインが無い）を、エージェントを起こさずに会話の記録のファイルから読む（報告書の D1・D2）。
// Claude Code は `<設定>/projects/<フォルダ>/<会話の id>.jsonl`、Codex は `<ホーム>/sessions/年/月/日/rollout-…-<会話の id>.jsonl`。
// 読むのは許可した置き場（Claude Code の設定・Codex のホーム）の中だけで、末尾の決まった大きさまで。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { paradisAgentTranscriptSnapshot } from '../../agentChat/common/paradisAgentTranscriptSnapshot.js';
import type { IParadisBotSleepingChat } from '../common/paradisBotsApi.js';

/** 読む末尾の大きさ。長い会話でも最後の方だけを読む。 */
const TAIL_BYTES = 4 * 1024 * 1024;
/** Codex の rollout を探す日のフォルダの数（新しい順）。 */
const CODEX_DAY_LIMIT = 400;

/** 会話の記録の置き場。 */
export interface IParadisBotTranscriptRoots {
	/** Claude Code の設定のフォルダ（`projects` の親）。 */
	readonly claudeConfigDir: string;
	/** Codex のホーム（`sessions` の親）。 */
	readonly codexHomes: readonly string[];
}

async function list(path: string): Promise<string[]> {
	try {
		return await fs.readdir(path);
	} catch {
		return [];
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await fs.lstat(path)).isFile();
	} catch {
		return false;
	}
}

/** 会話の id から記録のファイルを探す。見つからなければ undefined。 */
export async function paradisFindBotTranscript(agent: string, sessionId: string, roots: IParadisBotTranscriptRoots): Promise<string | undefined> {
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(sessionId)) {
		return undefined;
	}
	if (agent === 'claude') {
		const projects = join(roots.claudeConfigDir, 'projects');
		for (const folder of await list(projects)) {
			const candidate = join(projects, folder, `${sessionId}.jsonl`);
			if (await isFile(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}
	if (agent === 'codex') {
		const suffix = `-${sessionId}.jsonl`;
		for (const home of roots.codexHomes) {
			const sessions = join(home, 'sessions');
			const days: string[] = [];
			for (const year of (await list(sessions)).filter(name => /^\d{4}$/.test(name)).sort().reverse()) {
				for (const month of (await list(join(sessions, year))).filter(name => /^\d{2}$/.test(name)).sort().reverse()) {
					for (const day of (await list(join(sessions, year, month))).filter(name => /^\d{2}$/.test(name)).sort().reverse()) {
						days.push(join(sessions, year, month, day));
					}
				}
				if (days.length >= CODEX_DAY_LIMIT) {
					break;
				}
			}
			for (const day of days.slice(0, CODEX_DAY_LIMIT)) {
				const name = (await list(day)).find(candidate => candidate.startsWith('rollout-') && candidate.endsWith(suffix));
				if (name !== undefined && await isFile(join(day, name))) {
					return join(day, name);
				}
			}
		}
	}
	return undefined;
}

/** ファイルの末尾 {@link TAIL_BYTES} を行に分ける（途中から読んだときは、切れた最初の行を捨てる）。 */
async function readTailLines(path: string): Promise<string[]> {
	const handle = await fs.open(path, 'r');
	try {
		const size = (await handle.stat()).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const lines = buffer.toString('utf8').split('\n');
		return start > 0 ? lines.slice(1) : lines;
	} finally {
		await handle.close();
	}
}

/**
 * 眠った会話を読むだけの吹き出しにする。続けられる会話でない（Claude Code・Codex 以外）なら undefined。記録が見つからない・
 * 読めないときは `unreadable`（話しかければ続きから起きる）。
 */
export async function paradisReadBotSleepingChat(record: { readonly agent: string; readonly sessionId: string }, roots: IParadisBotTranscriptRoots): Promise<IParadisBotSleepingChat | undefined> {
	const agent = record.agent === 'claude' || record.agent === 'codex' ? record.agent : undefined;
	if (agent === undefined) {
		return undefined;
	}
	try {
		const path = await paradisFindBotTranscript(agent, record.sessionId, roots);
		if (path === undefined) {
			return { agent, messages: [], truncated: false, unreadable: true };
		}
		const { messages, truncated } = paradisAgentTranscriptSnapshot(agent, await readTailLines(path));
		return { agent, messages, truncated };
	} catch {
		return { agent, messages: [], truncated: false, unreadable: true };
	}
}
