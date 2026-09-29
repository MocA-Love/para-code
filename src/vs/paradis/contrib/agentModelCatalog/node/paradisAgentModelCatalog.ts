/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// インストール済みの Claude Code / Codex から、選べるモデルの一覧を取る（shared process）。
//
// CLI を起こすのは重いので、結果は `<userData>/paradis-agent-models.json` に残し、CLI の
// `--version` が変わったとき（と、念のため1日経ったとき）だけ取り直す。取れなかったときは
// 前回の結果を返し、それも無ければ何も返さない（画面側は固定の候補のまま）。
//
// Claude の「既定」のエフォートは一覧に無く、利用者の Claude Code の設定で変わるので、キャッシュには
// 入れず、返すたびに `settings.json` から当てはめる。

import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { Event } from '../../../../base/common/event.js';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { IParadisRunAgentCliOptions, IParadisRunAgentCliResult, paradisDetachedAgentCliEnv, paradisResolveAgentCli, paradisRunAgentCli } from '../../../node/paradisAgentCli.js';
import { paradisStartCodexAppServerRpc } from '../../../node/paradisCodexAppServerRpc.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { PARADIS_CODEX_LAUNCHER_DIR_ENV_VAR } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisClaudeConfigDir, paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisAgentModelCatalog,
	IParadisClaudeEffortSettings,
	IParadisDiscoveredModel,
	PARADIS_AGENT_MODEL_CATALOG_CHANNEL,
	PARADIS_CLAUDE_MODEL_LIST_ARGS,
	PARADIS_CLAUDE_MODEL_LIST_STDIN,
	PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG,
	ParadisCatalogAgentId,
	paradisApplyClaudeDefaultEfforts,
	paradisCodexModelListNextCursor,
	paradisParseClaudeModelList,
	paradisParseCodexModelList,
	paradisReadClaudeEffortSettings,
} from '../common/paradisAgentModelCatalog.js';

const AGENTS: readonly ParadisCatalogAgentId[] = ['claude', 'codex'];

/** 版が同じでも、この時間が経ったら取り直す（Codex のモデル一覧は CLI の外で増えることがある）。 */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 窓が続けて開いたときに、そのたび `--version` を起こさないための間隔。 */
const RECHECK_INTERVAL_MS = 60 * 1000;
/**
 * 一覧を取れなかった CLI（一覧を返さない古い版など）に、同じ版のまま聞き直すまでの間隔。取れないたびに
 * `claude -p`（最大 30 秒）や `codex app-server` を起こし直さないため。版が変われば待たずに聞く。
 */
const PROBE_FAILURE_RETRY_MS = 60 * 60 * 1000;
const VERSION_TIMEOUT_MS = 10_000;
const CLAUDE_PROBE_TIMEOUT_MS = 30_000;
const CODEX_MAX_PAGES = 5;

export interface IParadisResolvedCli {
	readonly command: string;
	readonly env: NodeJS.ProcessEnv;
}

interface ICachedCatalog extends IParadisAgentModelCatalog {
	/** 取得に使った実行ファイル。別の場所の CLI に替わったら取り直す。 */
	readonly command: string;
}

/** サービスが使う外部とのやり取り（テストでは差し替える）。 */
export interface IParadisAgentModelCatalogBackend {
	resolve(agentId: ParadisCatalogAgentId): Promise<IParadisResolvedCli | undefined>;
	/** `--version` の出力。取れなければ undefined。 */
	version(cli: IParadisResolvedCli): Promise<string | undefined>;
	probe(agentId: ParadisCatalogAgentId, cli: IParadisResolvedCli): Promise<IParadisDiscoveredModel[]>;
	readCache(): Promise<Record<string, ICachedCatalog>>;
	writeCache(cache: Record<string, ICachedCatalog>): Promise<void>;
	/** Claude Code の設定のうち、`--effort` を付けないときのエフォートを決める部分。読めなければ空。 */
	claudeEffortSettings(cli: IParadisResolvedCli): Promise<IParadisClaudeEffortSettings>;
	now(): number;
}

export class ParadisAgentModelCatalogService {

