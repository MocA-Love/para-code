/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Claude Code の子エージェントの transcript の置き場（実物で確認、2026-10）。
 *
 * - ふつうのサブエージェント: `<session>/subagents/agent-<id>.jsonl`（隣に `agent-<id>.meta.json`）
 * - Workflow の子: `<session>/subagents/workflows/<runId>/agent-<id>.jsonl`（meta.json の agentType は
 *   `workflow-subagent`、description と toolUseId は無い）。同じフォルダに子の起動と結果を 1 行ずつ書く
 *   `journal.jsonl`（`{type: 'started' | 'result', key, agentId}`）がある
 *
 * 一覧の補完・詳細・期限の生存の印・パスからの親子の判定は、すべてここの関数で子を見つける。
 * 探すのは決まった 2 段だけで、フォルダの件数と Workflow の数に上限を置き、シンボリックリンクは辿らない。
 */

import { promises as fs, type Dirent } from 'fs';
import { join, resolve, sep } from '../../../../base/common/path.js';

/** Workflow の子の meta.json の agentType。 */
export const PARADIS_CLAUDE_WORKFLOW_SUBAGENT_TYPE = 'workflow-subagent';
/** 1 つのフォルダで見る項目の上限（壊れた・巨大な置き場で readdir の結果を全部は見ない）。 */
const MAX_DIR_ENTRIES = 2_000;
/** 見る Workflow の数の上限（新しい順）。 */
const MAX_WORKFLOW_RUNS = 20;
const AGENT_FILE_PATTERN = /^agent-([A-Za-z0-9._:-]{1,500})\.jsonl$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const SUBAGENT_PATH_PATTERN = /^(?<root>.*)\/(?<session>[^/]+)\/subagents\/(?:workflows\/(?<runId>[^/]+)\/)?agent-(?<id>[^/]+)\.jsonl$/i;

export interface IParadisClaudeSubagentPath {
	/** 親の会話の transcript（`/` 区切り）。 */
	readonly rootTranscriptPath: string;
	readonly agentId: string;
	/** Workflow の子なら、その実行の ID。 */
	readonly runId?: string;
}

/** 子の transcript のパスから、子の ID と親の会話を読む。子のパスでなければ undefined。 */
export function paradisParseClaudeSubagentTranscriptPath(transcriptPath: string): IParadisClaudeSubagentPath | undefined {
	const groups = SUBAGENT_PATH_PATTERN.exec(transcriptPath.replace(/\\/g, '/'))?.groups;
	if (groups?.root === undefined || groups.session === undefined || groups.id === undefined) {
		return undefined;
	}
	return {
		rootTranscriptPath: `${groups.root}/${groups.session}.jsonl`,
		agentId: groups.id,
		...(groups.runId !== undefined ? { runId: groups.runId } : {}),
	};
}

export interface IParadisClaudeSubagentFile {
	readonly id: string;
	readonly path: string;
	readonly mtime: number;
	/** Workflow の子なら、その実行の ID。 */
	readonly runId?: string;
}

/** 親の会話の transcript から、子の置き場（`<session>/subagents`）を出す。 */
export function paradisClaudeSubagentsDir(rootTranscriptPath: string): string {
	const dir = resolve(rootTranscriptPath, '..');
	const filename = rootTranscriptPath.slice(rootTranscriptPath.lastIndexOf(sep) + 1).replace(/\.jsonl$/i, '');
	return join(dir, filename, 'subagents');
}

async function readDirBounded(dir: string): Promise<readonly Dirent[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.length > MAX_DIR_ENTRIES ? entries.slice(0, MAX_DIR_ENTRIES) : entries;
	} catch {
		return [];
	}
}

async function collectAgentFiles(dir: string, runId: string | undefined, isAllowed: (path: string) => Promise<boolean>): Promise<IParadisClaudeSubagentFile[]> {
	const files: IParadisClaudeSubagentFile[] = [];
	for (const entry of await readDirBounded(dir)) {
		// Dirent はリンク自体を表す（isFile は false）ので、シンボリックリンクはここで落ちる
		if (!entry.isFile()) {
			continue;
		}
		const match = AGENT_FILE_PATTERN.exec(entry.name);
		// `/btw` の脇の質問も同じ置き場に `agent-aside_question-*` として書かれるが、サブエージェントではない
		if (match === null || match[1].startsWith('aside_question-')) {
			continue;
		}
		const path = join(dir, entry.name);
		if (!await isAllowed(path)) {
			continue;
		}
		const stat = await fs.stat(path).catch(() => undefined);
		if (stat?.isFile()) {
			files.push({ id: match[1], path, mtime: stat.mtimeMs, ...(runId !== undefined ? { runId } : {}) });
		}
	}
	return files;
}

