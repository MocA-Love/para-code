/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話ログから「スペース別の使用量」「作業実績」「全文索引」を作る shared process 側のサービス。
//
// ここで行うのはファイルの列挙と、ファイルごとの集計結果のキャッシュだけ。ファイルの中身を読むのは
// すべて worker（{@link ParadisAgentActivityWorkerHost}）。変わっていないファイル（大きさ・更新日時が同じ）
// は読み直さない。

import { promises as fs, type Dirent } from 'fs';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join, resolve } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisClaudeConfigDir, paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';
import { paradisSessionCatalogId } from '../../sessionResume/node/paradisSessionResumeChannel.js';
import {
	IParadisActivityFileSummary,
	IParadisSpaceUsageRequest,
	IParadisSpaceUsageResult,
	IParadisSpaceUsageSpace,
	IParadisWorkStatsRequest,
	IParadisWorkStatsResult,
	paradisActivityParseDay,
	paradisAggregateSpaceUsage,
	paradisAggregateWorkStats,
	paradisCreateSpaceMatcher,
} from '../common/paradisAgentActivity.js';
import { IParadisSessionIndexStatus, IParadisSessionIndexUpdateRequest } from '../common/paradisSessionIndex.js';
import { IParadisActivityParseFile, IParadisWorkerIndexFile, ParadisActivityParseReply } from '../common/paradisAgentActivityWorkerProtocol.js';
import { IParadisIndexSearchResult, IParadisIndexStats, IParadisIndexUpdateResult } from './paradisSessionIndexStore.js';
import { ParadisAgentActivityWorkerHost } from './paradisAgentActivityWorkerHost.js';

const PARSE_BATCH = 40;
const DAY_MS = 86_400_000;
/** 1回に扱うファイル数の上限（異常に多いときに shared process のメモリを食い潰さないため）。 */
const MAX_FILES = 50_000;
/** 期間の上限（UI の最大は 90 日）。 */
const MAX_RANGE_DAYS = 400;

interface ITranscriptFile extends IParadisActivityParseFile {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
}

interface ICachedSummary {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly summary: IParadisActivityFileSummary;
}

export interface IParadisAgentActivityServiceOptions {
	readonly worker: ParadisAgentActivityWorkerHost;
	/** 全文索引の SQLite の置き場所。 */
	readonly indexDbPath: string;
	readonly claudeHome?: () => string;
	readonly codexHome?: () => string;
	readonly now?: () => number;
}

function validDay(value: unknown): string | undefined {
	return typeof value === 'string' && paradisActivityParseDay(value) !== undefined ? value : undefined;
}

export class ParadisAgentActivityService extends Disposable {

	private readonly cache = new Map<string, ICachedSummary>();
	private collecting: Promise<void> = Promise.resolve();
	private indexUpdating: Promise<IParadisIndexUpdateResult> | undefined;
	private indexDeleted = false;
	private readonly claudeHome: () => string;
	private readonly codexHome: () => string;
	private readonly now: () => number;

	constructor(
		private readonly options: IParadisAgentActivityServiceOptions,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(options.worker);
		this.claudeHome = options.claudeHome ?? paradisClaudeConfigDir;
		this.codexHome = options.codexHome ?? paradisCodexHome;
		this.now = options.now ?? Date.now;
	}

	// ---- 使用量・作業実績 ----------------------------------------------------------------------

	async spaceUsage(request: IParadisSpaceUsageRequest): Promise<IParadisSpaceUsageResult> {
		const range = this.normalizeRange(request);
		const spaces = this.normalizeSpaces(request?.spaces);
		const { summaries, scannedFiles, failedFiles } = await this.collect(range.sinceMs, request?.bypassCache === true);
		const aliases = await this.withRealPaths(spaces);
		const buckets = paradisAggregateSpaceUsage(summaries, range, paradisCreateSpaceMatcher(aliases, !isLinux));
		return { buckets, scannedFiles, failedFiles, computedAt: this.now() };
	}

	async workStats(request: IParadisWorkStatsRequest): Promise<IParadisWorkStatsResult> {
		const range = this.normalizeRange(request);
		const { summaries } = await this.collect(range.sinceMs, request?.bypassCache === true);
		return { agents: paradisAggregateWorkStats(summaries, range), computedAt: this.now() };
	}