	private cache: Promise<Record<string, ICachedCatalog>> | undefined;
	private inFlight: Promise<IParadisAgentModelCatalog[]> | undefined;
	private lastResult: { readonly at: number; readonly catalogs: IParadisAgentModelCatalog[] } | undefined;
	/** 一覧を取れなかった CLI（実行ファイルと版）と、その時刻。 */
	private readonly failedProbes = new Map<ParadisCatalogAgentId, { readonly command: string; readonly version: string; readonly at: number }>();

	constructor(
		private readonly backend: IParadisAgentModelCatalogBackend,
		private readonly logService: ILogService,
	) { }

	getCatalogs(): Promise<IParadisAgentModelCatalog[]> {
		if (this.lastResult !== undefined && this.backend.now() - this.lastResult.at < RECHECK_INTERVAL_MS) {
			return Promise.resolve(this.lastResult.catalogs);
		}
		this.inFlight ??= this.collect().finally(() => { this.inFlight = undefined; });
		return this.inFlight;
	}

	private async collect(): Promise<IParadisAgentModelCatalog[]> {
		const results = await Promise.all(AGENTS.map(agentId => this.catalogFor(agentId).catch(error => {
			this.logService.warn(`[ParadisAgentModelCatalog] ${agentId}: failed to read the model list`, error);
			return undefined;
		})));
		const catalogs = results.filter((catalog): catalog is IParadisAgentModelCatalog => catalog !== undefined);
		this.lastResult = { at: this.backend.now(), catalogs };
		return catalogs;
	}

	private readCache(): Promise<Record<string, ICachedCatalog>> {
		this.cache ??= this.backend.readCache().catch(() => ({}));
		return this.cache;
	}

	private async catalogFor(agentId: ParadisCatalogAgentId): Promise<IParadisAgentModelCatalog | undefined> {
		const cli = await this.backend.resolve(agentId);
		if (cli === undefined) {
			return undefined;
		}
		const catalog = await this.cachedOrProbed(agentId, cli);
		if (catalog === undefined || agentId !== 'claude') {
			return catalog;
		}
		const settings = await this.backend.claudeEffortSettings(cli).catch(() => ({}));
		return { ...catalog, models: paradisApplyClaudeDefaultEfforts(catalog.models, settings) };
	}

	private async cachedOrProbed(agentId: ParadisCatalogAgentId, cli: IParadisResolvedCli): Promise<IParadisAgentModelCatalog | undefined> {
		const cached = (await this.readCache())[agentId];
		const version = await this.backend.version(cli);
		if (version === undefined) {
			// CLI が壊れている・答えない。前回の一覧があればそれを使う
			return cached !== undefined && cached.command === cli.command ? publicCatalog(cached) : undefined;
		}
		if (cached !== undefined && cached.command === cli.command && cached.cliVersion === version && this.backend.now() - cached.fetchedAt < CATALOG_MAX_AGE_MS) {
			return publicCatalog(cached);
		}
		const fallback = cached !== undefined && cached.command === cli.command ? publicCatalog(cached) : undefined;
		const failed = this.failedProbes.get(agentId);
		if (failed !== undefined && failed.command === cli.command && failed.version === version && this.backend.now() - failed.at < PROBE_FAILURE_RETRY_MS) {
			return fallback;
		}
		let models: IParadisDiscoveredModel[] = [];
		try {
			models = await this.backend.probe(agentId, cli);
		} catch (error) {
			this.logService.warn(`[ParadisAgentModelCatalog] ${agentId} ${version}: could not list models`, error);
		}
		if (models.length === 0) {
			this.failedProbes.set(agentId, { command: cli.command, version, at: this.backend.now() });
			return fallback;
		}
		this.failedProbes.delete(agentId);
		const entry: ICachedCatalog = { agentId, cliVersion: version, models, fetchedAt: this.backend.now(), command: cli.command };
		// 同じ入れ物を書き換える（claude と codex を並べて取るので、写しを作ると片方の結果が消える）
		const cache = await this.readCache();
		cache[agentId] = entry;
		await this.backend.writeCache({ ...cache }).catch(error => this.logService.warn('[ParadisAgentModelCatalog] failed to save the cache', error));
		this.logService.info(`[ParadisAgentModelCatalog] ${agentId} ${version}: ${models.map(model => model.id).join(', ')}`);
		return publicCatalog(entry);
	}
}