/** 新しい順の Workflow の実行（`subagents/workflows/<runId>`）。 */
async function listWorkflowRuns(subagentsDir: string): Promise<readonly { readonly runId: string; readonly dir: string; readonly mtime: number }[]> {
	const workflowsDir = join(subagentsDir, 'workflows');
	const runs: { runId: string; dir: string; mtime: number }[] = [];
	for (const entry of await readDirBounded(workflowsDir)) {
		if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) {
			continue;
		}
		const dir = join(workflowsDir, entry.name);
		const stat = await fs.stat(dir).catch(() => undefined);
		if (stat?.isDirectory()) {
			runs.push({ runId: entry.name, dir, mtime: stat.mtimeMs });
		}
	}
	return runs.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_WORKFLOW_RUNS);
}

/** 探している最中の置き場（一覧の補完・詳細・期限の確認が重なったら同じ探索を待つ。終われば忘れる）。 */
const discoveriesInFlight = new Map<string, Promise<readonly IParadisClaudeSubagentFile[]>>();

/**
 * 親の会話の子の transcript を全部（ふつうの子と Workflow の子）新しい順に返す。同じ ID が両方にあれば新しい方。
 * `isAllowed` は読んでよい場所か（呼び出し側の許可の判定）。同じ置き場を同時に探す呼び出しは 1 回の探索を共有する。
 */
export function paradisDiscoverClaudeSubagentFiles(rootTranscriptPath: string, isAllowed: (path: string) => Promise<boolean>): Promise<readonly IParadisClaudeSubagentFile[]> {
	const running = discoveriesInFlight.get(rootTranscriptPath);
	if (running !== undefined) {
		return running;
	}
	const result = discoverUncached(rootTranscriptPath, isAllowed).finally(() => discoveriesInFlight.delete(rootTranscriptPath));
	discoveriesInFlight.set(rootTranscriptPath, result);
	return result;
}

async function discoverUncached(rootTranscriptPath: string, isAllowed: (path: string) => Promise<boolean>): Promise<readonly IParadisClaudeSubagentFile[]> {
	const subagentsDir = paradisClaudeSubagentsDir(rootTranscriptPath);
	const byId = new Map<string, IParadisClaudeSubagentFile>();
	const remember = (file: IParadisClaudeSubagentFile) => {
		const previous = byId.get(file.id);
		if (previous === undefined || file.mtime > previous.mtime) {
			byId.set(file.id, file);
		}
	};
	for (const file of await collectAgentFiles(subagentsDir, undefined, isAllowed)) {
		remember(file);
	}
	for (const run of await listWorkflowRuns(subagentsDir)) {
		for (const file of await collectAgentFiles(run.dir, run.runId, isAllowed)) {
			remember(file);
		}
	}
	return [...byId.values()].sort((a, b) => b.mtime - a.mtime);
}

/** 子の ID から transcript を探す（直下を先に、無ければ Workflow の実行の中）。 */
export async function paradisFindClaudeSubagentTranscript(rootTranscriptPath: string, agentId: string, isAllowed: (path: string) => Promise<boolean>): Promise<string | undefined> {
	if (!/^[A-Za-z0-9._:-]{1,500}$/.test(agentId)) {
		return undefined;
	}
	const files = await paradisDiscoverClaudeSubagentFiles(rootTranscriptPath, isAllowed);
	const wanted = agentId.startsWith('agent-') ? agentId.slice('agent-'.length) : agentId;
	return files.find(file => file.id === wanted)?.path;
}

/**
 * Workflow の実行が最後に書いた時刻（`journal.jsonl` と子の transcript のうち最も新しいもの）。実行のフォルダが
 * 無ければ undefined。バックグラウンドの Workflow がまだ動いているかの印に使う。
 */
export async function paradisClaudeWorkflowRunLastWrite(rootTranscriptPath: string, runId: string): Promise<number | undefined> {
	if (!RUN_ID_PATTERN.test(runId)) {
		return undefined;
	}
	const dir = join(paradisClaudeSubagentsDir(rootTranscriptPath), 'workflows', runId);
	let latest: number | undefined;
	for (const entry of await readDirBounded(dir)) {
		if (!entry.isFile() || (entry.name !== 'journal.jsonl' && !AGENT_FILE_PATTERN.test(entry.name))) {
			continue;
		}
		const stat = await fs.stat(join(dir, entry.name)).catch(() => undefined);
		if (stat !== undefined && (latest === undefined || stat.mtimeMs > latest)) {
			latest = stat.mtimeMs;
		}
	}
	return latest;
}
