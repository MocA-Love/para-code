/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `claude attach <名前>`（Claude Code 2.1.290 から）の名前を、背景セッション（job）の会話 id に引き直す。
//
// 背景セッションは `$CLAUDE_CONFIG_DIR/jobs/<8 桁の短い id>/state.json` に `name`（/rename の名前か自動の名前）と
// `sessionId` を持つ（2.1.289〜2.1.291 で実測）。CLI の名前の照合は 2.1.291 の実行ファイルで読んだ形に合わせる:
// 引数の前後の空白を除いて小文字にし、job の名前と完全一致または部分一致したものが候補。候補がちょうど 1 つの
// ときだけ attach する（完全一致があっても部分一致がほかにあれば決めない）。1〜8 桁の 16 進だけの引数は名前と
// しては読まない（id の先頭として扱う）。終わった job も候補に入る。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';

/** 背景セッションの記録のうち、名前の照合に使う分。 */
export interface IParadisClaudeJob {
	/** jobs の下のディレクトリ名（8 桁の短い id）。 */
	readonly shortId: string;
	readonly sessionId: string | undefined;
	readonly name: string | undefined;
}

/** CLI が名前として読まない引数（id の先頭として扱う）。 */
const CLAUDE_ID_LIKE_QUERY = /^[a-f0-9]{1,8}$/;
const CLAUDE_JOB_SHORT_ID = /^[a-f0-9]{8}$/;
/** 名前の長さの上限（プロセス表から読むので、異常に長い行は相手にしない）。 */
const MAX_NAME_QUERY_LENGTH = 1_024;

/**
 * `claude attach` の引数を名前の照合に使う形（前後の空白を除いて小文字）にする。
 * 名前として読まない引数（空・1〜8 桁の 16 進だけ・長すぎる）は undefined。
 */
export function paradisClaudeAttachNameQuery(argument: string): string | undefined {
	const query = argument.trim().toLowerCase();
	if (query.length === 0 || query.length > MAX_NAME_QUERY_LENGTH || CLAUDE_ID_LIKE_QUERY.test(query)) {
		return undefined;
	}
	return query;
}

/** 名前が `query`（paradisClaudeAttachNameQuery の結果）に当たる job がちょうど 1 つならそれを返す。 */
export function paradisSelectClaudeJobByName(jobs: readonly IParadisClaudeJob[], query: string): IParadisClaudeJob | undefined {
	const matches = jobs.filter(job => job.name !== undefined && job.name.toLowerCase().includes(query));
	return matches.length === 1 ? matches[0] : undefined;
}

/** hook の会話 id（無ければ transcript の会話 id）が、その job の会話か。 */
export function paradisClaudeJobOwnsSession(job: IParadisClaudeJob, sessionId: string | undefined): boolean {
	if (sessionId === undefined || sessionId.length === 0) {
		return false;
	}
	const lower = sessionId.toLowerCase();
	return lower.startsWith(job.shortId) || (job.sessionId !== undefined && job.sessionId.toLowerCase() === lower);
}

/** 読む job の上限。 */
const MAX_JOBS = 1_024;
/** state.json の大きさの上限（実測では数 KB）。 */
const MAX_STATE_BYTES = 256 * 1024;

/** `<claudeHome>/jobs/*\/state.json` を読む。読めないものは飛ばす。 */
export async function paradisReadClaudeJobs(claudeHome: string): Promise<readonly IParadisClaudeJob[]> {
	const jobsDir = join(claudeHome, 'jobs');
	let names: string[];
	try {
		names = await fs.readdir(jobsDir);
	} catch {
		return [];
	}
	const jobs: IParadisClaudeJob[] = [];
	for (const shortId of names) {
		if (jobs.length >= MAX_JOBS) {
			break;
		}
		if (!CLAUDE_JOB_SHORT_ID.test(shortId)) {
			continue;
		}
		const statePath = join(jobsDir, shortId, 'state.json');
		try {
			const stat = await fs.stat(statePath);
			if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
				continue;
			}
			const parsed: unknown = JSON.parse(await fs.readFile(statePath, 'utf8'));
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				continue;
			}
			const record = parsed as { readonly name?: unknown; readonly sessionId?: unknown };
			jobs.push({
				shortId,
				sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
				name: typeof record.name === 'string' ? record.name : undefined,
			});
		} catch { /* 書きかけ・消えた直後は飛ばす */ }
	}
	return jobs;
}

/** 読んだ結果を使い回す時間。daemon の会話の hook ごとに jobs を読み直さないため。 */
const JOBS_CACHE_MS = 2_000;

/** `paradisReadClaudeJobs` を短い時間だけ使い回す読み手を作る。 */
export function paradisCachedClaudeJobsReader(readJobs: (claudeHome: string) => Promise<readonly IParadisClaudeJob[]> = paradisReadClaudeJobs, now: () => number = Date.now): (claudeHome: string) => Promise<readonly IParadisClaudeJob[]> {
	let cached: { readonly claudeHome: string; readonly at: number; readonly jobs: Promise<readonly IParadisClaudeJob[]> } | undefined;
	return claudeHome => {
		const at = now();
		if (cached === undefined || cached.claudeHome !== claudeHome || at - cached.at > JOBS_CACHE_MS) {
			cached = { claudeHome, at, jobs: readJobs(claudeHome) };
		}
		return cached.jobs;
	};
}
