/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Claude Code の Workflow の実行のフォルダを読む（モバイルの Workflow のカード。agent.workflows.v1）。
 *
 * - `<session>/subagents/workflows/<runId>/journal.jsonl`: 前に読んだ位置から追記だけ読む。`result` の行は子の返り値の
 *   全文（MB になる）なので、行の頭だけで読み、1 回に読む量に上限を置く
 * - 同じフォルダの `agent-<id>.meta.json`: まだ読んでいない子の分だけ 1 回読む。`agent-<id>.jsonl` は作った時刻だけ見る
 * - `<session>/workflows/<runId>.json`: 終わったときに書かれる。時刻が変わったときだけ読む
 *
 * パスは許可された親の transcript から決まった形で組み立て（runId・子の ID は形を確かめる）、シンボリックリンクは辿らない。
 */

import { promises as fs } from 'fs';
import { join, sep } from '../../../../base/common/path.js';
import { IParadisWorkflowChildFile, IParadisWorkflowJournalEntry, IParadisWorkflowResultFile, paradisParseWorkflowChildMeta, paradisParseWorkflowJournalLine, paradisParseWorkflowResultFile } from '../../agentChat/common/paradisAgentWorkflows.js';
import { paradisClaudeSubagentsDir } from './paradisClaudeSubagentFiles.js';

const RUN_ID = /^[A-Za-z0-9._-]{1,200}$/;
const AGENT_FILE = /^agent-(?<id>[A-Za-z0-9._:-]{1,200})\.(?<ext>jsonl|meta\.json)$/;
/** 1 回に読む journal の量。 */
const JOURNAL_CHUNK_BYTES = 512 * 1024;
/** 1 つのフォルダで見る項目の上限。 */
const MAX_DIR_ENTRIES = 2_100;
/** 1 回に読む meta.json の数。 */
const MAX_META_READS = 200;
const MAX_META_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

/** 実行ごとの読んだ位置（呼び出し側が実行ごとに持つ）。 */
export interface IParadisWorkflowRunReadState {
	journalOffset: number;
	/** 長すぎる行の途中にいる（次の改行まで捨てる）。 */
	skippingLine: boolean;
	/** 見つけた子（meta.json を読んだ・読もうとした）。 */
	readonly seenChildren: Set<string>;
	resultMtime?: number;
}

export function paradisNewWorkflowRunReadState(): IParadisWorkflowRunReadState {
	return { journalOffset: 0, skippingLine: false, seenChildren: new Set() };
}

export interface IParadisWorkflowRunRead {
	readonly journal: readonly IParadisWorkflowJournalEntry[];
	readonly children: readonly IParadisWorkflowChildFile[];
	readonly result?: { readonly file: IParadisWorkflowResultFile; readonly writtenAt: number };
	/** journal を 1 回に読む量の上限で止めた（続きがすぐ読める。書きかけの行が残っているだけなら false）。 */
	readonly more: boolean;
}

/** 許可された場所の、シンボリックリンクでない普通のファイルを開く。 */
async function openPlainFile(path: string, within: string): Promise<fs.FileHandle | undefined> {
	try {
		const link = await fs.lstat(path);
		if (!link.isFile()) {
			return undefined;
		}
		const real = await fs.realpath(path);
		if (!real.startsWith(within + sep)) {
			return undefined;
		}
		const handle = await fs.open(path, 'r');
		const opened = await handle.stat();
		if (!opened.isFile() || opened.ino !== link.ino || opened.dev !== link.dev) {
			await handle.close();
			return undefined;
		}
		return handle;
	} catch {
		return undefined;
	}
}

/**
 * 実行 1 つのフォルダを読む。`running` なら journal と子を見る（終わった実行は `<runId>.json` だけ見ればよい）。
 * `isAllowed` は親の transcript を読んでよいか（呼び出し側の許可の判定）。
 */
export async function paradisReadClaudeWorkflowRun(rootTranscriptPath: string, runId: string, state: IParadisWorkflowRunReadState, running: boolean, isAllowed: (path: string) => Promise<boolean>): Promise<IParadisWorkflowRunRead> {
	const empty: IParadisWorkflowRunRead = { journal: [], children: [], more: false };
	if (!RUN_ID.test(runId) || !await isAllowed(rootTranscriptPath)) {
		return empty;
	}
	const sessionDir = rootTranscriptPath.replace(/\.jsonl$/i, '');
	let sessionReal: string;
	try {
		sessionReal = await fs.realpath(sessionDir);
	} catch {
		return empty;
	}
	const runDir = join(paradisClaudeSubagentsDir(rootTranscriptPath), 'workflows', runId);
	const journal = await readJournal(join(runDir, 'journal.jsonl'), sessionReal, state);
	const children = await readChildren(runDir, sessionReal, state, running || journal.entries.length > 0);
	const result = await readResult(join(sessionDir, 'workflows', `${runId}.json`), sessionReal, state);
	return { journal: journal.entries, children, more: journal.more, ...(result !== undefined ? { result } : {}) };
}