	private normalizeRange(request: { readonly since?: unknown; readonly until?: unknown } | undefined): { since: string; until: string; sinceMs: number } {
		const since = validDay(request?.since);
		const until = validDay(request?.until);
		if (!since || !until || since > until) {
			throw new Error('Invalid range.');
		}
		const sinceMs = paradisActivityParseDay(since)!;
		if ((paradisActivityParseDay(until)! - sinceMs) / DAY_MS > MAX_RANGE_DAYS) {
			throw new Error('Range too long.');
		}
		// 日付の境界はローカル時刻。前日の終わりに書かれて日付をまたいだ記録も拾えるよう、1日余分に見る。
		return { since, until, sinceMs: sinceMs - DAY_MS };
	}

	private normalizeSpaces(spaces: unknown): IParadisSpaceUsageSpace[] {
		if (!Array.isArray(spaces)) {
			return [];
		}
		const result: IParadisSpaceUsageSpace[] = [];
		for (const space of spaces.slice(0, 500)) {
			if (typeof space?.key !== 'string' || typeof space?.name !== 'string' || !Array.isArray(space?.roots)) {
				continue;
			}
			const roots = space.roots.filter((root: unknown): root is string => typeof root === 'string' && root.length > 1 && root.length < 4096 && resolve(root) === root.replace(/[\\/]+$/, '')).slice(0, 8);
			if (roots.length > 0) {
				result.push({ key: space.key.slice(0, 1000), name: space.name.slice(0, 500), roots });
			}
		}
		return result;
	}

	/** エージェントはシンボリックリンクを解決した作業ディレクトリを記録することがあるので、両方の綴りで突き合わせる。 */
	private async withRealPaths(spaces: readonly IParadisSpaceUsageSpace[]): Promise<IParadisSpaceUsageSpace[]> {
		return Promise.all(spaces.map(async space => {
			const real = await Promise.all(space.roots.map(root => fs.realpath(root).catch(() => root)));
			return { ...space, roots: [...new Set([...space.roots, ...real])] };
		}));
	}

	/**
	 * `sinceMs` 以降に更新された会話ログを列挙し、変わったファイルだけ worker で読み直す。
	 * 同時に呼ばれたら順に処理する（2回目は1回目のキャッシュをそのまま使える）。
	 */
	private collect(sinceMs: number, bypassCache: boolean): Promise<{ summaries: IParadisActivityFileSummary[]; scannedFiles: number; failedFiles: number }> {
		const run = async () => {
			const files = await this.listTranscripts();
			const present = new Set(files.map(file => file.path));
			for (const path of [...this.cache.keys()]) {
				if (!present.has(path)) {
					this.cache.delete(path);
				}
			}
			const inRange = files.filter(file => file.mtimeMs >= sinceMs);
			const stale = inRange.filter(file => {
				const cached = this.cache.get(file.path);
				return bypassCache || !cached || cached.dev !== file.dev || cached.ino !== file.ino || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs;
			});
			let failedFiles = 0;
			for (let index = 0; index < stale.length; index += PARSE_BATCH) {
				const batch = stale.slice(index, index + PARSE_BATCH);
				const replies = await this.options.worker.request<ParadisActivityParseReply>({
					op: 'parse',
					files: batch.map(file => ({ path: file.path, agent: file.agent, subagentFile: file.subagentFile })),
				});
				batch.forEach((file, position) => {
					const summary = replies[position];
					if (summary) {
						this.cache.set(file.path, { dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs, summary });
					} else {
						failedFiles++;
					}
				});
			}
			const summaries = inRange.map(file => this.cache.get(file.path)?.summary).filter((summary): summary is IParadisActivityFileSummary => summary !== undefined);
			return { summaries, scannedFiles: inRange.length, failedFiles };
		};
		const next = this.collecting.then(run, run);
		this.collecting = next.then(() => undefined, () => undefined);
		return next;
	}

