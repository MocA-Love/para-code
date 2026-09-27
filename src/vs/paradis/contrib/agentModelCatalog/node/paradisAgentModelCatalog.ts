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

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisDetachedAgentCliEnv, paradisResolveAgentCli, paradisRunAgentCli } from '../../../node/paradisAgentCli.js';
import { paradisOpenCodexAppServer } from '../../../node/paradisCodexAppServerSession.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { PARADIS_CODEX_LAUNCHER_DIR_ENV_VAR } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisAgentModelCatalog,
	IParadisDiscoveredModel,
	PARADIS_AGENT_MODEL_CATALOG_CHANNEL,
	PARADIS_CLAUDE_MODEL_LIST_ARGS,
	PARADIS_CLAUDE_MODEL_LIST_STDIN,
	ParadisCatalogAgentId,
	paradisCodexModelListNextCursor,
	paradisParseClaudeModelList,
	paradisParseCodexModelList,
} from '../common/paradisAgentModelCatalog.js';

const AGENTS: readonly ParadisCatalogAgentId[] = ['claude', 'codex'];

/** 版が同じでも、この時間が経ったら取り直す（Codex のモデル一覧は CLI の外で増えることがある）。 */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 窓が続けて開いたときに、そのたび `--version` を起こさないための間隔。 */
const RECHECK_INTERVAL_MS = 60 * 1000;
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
	now(): number;
}

export class ParadisAgentModelCatalogService {

	private cache: Promise<Record<string, ICachedCatalog>> | undefined;
	private inFlight: Promise<IParadisAgentModelCatalog[]> | undefined;
	private lastResult: { readonly at: number; readonly catalogs: IParadisAgentModelCatalog[] } | undefined;

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
		const cached = (await this.readCache())[agentId];
		const version = await this.backend.version(cli);
		if (version === undefined) {
			// CLI が壊れている・答えない。前回の一覧があればそれを使う
			return cached !== undefined && cached.command === cli.command ? publicCatalog(cached) : undefined;
		}
		if (cached !== undefined && cached.command === cli.command && cached.cliVersion === version && this.backend.now() - cached.fetchedAt < CATALOG_MAX_AGE_MS) {
			return publicCatalog(cached);
		}
		let models: IParadisDiscoveredModel[] = [];
		try {
			models = await this.backend.probe(agentId, cli);
		} catch (error) {
			this.logService.warn(`[ParadisAgentModelCatalog] ${agentId} ${version}: could not list models`, error);
		}
		if (models.length === 0) {
			return cached !== undefined && cached.command === cli.command ? publicCatalog(cached) : undefined;
		}
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
		&& entry.models.every(model => typeof model?.id === 'string' && Array.isArray(model.efforts));
}

export function createParadisAgentModelCatalogBackend(userDataPath: string, getEnv: () => Promise<NodeJS.ProcessEnv>): IParadisAgentModelCatalogBackend {
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
		async probe(agentId, cli) {
			if (agentId === 'claude') {
				const result = await paradisRunAgentCli(cli.command, PARADIS_CLAUDE_MODEL_LIST_ARGS, {
					env: cli.env,
					// 作業ディレクトリのプロジェクト設定を読ませない
					cwd: tmpdir(),
					stdin: PARADIS_CLAUDE_MODEL_LIST_STDIN,
					timeoutMs: CLAUDE_PROBE_TIMEOUT_MS,
				});
				return paradisParseClaudeModelList(result.stdout);
			}
			const rpc = await paradisOpenCodexAppServer({ command: cli.command, env: cli.env, codexHome: paradisCodexHome(), clientName: 'para-code-model-catalog', cwd: tmpdir() });
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
		},
		async readCache() {
			let raw: string;
			try {
				raw = await fs.readFile(cachePath, 'utf8');
			} catch {
				return {};
			}
			const parsed: unknown = JSON.parse(raw);
			const entries = typeof parsed === 'object' && parsed !== null ? (parsed as { entries?: unknown }).entries : undefined;
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
		writeCache: cache => paradisWriteFileAtomic(cachePath, Buffer.from(JSON.stringify({ version: 1, entries: cache }, undefined, '\t'))),
		now: () => Date.now(),
	};
}

ParadisSharedProcessContributions.register('agentModelCatalog', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const shellEnv = new ParadisCachedShellEnv(logService, 'ParadisAgentModelCatalog', createParadisShellEnvResolver(logService, configurationService, environmentService.args));
	const service = new ParadisAgentModelCatalogService(createParadisAgentModelCatalogBackend(environmentService.userDataPath, () => shellEnv.getEnv()), logService);
	server.registerChannel(PARADIS_AGENT_MODEL_CATALOG_CHANNEL, new ParadisAgentModelCatalogChannel(service));
});