async function readJournal(path: string, within: string, state: IParadisWorkflowRunReadState): Promise<{ entries: IParadisWorkflowJournalEntry[]; more: boolean }> {
	const handle = await openPlainFile(path, within);
	if (handle === undefined) {
		return { entries: [], more: false };
	}
	try {
		const size = (await handle.stat()).size;
		if (size < state.journalOffset) {
			// 作り直された
			state.journalOffset = 0;
			state.skippingLine = false;
		}
		if (size <= state.journalOffset) {
			return { entries: [], more: false };
		}
		const length = Math.min(JOURNAL_CHUNK_BYTES, size - state.journalOffset);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, state.journalOffset);
		let body = buffer.subarray(0, bytesRead);
		let consumed = 0;
		if (state.skippingLine) {
			const newline = body.indexOf(0x0a);
			if (newline < 0) {
				state.journalOffset += bytesRead;
				return { entries: [], more: bytesRead === JOURNAL_CHUNK_BYTES && state.journalOffset < size };
			}
			consumed = newline + 1;
			body = body.subarray(consumed);
			state.skippingLine = false;
		}
		const lastNewline = body.lastIndexOf(0x0a);
		const entries: IParadisWorkflowJournalEntry[] = [];
		if (lastNewline < 0) {
			// 1 行が読む量を超えた（子の返り値の全文）。頭だけで読み、残りは捨てる
			if (bytesRead === JOURNAL_CHUNK_BYTES && body.length > 0) {
				const entry = paradisParseWorkflowJournalLine(body.toString('utf8'));
				if (entry !== undefined) {
					entries.push(entry);
				}
				state.skippingLine = true;
				state.journalOffset += bytesRead;
			} else {
				// 書きかけの行は次に読む（飛ばし終えた長い行の分だけ進める）
				state.journalOffset += consumed;
			}
			return { entries, more: bytesRead === JOURNAL_CHUNK_BYTES && state.journalOffset < size };
		}
		for (const line of body.subarray(0, lastNewline).toString('utf8').split('\n')) {
			const entry = paradisParseWorkflowJournalLine(line);
			if (entry !== undefined) {
				entries.push(entry);
			}
		}
		state.journalOffset += consumed + lastNewline + 1;
		return { entries, more: bytesRead === JOURNAL_CHUNK_BYTES && state.journalOffset < size };
	} catch {
		return { entries: [], more: false };
	} finally {
		await handle.close();
	}
}

async function readChildren(runDir: string, within: string, state: IParadisWorkflowRunReadState, look: boolean): Promise<IParadisWorkflowChildFile[]> {
	if (!look) {
		return [];
	}
	let names: string[];
	try {
		names = (await fs.readdir(runDir)).slice(0, MAX_DIR_ENTRIES);
	} catch {
		return [];
	}
	const transcripts = new Set<string>();
	const metas = new Set<string>();
	for (const name of names) {
		const match = AGENT_FILE.exec(name)?.groups;
		if (match === undefined || match.id.startsWith('aside_question-')) {
			continue;
		}
		(match.ext === 'jsonl' ? transcripts : metas).add(match.id);
	}
	const children: IParadisWorkflowChildFile[] = [];
	let reads = 0;
	for (const agentId of transcripts) {
		if (state.seenChildren.has(agentId) || reads >= MAX_META_READS) {
			continue;
		}
		reads++;
		state.seenChildren.add(agentId);
		let child: IParadisWorkflowChildFile = { agentId };
		if (metas.has(agentId)) {
			const handle = await openPlainFile(join(runDir, `agent-${agentId}.meta.json`), within);
			if (handle !== undefined) {
				try {
					const buffer = Buffer.alloc(MAX_META_BYTES);
					const { bytesRead } = await handle.read(buffer, 0, MAX_META_BYTES, 0);
					child = paradisParseWorkflowChildMeta(agentId, buffer.subarray(0, bytesRead).toString('utf8')) ?? child;
				} catch {
					// 読めない meta は飛ばす（ラベルが無いだけ）
				} finally {
					await handle.close();
				}
			}
		}
		try {
			const stat = await fs.lstat(join(runDir, `agent-${agentId}.jsonl`));
			const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
			if (stat.isFile() && Number.isFinite(born) && born > 0) {
				child = { ...child, startedAt: born };
			}
		} catch {
			// 時刻が無いだけ
		}
		children.push(child);
	}
	return children;
}

async function readResult(path: string, within: string, state: IParadisWorkflowRunReadState): Promise<{ file: IParadisWorkflowResultFile; writtenAt: number } | undefined> {
	let mtime: number;
	try {
		const stat = await fs.lstat(path);
		if (!stat.isFile() || stat.size > MAX_RESULT_BYTES) {
			return undefined;
		}
		mtime = stat.mtimeMs;
	} catch {
		return undefined;
	}
	if (state.resultMtime === mtime) {
		return undefined;
	}
	const handle = await openPlainFile(path, within);
	if (handle === undefined) {
		return undefined;
	}
	try {
		const text = (await handle.readFile()).toString('utf8');
		const file = paradisParseWorkflowResultFile(JSON.parse(text));
		// 書きかけ（JSON として読めない）なら時刻を覚えず、次にもう一度読む
		state.resultMtime = mtime;
		return file !== undefined ? { file, writtenAt: mtime } : undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}