	/** Claude Code と Codex の会話ログを列挙する。シンボリックリンクはたどらない。 */
	private async listTranscripts(): Promise<ITranscriptFile[]> {
		const files: ITranscriptFile[] = [];
		const add = async (path: string, agent: ITranscriptFile['agent'], subagentFile: boolean) => {
			if (files.length >= MAX_FILES) {
				return;
			}
			try {
				const stat = await fs.lstat(path);
				if (stat.isFile()) {
					files.push({ path, agent, subagentFile, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
				}
			} catch { /* 列挙の途中で消えた */ }
		};
		const readDir = async (path: string): Promise<Dirent[]> => {
			try {
				return await fs.readdir(path, { withFileTypes: true });
			} catch {
				return [];
			}
		};

		const projects = join(this.claudeHome(), 'projects');
		for (const project of await readDir(projects)) {
			if (!project.isDirectory()) {
				continue;
			}
			const projectPath = join(projects, project.name);
			for (const entry of await readDir(projectPath)) {
				if (entry.isFile() && entry.name.endsWith('.jsonl')) {
					await add(join(projectPath, entry.name), 'claude', false);
				} else if (entry.isDirectory()) {
					const subagents = join(projectPath, entry.name, 'subagents');
					for (const sub of await readDir(subagents)) {
						if (sub.isFile() && sub.name.endsWith('.jsonl')) {
							await add(join(subagents, sub.name), 'claude', true);
						}
					}
				}
			}
		}

		const walkCodex = async (path: string, depth: number): Promise<void> => {
			for (const entry of await readDir(path)) {
				const child = join(path, entry.name);
				if (entry.isDirectory() && depth < 4) {
					await walkCodex(child, depth + 1);
				} else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
					await add(child, 'codex', false);
				}
			}
		};
		await walkCodex(join(this.codexHome(), 'sessions'), 0);
		return files;
	}

	// ---- 全文索引 ----------------------------------------------------------------------------

	/**
	 * 索引を会話ログに合わせる。保存日数より古い会話と、消された会話の分は索引から消える。
	 * 更新中にもう一度呼ばれたら、実行中のものを返す（呼び出し側は数十秒おきにしか呼ばない）。
	 */
	indexUpdate(request: IParadisSessionIndexUpdateRequest): Promise<IParadisIndexUpdateResult> {
		if (this.indexUpdating) {
			return this.indexUpdating;
		}
		const retentionDays = typeof request?.retentionDays === 'number' && request.retentionDays > 0 ? Math.min(request.retentionDays, 3650) : 90;
		const includeToolOutput = request?.includeToolOutput === true;
		this.indexDeleted = false;
		const update = (async () => {
			await fs.mkdir(join(this.options.indexDbPath, '..'), { recursive: true });
			const threshold = this.now() - retentionDays * DAY_MS;
			const files: IParadisWorkerIndexFile[] = (await this.listTranscripts())
				.filter(file => !file.subagentFile && file.mtimeMs >= threshold)
				.sort((a, b) => b.mtimeMs - a.mtimeMs)
				.map(file => ({
					path: file.path, agent: file.agent, catalogId: paradisSessionCatalogId(file.agent, file.path),
					dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs,
				}));
			return this.options.worker.request<IParadisIndexUpdateResult>({ op: 'indexUpdate', dbPath: this.options.indexDbPath, files, includeToolOutput });
		})();
		this.indexUpdating = update;
		void update.finally(() => {
			if (this.indexUpdating === update) {
				this.indexUpdating = undefined;
			}
		}).catch(error => this.logService.warn('[ParadisAgentActivity] session index update failed', error));
		return update;
	}

	async indexSearch(query: string): Promise<IParadisIndexSearchResult> {
		if (typeof query !== 'string' || !(await this.indexExists())) {
			return { covered: [], matches: [] };
		}
		return this.options.worker.request<IParadisIndexSearchResult>({ op: 'indexSearch', dbPath: this.options.indexDbPath, query: query.slice(0, 200) });
	}

	async indexStatus(): Promise<IParadisSessionIndexStatus> {
		if (!(await this.indexExists())) {
			return { exists: false, files: 0, messages: 0, updating: this.indexUpdating !== undefined };
		}
		const stats = await this.options.worker.request<IParadisIndexStats>({ op: 'indexStats', dbPath: this.options.indexDbPath });
		return { exists: true, files: stats.files, messages: stats.messages, updating: this.indexUpdating !== undefined };
	}

	/** 索引を消す。更新中なら終わるのを待ってから消す（書きかけのファイルを残さない）。 */
	async indexDelete(): Promise<void> {
		this.indexDeleted = true;
		await this.indexUpdating?.catch(() => undefined);
		if (this.options.worker.running) {
			await this.options.worker.request({ op: 'indexClose' }).catch(() => undefined);
		}
		for (const suffix of ['', '-wal', '-shm', '-journal']) {
			await fs.rm(`${this.options.indexDbPath}${suffix}`, { force: true });
		}
	}

	private async indexExists(): Promise<boolean> {
		if (this.indexDeleted) {
			return false;
		}
		try {
			return (await fs.stat(this.options.indexDbPath)).isFile();
		} catch {
			return false;
		}
	}
}
