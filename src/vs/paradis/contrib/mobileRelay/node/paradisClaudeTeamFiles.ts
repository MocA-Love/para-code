/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Claude Code のエージェントチームのファイルを読む（モバイルのチームのカード。agent.teams.v1）。
 *
 * - `<Claude の置き場>/teams/<チーム>/config.json`: 時刻が変わったときだけ読む。置き場はリーダーの transcript
 *   （`<置き場>/projects/<cwd>/<session>.jsonl`）から決める。形が違う（SSH の写しなど）ときは読まない
 * - `<session>/subagents/agent-<id>.jsonl`（in-process のメンバーの記録）: 前に読んだ位置から追記だけ読む。初めは
 *   末尾の {@link MEMBER_CHUNK_BYTES} から読む（最後のツールと、それ以降の SendMessage が分かればよい）
 *
 * パスは許可された親の transcript から決まった形で組み立て（チーム名・子の ID は形を確かめる）、シンボリックリンクは辿らない。
 */

import { promises as fs } from 'fs';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { IParadisTeamConfig, IParadisTeamMemberRead, paradisParseTeamConfig, paradisTeamMemberRead } from '../../agentChat/common/paradisAgentTeams.js';
import { paradisClaudeSubagentsDir } from './paradisClaudeSubagentFiles.js';
import { paradisOpenPlainFile } from './paradisClaudeWorkflowFiles.js';

const TEAM_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const AGENT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_CONFIG_BYTES = 256 * 1024;
/** 1 回に読むメンバーの記録の量。 */
const MEMBER_CHUNK_BYTES = 512 * 1024;
/** これより長い行は読まない（ツールの結果の全文。最後のツールと SendMessage は assistant の短い行にある）。 */
const MAX_LINE_BYTES = 256 * 1024;

/** メンバーの記録の読んだ位置（呼び出し側がメンバーごとに持つ）。 */
export interface IParadisTeamMemberReadState {
	offset: number;
	/** 長すぎる行・途中から読み始めた行の残り（次の改行まで捨てる）。 */
	skippingLine: boolean;
	started: boolean;
}

export function paradisNewTeamMemberReadState(): IParadisTeamMemberReadState {
	return { offset: 0, skippingLine: false, started: false };
}

/** `config.json` の読んだ時刻（チームごと）。 */
export interface IParadisTeamConfigReadState {
	mtime?: number;
}

/** リーダーの transcript から、Claude の置き場（`~/.claude`。`CLAUDE_CONFIG_DIR` でも同じ形）を決める。 */
export function paradisClaudeHomeOfTranscript(rootTranscriptPath: string): string | undefined {
	const projectDir = dirname(rootTranscriptPath);
	const projectsDir = dirname(projectDir);
	return basename(projectsDir) === 'projects' && /\.jsonl$/i.test(rootTranscriptPath) ? dirname(projectsDir) : undefined;
}

/** チームの `config.json` を、前に読んだ後に書き換わっていれば読む。 */
export async function paradisReadClaudeTeamConfig(rootTranscriptPath: string, teamName: string, state: IParadisTeamConfigReadState, isAllowed: (path: string) => Promise<boolean>): Promise<IParadisTeamConfig | undefined> {
	const home = paradisClaudeHomeOfTranscript(rootTranscriptPath);
	if (home === undefined || !TEAM_NAME.test(teamName) || !await isAllowed(rootTranscriptPath)) {
		return undefined;
	}
	let teamsReal: string;
	try {
		teamsReal = await fs.realpath(join(home, 'teams'));
	} catch {
		return undefined;
	}
	const path = join(home, 'teams', teamName, 'config.json');
	let mtime: number;
	try {
		const stat = await fs.lstat(path);
		if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
			return undefined;
		}
		mtime = stat.mtimeMs;
	} catch {
		return undefined;
	}
	if (state.mtime === mtime) {
		return undefined;
	}
	const handle = await paradisOpenPlainFile(path, teamsReal);
	if (handle === undefined) {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(MAX_CONFIG_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, MAX_CONFIG_BYTES, 0);
		const config = paradisParseTeamConfig(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
		state.mtime = mtime;
		return config;
	} catch {
		return undefined; // 書きかけ（JSON として読めない）。時刻を覚えず次にもう一度読む
	} finally {
		await handle.close();
	}
}

/** in-process のメンバーの記録を、前に読んだ位置から読む。`more` は 1 回に読む量の上限で止めた。 */
export async function paradisReadClaudeTeamMember(rootTranscriptPath: string, agentId: string, state: IParadisTeamMemberReadState, isAllowed: (path: string) => Promise<boolean>): Promise<{ readonly read: IParadisTeamMemberRead; readonly more: boolean }> {
	const empty = { read: { sends: [] }, more: false };
	if (!AGENT_ID.test(agentId) || !await isAllowed(rootTranscriptPath)) {
		return empty;
	}
	const subagentsDir = paradisClaudeSubagentsDir(rootTranscriptPath);
	let within: string;
	try {
		within = await fs.realpath(subagentsDir);
	} catch {
		return empty;
	}
	const handle = await paradisOpenPlainFile(join(subagentsDir, `agent-${agentId}.jsonl`), within);
	if (handle === undefined) {
		return empty;
	}
	try {
		const size = (await handle.stat()).size;
		if (!state.started || size < state.offset) {
			// 初めて（か作り直された）。末尾から読み、途中から始まる最初の行は捨てる
			state.started = true;
			state.offset = Math.max(0, size - MEMBER_CHUNK_BYTES);
			state.skippingLine = state.offset > 0;
		}
		if (size <= state.offset) {
			return empty;
		}
		const length = Math.min(MEMBER_CHUNK_BYTES, size - state.offset);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
		let body = buffer.subarray(0, bytesRead);
		let consumed = 0;
		if (state.skippingLine) {
			const newline = body.indexOf(0x0a);
			if (newline < 0) {
				state.offset += bytesRead;
				return { read: { sends: [] }, more: state.offset < size };
			}
			consumed = newline + 1;
			body = body.subarray(consumed);
			state.skippingLine = false;
		}
		const lastNewline = body.lastIndexOf(0x0a);
		if (lastNewline < 0) {
			if (bytesRead === MEMBER_CHUNK_BYTES) {
				// 1 行が読む量を超えた。捨てて次の行から
				state.skippingLine = true;
				state.offset += bytesRead;
			} else {
				state.offset += consumed; // 書きかけの行。次に行の頭から読む
			}
			return { read: { sends: [] }, more: bytesRead === MEMBER_CHUNK_BYTES && state.offset < size };
		}
		const lines: Record<string, unknown>[] = [];
		for (const line of body.subarray(0, lastNewline).toString('utf8').split('\n')) {
			if (line.length === 0 || line.length > MAX_LINE_BYTES || (!line.includes('"assistant"') && !line.includes('"user"'))) {
				continue;
			}
			try {
				const parsed: unknown = JSON.parse(line);
				if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
					lines.push(parsed as Record<string, unknown>);
				}
			} catch {
				// 壊れた行は飛ばす
			}
		}
		state.offset += consumed + lastNewline + 1;
		return { read: paradisTeamMemberRead(lines), more: bytesRead === MEMBER_CHUNK_BYTES && state.offset < size };
	} catch {
		return empty;
	} finally {
		await handle.close();
	}
}