function publicCatalog(entry: ICachedCatalog): IParadisAgentModelCatalog {
	return { agentId: entry.agentId, cliVersion: entry.cliVersion, models: entry.models, fetchedAt: entry.fetchedAt };
}

export class ParadisAgentModelCatalogChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisAgentModelCatalogService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string): Promise<T> {
		if (command === 'getCatalogs') {
			return this.service.getCatalogs() as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}
}

// ---------- 実物の backend ----------

const CACHE_FILE_NAME = 'paradis-agent-models.json';
/**
 * キャッシュの形の版。一覧の読み方を変えたら上げる（古い版の中身は捨てて取り直す）。
 * 2: Claude の名前を正式なモデル id から作り、`resolvedModel` を残すようにした。
 */
const CACHE_FORMAT_VERSION = 2;

function isCachedCatalog(value: unknown, agentId: string): value is ICachedCatalog {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const entry = value as Partial<ICachedCatalog>;
	return entry.agentId === agentId
		&& typeof entry.cliVersion === 'string'
		&& typeof entry.command === 'string'
		&& typeof entry.fetchedAt === 'number'
		&& Array.isArray(entry.models)
		&& entry.models.every(model => typeof model?.id === 'string' && Array.isArray(model.efforts) && (model.resolvedModel === undefined || typeof model.resolvedModel === 'string'));
}

/**
 * 取得に使う CLI と同じ Claude Code の設定ディレクトリ（シェルで `CLAUDE_CONFIG_DIR` を変えている人がいる）。
 * `~` で始まる値はシェルが展開しないまま渡ってくることがある（引用符で包んで export した場合）ので展開する。
 * 相対パスなど使えない値なら、この shared process の既定（{@link paradisClaudeConfigDir}）を使う。
 */
export function paradisClaudeConfigDirFor(env: NodeJS.ProcessEnv, homeDirectory: string = homedir()): string {
	const raw = env.CLAUDE_CONFIG_DIR?.trim();
	const configured = raw !== undefined && /^~(?=$|[\\/])/.test(raw) ? join(homeDirectory, raw.slice(1)) : raw;
	return configured && isAbsolute(configured) ? configured : paradisClaudeConfigDir();
}

/** CLI を1回動かす関数（テストでは偽物に差し替える）。 */
export type ParadisAgentCliRunner = (command: string, args: readonly string[], options: IParadisRunAgentCliOptions) => Promise<IParadisRunAgentCliResult>;

/**
 * この取得のためだけに作る自分専用（0700）の空のディレクトリで `task` を動かし、終わったら
 * 成否にかかわらず消す。Linux の共有 /tmp をそのまま作業ディレクトリにすると、他の利用者が
 * 置いたプロジェクト設定を読みうるため。
 */
