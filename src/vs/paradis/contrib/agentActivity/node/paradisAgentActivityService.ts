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
import { Event } from '../../../../base/common/event.js';
import { dirname, join, resolve } from '../../../../base/common/path.js';
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
import { IParadisSessionIndexStatus, PARADIS_SESSION_INDEX_DEFAULT_RETENTION_DAYS } from '../common/paradisSessionIndex.js';
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

interface IParadisSessionIndexSettingsSnapshot {
	readonly enabled: boolean;
	readonly retentionDays: number;
	readonly includeToolOutput: boolean;
}

export interface IParadisAgentActivityServiceOptions {
	readonly worker: ParadisAgentActivityWorkerHost;
	/** 全文索引の SQLite の置き場所。 */
	readonly indexDbPath: string;
	/** 全文索引の設定（shared process の設定サービスから読む）。未指定なら既定値（オン・90日・ツール出力なし）。 */
	readonly indexSettings?: () => { readonly enabled?: unknown; readonly retentionDays?: unknown; readonly includeToolOutput?: unknown };
	/** 全文索引の設定が変わった。 */
	readonly onDidChangeIndexSettings?: Event<void>;
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
	private indexUpdating: Promise<IParadisIndexUpdateResult | undefined> | undefined;
	private indexDeleting: Promise<void> | undefined;
	private reconciling: Promise<void> = Promise.resolve();
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
		if (options.onDidChangeIndexSettings) {
			this._register(options.onDidChangeIndexSettings(() => void this.reconcileIndex()));
		}
		// 起動時にも照合する（アプリを閉じている間に設定がオフにされた場合など、変更の通知は来ない）。
		void this.reconcileIndex();
	}

	// ---- 使用量・作業実績 ----------------------------------------------------------------------

	async spaceUsage(request: IParadisSpaceUsageRequest): Promise<IParadisSpaceUsageResult> {
		const range = this.normalizeRange(request);
		const spaces = this.normalizeSpaces(request?.spaces);
		const { summaries, scannedFiles, failedFiles } = await this.collect(range.sinceMs);
		const aliases = await this.withRealPaths(spaces);
		const buckets = paradisAggregateSpaceUsage(summaries, range, paradisCreateSpaceMatcher(aliases, !isLinux));
		return { buckets, scannedFiles, failedFiles, computedAt: this.now() };
	}

	async workStats(request: IParadisWorkStatsRequest): Promise<IParadisWorkStatsResult> {
		const range = this.normalizeRange(request);
		const { summaries } = await this.collect(range.sinceMs);
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
	 * 同時に呼ばれたら順に処理する（2回目は1回目のキャッシュをそのまま使える）。更新ボタンでも、大きさ・
	 * 更新日時・inode が同じファイルは読み直さない（中身が変わっていないので、読み直しても結果は同じ）。
	 */
	private collect(sinceMs: number): Promise<{ summaries: IParadisActivityFileSummary[]; scannedFiles: number; failedFiles: number }> {
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
				return !cached || cached.dev !== file.dev || cached.ino !== file.ino || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs;
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
			// 古いファイルから渡す。再開・分岐で写された応答や依頼は、集計側で「先に来たファイル」の分として数えるため、
			// 写した先（新しいファイル）ではなく元の会話に付く。
			const summaries = [...inRange].sort((a, b) => a.mtimeMs - b.mtimeMs).map(file => this.cache.get(file.path)?.summary).filter((summary): summary is IParadisActivityFileSummary => summary !== undefined);
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
	//
	// 「オフなら索引は残っていない」はここ（shared process）で守る。起動したときと設定が変わったときに
	// 設定と索引を照合し、オフなら消す。画面側がオフを知る前に更新を頼んできても、設定がオフなら断る。

	/** 起動時・設定の変更時に、設定と索引を照合する。重ねて呼ばれたら最後の1回にまとめる。 */
	private reconcileIndex(): Promise<void> {
		const run = async () => {
			const settings = this.indexSettings();
			if (!settings.enabled) {
				await this.indexDelete();
				return;
			}
			if (await this.indexExists()) {
				await this.options.worker.request({
					op: 'indexPrune',
					dbPath: this.options.indexDbPath,
					retentionThresholdMs: this.now() - settings.retentionDays * DAY_MS,
					includeToolOutput: settings.includeToolOutput,
				});
			}
		};
		const next = this.reconciling.then(run, run);
		this.reconciling = next.catch(error => this.logService.warn('[ParadisAgentActivity] unable to reconcile the session index with the settings', error));
		return this.reconciling;
	}

	/** 起動時・設定の変更時の照合が終わるのを待つ（テスト・診断用）。 */
	whenIndexReconciled(): Promise<void> {
		return this.reconciling;
	}

	private indexSettings(): IParadisSessionIndexSettingsSnapshot {
		const value = this.options.indexSettings?.() ?? {};
		const retentionDays = typeof value.retentionDays === 'number' && value.retentionDays > 0 ? Math.min(value.retentionDays, 3650) : PARADIS_SESSION_INDEX_DEFAULT_RETENTION_DAYS;
		// 既定はオン。明示的に false のときだけオフ。
		return { enabled: value.enabled !== false, retentionDays, includeToolOutput: value.includeToolOutput === true };
	}

	/**
	 * 索引を会話ログに合わせる。保存日数より古い会話と、消された会話の分は索引から消える。
	 * 設定がオフのとき・索引を消している最中は何もしない。更新中にもう一度呼ばれたら、実行中のものを返す。
	 */
	indexUpdate(): Promise<IParadisIndexUpdateResult | undefined> {
		const settings = this.indexSettings();
		if (!settings.enabled || this.indexDeleting) {
			return Promise.resolve(undefined);
		}
		if (this.indexUpdating) {
			return this.indexUpdating;
		}
		const update = (async () => {
			await fs.mkdir(dirname(this.options.indexDbPath), { recursive: true, mode: 0o700 });
			const threshold = this.now() - settings.retentionDays * DAY_MS;
			const files: IParadisWorkerIndexFile[] = (await this.listTranscripts())
				.filter(file => !file.subagentFile && file.mtimeMs >= threshold)
				.sort((a, b) => b.mtimeMs - a.mtimeMs)
				.map(file => ({
					path: file.path, agent: file.agent, catalogId: paradisSessionCatalogId(file.agent, file.path),
					dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs,
				}));
			if (this.indexDeleting || !this.indexSettings().enabled) {
				return undefined;
			}
			return this.options.worker.request<IParadisIndexUpdateResult>({ op: 'indexUpdate', dbPath: this.options.indexDbPath, files, includeToolOutput: settings.includeToolOutput });
		})();
		this.indexUpdating = update;
		void update.finally(() => {
			if (this.indexUpdating === update) {
				this.indexUpdating = undefined;
			}
		}).catch(error => this.logService.warn('[ParadisAgentActivity] session index update failed', error));
		return update;
	}

	/**
	 * 索引で探す。設定がオフ・削除中・索引がまだ無いときは、すべて `uncovered`（従来の検索で探す）として返す。
	 * 更新の列には並ばないので、索引を作っている最中でも待たされない。
	 */
	async indexSearch(query: string, catalogIds: readonly string[]): Promise<IParadisIndexSearchResult> {
		const requested = Array.isArray(catalogIds) ? catalogIds.filter((id): id is string => typeof id === 'string').slice(0, 5000) : [];
		if (typeof query !== 'string' || !this.indexSettings().enabled || this.indexDeleting || !(await this.indexExists())) {
			return { terms: [], uncovered: requested, matches: [] };
		}
		return this.options.worker.request<IParadisIndexSearchResult>({ op: 'indexSearch', dbPath: this.options.indexDbPath, query: query.slice(0, 200), catalogIds: requested });
	}

	async indexStatus(): Promise<IParadisSessionIndexStatus> {
		const updating = this.indexUpdating !== undefined;
		if (!(await this.indexExists())) {
			return { exists: false, files: 0, messages: 0, updating };
		}
		const stats = await this.options.worker.request<IParadisIndexStats>({ op: 'indexStats', dbPath: this.options.indexDbPath });
		return { exists: true, files: stats.files, messages: stats.messages, updating };
	}

	/**
	 * 索引を消す。実行中の更新は行の切れ目で打ち切らせ、worker の中で「接続を閉じる → ファイルを消す」を
	 * 更新と同じ列で行う（書きかけのまま消したり、消した直後に作り直されたりしないように）。
	 * 同時に何度呼ばれても1回にまとめる。
	 */
	indexDelete(): Promise<void> {
		if (this.indexDeleting) {
			return this.indexDeleting;
		}
		const deleting = (async () => {
			if (this.options.worker.running) {
				await this.options.worker.request({ op: 'indexAbort' }).catch(() => undefined);
				await this.indexUpdating?.catch(() => undefined);
				await this.options.worker.request({ op: 'indexDelete', dbPath: this.options.indexDbPath });
			} else {
				await this.indexUpdating?.catch(() => undefined);
				// worker が動いていなければ開いている接続も無いので、ここで消してよい（消すためだけに worker を起こさない）。
				for (const suffix of ['', '-wal', '-shm', '-journal']) {
					await fs.rm(`${this.options.indexDbPath}${suffix}`, { force: true });
				}
			}
		})();
		this.indexDeleting = deleting;
		void deleting.finally(() => {
			if (this.indexDeleting === deleting) {
				this.indexDeleting = undefined;
			}
		}).catch(() => undefined);
		return deleting;
	}

	private async indexExists(): Promise<boolean> {
		try {
			return (await fs.stat(this.options.indexDbPath)).isFile();
		} catch {
			return false;
		}
	}
}