export async function paradisWithPrivateWorkDir<T>(parentDir: string, task: (workDir: string) => Promise<T>): Promise<T> {
	const workDir = await fs.mkdtemp(join(parentDir, 'paradis-models-'));
	try {
		return await task(workDir);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Claude Code に `list_models` を聞く。`--no-session-persistence` を知らない古い CLI
 * （stderr にこのフラグ名が出て一覧が空）では、フラグだけ外して1回だけ取り直す。
 */
export async function paradisProbeClaudeModels(cli: IParadisResolvedCli, workDir: string, runCli: ParadisAgentCliRunner = paradisRunAgentCli): Promise<IParadisDiscoveredModel[]> {
	const run = (args: readonly string[]) => runCli(cli.command, args, {
		env: cli.env,
		cwd: workDir,
		stdin: PARADIS_CLAUDE_MODEL_LIST_STDIN,
		timeoutMs: CLAUDE_PROBE_TIMEOUT_MS,
	});
	const result = await run(PARADIS_CLAUDE_MODEL_LIST_ARGS);
	const models = paradisParseClaudeModelList(result.stdout);
	if (models.length > 0 || !result.stderr.includes(PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG)) {
		return models;
	}
	return paradisParseClaudeModelList((await run(PARADIS_CLAUDE_MODEL_LIST_ARGS.filter(arg => arg !== PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG))).stdout);
}

async function probeCodex(cli: IParadisResolvedCli, workDir: string, logService: ILogService): Promise<IParadisDiscoveredModel[]> {
	const rpc = await paradisStartCodexAppServerRpc(cli.command, cli.env, logService, 'para-code-model-catalog', { codexHome: paradisCodexHome(), cwd: workDir, clientTitle: 'Para Code' });
	try {
		const models: IParadisDiscoveredModel[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < CODEX_MAX_PAGES; page++) {
			const result = await rpc.request('model/list', cursor !== undefined ? { cursor } : {});
			models.push(...paradisParseCodexModelList(result));
			cursor = paradisCodexModelListNextCursor(result);
			if (cursor === undefined) {
				break;
			}
		}
		return models;
	} finally {
		rpc.dispose();
	}
}

export function createParadisAgentModelCatalogBackend(userDataPath: string, getEnv: () => Promise<NodeJS.ProcessEnv>, logService: ILogService): IParadisAgentModelCatalogBackend {
	const cachePath = join(userDataPath, CACHE_FILE_NAME);
	return {
		async resolve(agentId) {
			const shellEnv = await getEnv();
			const launcherDir = shellEnv[PARADIS_CODEX_LAUNCHER_DIR_ENV_VAR];
			const env = paradisDetachedAgentCliEnv(shellEnv);
			const command = await paradisResolveAgentCli(agentId, env, { excludeDirs: launcherDir ? [launcherDir] : [] });
			return command === undefined ? undefined : { command, env };
		},
		async version(cli) {
			try {
				const result = await paradisRunAgentCli(cli.command, ['--version'], { env: cli.env, timeoutMs: VERSION_TIMEOUT_MS });
				const text = result.stdout.trim();
				return result.exitCode === 0 && text.length > 0 ? text : undefined;
			} catch {
				return undefined;
			}
		},
		probe: (agentId, cli) => paradisWithPrivateWorkDir(tmpdir(), workDir => agentId === 'claude' ? paradisProbeClaudeModels(cli, workDir) : probeCodex(cli, workDir, logService)),
		async readCache() {
			let raw: string;
			try {
				raw = await fs.readFile(cachePath, 'utf8');
			} catch {
				return {};
			}
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== CACHE_FORMAT_VERSION) {
				return {};
			}
			const entries = (parsed as { entries?: unknown }).entries;
			const cache: Record<string, ICachedCatalog> = {};
			if (typeof entries === 'object' && entries !== null) {
				for (const agentId of AGENTS) {
					const entry = (entries as Record<string, unknown>)[agentId];
					if (isCachedCatalog(entry, agentId)) {
						cache[agentId] = entry;
					}
				}
			}
			return cache;
		},
		writeCache: cache => paradisWriteFileAtomic(cachePath, Buffer.from(JSON.stringify({ version: CACHE_FORMAT_VERSION, entries: cache }, undefined, '\t'))),
		async claudeEffortSettings(cli) {
			const configDir = paradisClaudeConfigDirFor(cli.env);
			let settings: unknown;
			try {
				settings = JSON.parse(await fs.readFile(join(configDir, 'settings.json'), 'utf8'));
			} catch {
				settings = undefined;
			}
			return paradisReadClaudeEffortSettings(settings, cli.env.CLAUDE_CODE_EFFORT_LEVEL);
		},
		now: () => Date.now(),
	};
}

ParadisSharedProcessContributions.register('agentModelCatalog', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const shellEnv = new ParadisCachedShellEnv(logService, 'ParadisAgentModelCatalog', createParadisShellEnvResolver(logService, configurationService, environmentService.args));
	const service = new ParadisAgentModelCatalogService(createParadisAgentModelCatalogBackend(environmentService.userDataPath, () => shellEnv.getEnv(), logService), logService);
	server.registerChannel(PARADIS_AGENT_MODEL_CATALOG_CHANNEL, new ParadisAgentModelCatalogChannel(service));
});
