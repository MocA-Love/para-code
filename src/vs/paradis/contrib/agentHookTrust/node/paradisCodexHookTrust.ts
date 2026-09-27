/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Portions adapted from stablyai/orca (MIT): src/main/codex/codex-app-server-client.ts,
// src/main/codex/codex-hook-trust-grant.ts

// Codex の hook の信頼を `codex app-server` 経由で付ける（shared process）。
//
// 手順は Codex の TUI の「Trust all」と同じ: `hooks/list` → `config/batchWrite`（`hooks.state` へ
// upsert）→ もう一度 `hooks/list` で付いたことを確かめる。確かめが合わなければ、書く前の
// config.toml のバイト列へ戻す。ハッシュは Codex が答えた `currentHash` をそのまま使い、こちらでは
// 計算しない（Orca は自前計算が Codex の版上げのたびにずれて、この方式へ移った）。
//
// 自動で付けるのは設定が `auto` のときだけ（初回は画面側が利用者に確かめて `auto` にする）。
// 起動のたびに codex を起こさないよう、「codex の版 + hooks.json + config.toml」の指紋が前回
// 確かめたときと同じなら何もしない。

import { createHash } from 'crypto';
import { promises as fs, watch } from 'fs';
import { homedir } from 'os';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, isAbsolute, join, normalize } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createParadisShellEnvResolver, ParadisCachedShellEnv } from '../../../../platform/shell/node/paradisCachedShellEnv.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { paradisDetachedAgentCliEnv, paradisResolveAgentCli, paradisRunAgentCli } from '../../../node/paradisAgentCli.js';
import { IParadisCodexRpc, ParadisCodexRpcMethodNotFoundError, paradisOpenCodexAppServer } from '../../../node/paradisCodexAppServerSession.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { paradisManagedAgentHookCommand, paradisManagedAgentHookCommandWindows } from '../../agentBrowser/common/paradisAgentHooks.js';
import { PARADIS_CODEX_LAUNCHER_DIR_ENV_VAR } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';
import {
	IParadisCodexHookListing,
	IParadisCodexHookTrustGrantResult,
	IParadisCodexHookTrustStatus,
	PARADIS_CODEX_HOOK_TRUST_CHANNEL,
	PARADIS_CODEX_HOOK_TRUST_SETTING,
	paradisCodexHookNeedsTrust,
	paradisCodexHookTrustMode,
	paradisSelectManagedCodexHooks,
} from '../common/paradisCodexHookTrust.js';

// ---------- 1つの CODEX_HOME に対する調査と付与 ----------

/** 付与の手順が使う外部とのやり取り（テストでは偽物を渡す）。 */
export interface IParadisCodexHookTrustIO {
	/** その CODEX_HOME で `codex app-server` を起こす。codex が無ければ undefined。 */
	openRpc(codexHome: string): Promise<IParadisCodexRpc | undefined>;
	/** 実体パス。無ければ undefined。 */
	realpath(path: string): Promise<string | undefined>;
}

export interface IParadisCodexHookTrustTarget {
	readonly codexHome: string;
	/** Para Code が hooks.json に書くコマンド文字列。 */
	readonly managedCommand: string;
	readonly isWindows: boolean;
}

interface IResolvedTarget {
	readonly realHome: string;
	readonly hooksPath: string;
	readonly hooksPaths: readonly string[];
}

const HOOKS_LIST_TIMEOUT_MS = 20_000;
const CONFIG_WRITE_TIMEOUT_MS = 20_000;

async function resolveTarget(target: IParadisCodexHookTrustTarget, io: IParadisCodexHookTrustIO): Promise<IResolvedTarget | undefined> {
	const hooksPath = join(target.codexHome, 'hooks.json');
	const realHooks = await io.realpath(hooksPath);
	if (realHooks === undefined) {
		return undefined;
	}
	const realHome = await io.realpath(target.codexHome) ?? target.codexHome;
	return {
		realHome,
		hooksPath,
		hooksPaths: [join(realHome, 'hooks.json'), realHooks, hooksPath],
	};
}

async function listManaged(rpc: IParadisCodexRpc, target: IParadisCodexHookTrustTarget, resolved: IResolvedTarget): Promise<IParadisCodexHookListing[]> {
	// 利用者の層の hook は cwd に関係なく列挙される。cwd はプロジェクト層の hook の範囲を決めるだけ
	const result = await rpc.request('hooks/list', { cwds: [resolved.realHome] }, HOOKS_LIST_TIMEOUT_MS);
	return paradisSelectManagedCodexHooks(result, resolved.hooksPaths, target.managedCommand, target.isWindows);
}

/** Para Code が置いた hook の信頼の状態を調べる（何も書かない）。 */
export async function paradisInspectCodexHookTrust(target: IParadisCodexHookTrustTarget, io: IParadisCodexHookTrustIO): Promise<IParadisCodexHookTrustStatus> {
	const base = { codexHome: target.codexHome, hooksPath: join(target.codexHome, 'hooks.json') };
	const resolved = await resolveTarget(target, io);
	if (resolved === undefined) {
		return { ...base, supported: true, pending: [], managedCount: 0 };
	}
	let rpc: IParadisCodexRpc | undefined;
	try {
		rpc = await io.openRpc(target.codexHome);
		if (rpc === undefined) {
			return { ...base, supported: false, pending: [], managedCount: 0, error: 'codex not found' };
		}
		const managed = await listManaged(rpc, target, resolved);
		return { ...base, supported: true, pending: managed.filter(paradisCodexHookNeedsTrust), managedCount: managed.length };
	} catch (error) {
		return { ...base, supported: !(error instanceof ParadisCodexRpcMethodNotFoundError), pending: [], managedCount: 0, error: String(error instanceof Error ? error.message : error) };
	} finally {
		rpc?.dispose();
	}
}

/** 利用者の層（`CODEX_HOME/config.toml`）の `hooks.state` と、その版。 */
interface IUserHooksState {
	readonly version: string | undefined;
	readonly state: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readUserHooksState(rpc: IParadisCodexRpc): Promise<IUserHooksState> {
	const result = await rpc.request('config/read', { includeLayers: true }, CONFIG_WRITE_TIMEOUT_MS);
	const layers = isRecord(result) && Array.isArray(result.layers) ? result.layers : [];
	const user = layers.find(layer => isRecord(layer) && isRecord(layer.name) && layer.name.type === 'user');
	if (!isRecord(user)) {
		return { version: undefined, state: {} };
	}
	const hooks = isRecord(user.config) && isRecord(user.config.hooks) ? user.config.hooks : undefined;
	return {
		version: typeof user.version === 'string' ? user.version : undefined,
		state: hooks !== undefined && isRecord(hooks.state) ? { ...hooks.state } : {},
	};
}

function trustedHashOf(entry: unknown): string | undefined {
	return isRecord(entry) && typeof entry.trusted_hash === 'string' ? entry.trusted_hash : undefined;
}

/**
 * 書いた信頼を取り消す。対象は「今もこちらが書いたハッシュのままの鍵」だけで、書く前に値が
 * あった鍵はその値へ、無かった鍵は消す。`config/read` で得た版を `expectedVersion` に渡すので、
 * その間に Codex の TUI などが config.toml を書いていれば、何も戻さずにやめる（他人の変更を消さない）。
 *
 * @returns 戻したか（戻す必要が無かったときも true）
 */
async function rollbackGrantedKeys(rpc: IParadisCodexRpc, written: Readonly<Record<string, { trusted_hash: string }>>, before: Readonly<Record<string, unknown>>): Promise<boolean> {
	const current = await readUserHooksState(rpc);
	const next = { ...current.state };
	let changed = false;
	for (const [key, value] of Object.entries(written)) {
		if (trustedHashOf(current.state[key]) !== value.trusted_hash) {
			continue; // 書いていない（書き込みが届かなかった）か、もう別の値になっている
		}
		changed = true;
		if (Object.prototype.hasOwnProperty.call(before, key)) {
			next[key] = before[key];
		} else {
			delete next[key];
		}
	}
	if (!changed) {
		return true;
	}
	await rpc.request('config/batchWrite', {
		edits: [{ keyPath: 'hooks.state', value: next, mergeStrategy: 'replace' }],
		...(current.version !== undefined ? { expectedVersion: current.version } : {}),
	}, CONFIG_WRITE_TIMEOUT_MS);
	return true;
}

/**
 * Para Code が置いた hook のうち、まだ信頼されていないものに信頼を付ける。
 * 例外は投げない（失敗は結果の outcome で返す）。
 *
 * config.toml への読み書きはすべて Codex 自身（`config/read` / `config/batchWrite`）に任せ、
 * 書くときは直前に読んだ版を `expectedVersion` に渡す。読んでから書くまでに他が書いていれば
 * Codex が書き込みを断るので、利用者や TUI の変更を上書きしない。
 */
export async function paradisGrantCodexHookTrust(target: IParadisCodexHookTrustTarget, io: IParadisCodexHookTrustIO): Promise<IParadisCodexHookTrustGrantResult> {
	const base = { codexHome: target.codexHome, hooksPath: join(target.codexHome, 'hooks.json') };
	const resolved = await resolveTarget(target, io).catch(() => undefined);
	if (resolved === undefined) {
		return { ...base, outcome: 'nothing-installed', grantedEvents: [] };
	}
	let rpc: IParadisCodexRpc | undefined;
	let attempted: { readonly written: Record<string, { trusted_hash: string }>; readonly before: Record<string, unknown> } | undefined;
	try {
		rpc = await io.openRpc(target.codexHome);
		if (rpc === undefined) {
			return { ...base, outcome: 'unsupported', grantedEvents: [], detail: 'codex not found' };
		}
		const managed = await listManaged(rpc, target, resolved);
		if (managed.length === 0) {
			return { ...base, outcome: 'nothing-installed', grantedEvents: [] };
		}
		const needing = managed.filter(paradisCodexHookNeedsTrust);
		if (needing.length === 0) {
			return { ...base, outcome: 'already-trusted', grantedEvents: [] };
		}
		const written: Record<string, { trusted_hash: string }> = {};
		for (const listing of needing) {
			written[listing.key] = { trusted_hash: listing.currentHash };
		}
		const before = await readUserHooksState(rpc);
		attempted = { written, before: before.state };
		await rpc.request('config/batchWrite', {
			edits: [{ keyPath: 'hooks.state', value: written, mergeStrategy: 'upsert' }],
			...(before.version !== undefined ? { expectedVersion: before.version } : {}),
		}, CONFIG_WRITE_TIMEOUT_MS);

		// 付いたかどうかを Codex 自身に確かめさせる。鍵とハッシュが書いたとおりで、信頼済みになっていること
		const verified = new Map((await listManaged(rpc, target, resolved)).map(listing => [listing.key, listing]));
		const failed = needing.filter(listing => {
			const after = verified.get(listing.key);
			return after === undefined || after.trustStatus !== 'trusted' || after.currentHash !== listing.currentHash;
		});
		if (failed.length > 0) {
			const rolledBack = await rollbackGrantedKeys(rpc, written, before.state).catch(() => false);
			return { ...base, outcome: 'verify-failed', grantedEvents: [], detail: `${failed.length} of ${needing.length} hooks were not trusted after the write${rolledBack ? '' : '; could not roll back'}` };
		}
		return { ...base, outcome: 'granted', grantedEvents: needing.map(listing => listing.eventName) };
	} catch (error) {
		const detail = String(error instanceof Error ? error.message : error);
		if (attempted !== undefined) {
			// 時間切れした書き込みが、戻したあとで届かないよう、先にその app-server を止める。
			// 戻すのは新しく起こした app-server で、今もこちらの書いた値のままの鍵だけ
			rpc?.dispose();
			rpc = undefined;
			const rollbackRpc = await io.openRpc(target.codexHome).catch(() => undefined);
			try {
				if (rollbackRpc !== undefined) {
					await rollbackGrantedKeys(rollbackRpc, attempted.written, attempted.before).catch(() => undefined);
				}
			} finally {
				rollbackRpc?.dispose();
			}
		}
		return { ...base, outcome: error instanceof ParadisCodexRpcMethodNotFoundError ? 'unsupported' : 'failed', grantedEvents: [], detail };
	} finally {
		rpc?.dispose();
	}
}

// ---------- ファイル操作（実物） ----------

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await fs.realpath(path);
	} catch {
		return undefined;
	}
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
	try {
		return await fs.readFile(path);
	} catch (error) {
		if (isNotFound(error)) {
			return undefined;
		}
		throw error;
	}
}

// ---------- サービス（shared process） ----------

/** サービスが使う外部とのやり取り。テストでは全部差し替える。 */
export interface IParadisCodexHookTrustBackend {
	inspect(codexHome: string): Promise<IParadisCodexHookTrustStatus>;
	grant(codexHome: string): Promise<IParadisCodexHookTrustGrantResult>;
	/** 「codex の版 + hooks.json + config.toml」の指紋。codex が無ければ undefined。 */
	fingerprint(codexHome: string): Promise<string | undefined>;
	readLedger(): Promise<Record<string, string>>;
	writeLedger(ledger: Record<string, string>): Promise<void>;
	/** CODEX_HOME の中の hooks.json の変化を知らせる。 */
	watchHooks(codexHome: string, listener: () => void): IDisposable;
	schedule(delayMs: number, callback: () => void): IDisposable;
}

export interface IParadisCodexHookTrustServiceOptions {
	/** 既定の CODEX_HOME（`$CODEX_HOME`、無ければ `~/.codex`）。 */
	readonly defaultCodexHome: string;
	/** 利用者のホーム。`~/.codex-N` を受け付ける判定に使う。 */
	readonly userHome: string;
	/** 起動してから最初に自動の確認をするまでの待ち時間（hook の設置が先に済むように）。 */
	readonly startupDelayMs?: number;
	/** hooks.json が変わってから確認するまでの待ち時間。 */
	readonly changeDelayMs?: number;
	readonly now?: () => number;
}

const DEFAULT_STARTUP_DELAY_MS = 20_000;
const DEFAULT_CHANGE_DELAY_MS = 3_000;
/** 確かめる役を引き受けた窓が、結果を返さずに消えたときに札を取り返すまでの時間。 */
const PROMPT_CLAIM_TTL_MS = 2 * 60_000;

export class ParadisCodexHookTrustService extends Disposable {

	private readonly queues = new Map<string, Promise<unknown>>();
	private ledger: Promise<Record<string, string>> | undefined;
	/** 利用者に確かめる通知を、この shared process で出したか。 */
	private promptShown = false;
	/** 確かめる役を引き受けた窓がいる間の期限。 */
	private promptClaimedUntil = 0;
	private readonly pendingAuto = this._register(new MutableDisposable());

	constructor(
		private readonly backend: IParadisCodexHookTrustBackend,
		private readonly options: IParadisCodexHookTrustServiceOptions,
		private readonly getMode: () => unknown,
		onDidChangeMode: Event<void>,
		private readonly logService: ILogService,
	) {
		super();
		this._register(onDidChangeMode(() => this.scheduleAuto(this.options.changeDelayMs ?? DEFAULT_CHANGE_DELAY_MS)));
		this._register(backend.watchHooks(options.defaultCodexHome, () => this.scheduleAuto(this.options.changeDelayMs ?? DEFAULT_CHANGE_DELAY_MS)));
		this.scheduleAuto(options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
	}

	/**
	 * 受け付ける CODEX_HOME か。IPC 経由の任意パスで codex を起こさないよう、既定のホームか
	 * `~/.codex-<名前>`（複数アカウント用のホーム）だけにする。
	 */
	private resolveHome(requested: unknown): string | undefined {
		if (requested === undefined || requested === null || requested === '') {
			return this.options.defaultCodexHome;
		}
		if (typeof requested !== 'string' || !isAbsolute(requested)) {
			return undefined;
		}
		const home = normalize(requested);
		if (home === normalize(this.options.defaultCodexHome)) {
			return home;
		}
		return dirname(home) === normalize(this.options.userHome) && /^\.codex-[A-Za-z0-9._-]+$/.test(basename(home)) ? home : undefined;
	}

	private enqueue<T>(home: string, task: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(home) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.queues.set(home, next.catch(() => undefined));
		return next;
	}

	getStatus(codexHome?: unknown): Promise<IParadisCodexHookTrustStatus> {
		const home = this.resolveHome(codexHome);
		if (home === undefined) {
			return Promise.reject(new Error('unsupported CODEX_HOME'));
		}
		return this.enqueue(home, () => this.backend.inspect(home));
	}

	/**
	 * 利用者の同意を得たあとに画面側から呼ぶ。設定が `off` のときだけは何もしない。
	 * 指紋が同じでも必ず codex に確かめさせる。
	 */
	grant(codexHome?: unknown): Promise<IParadisCodexHookTrustGrantResult> {
		const home = this.resolveHome(codexHome);
		if (home === undefined) {
			return Promise.reject(new Error('unsupported CODEX_HOME'));
		}
		if (paradisCodexHookTrustMode(this.getMode()) === 'off') {
			return Promise.resolve({ outcome: 'skipped', codexHome: home, hooksPath: join(home, 'hooks.json'), grantedEvents: [] });
		}
		return this.enqueue(home, () => this.grantAndRecord(home));
	}

	/**
	 * 設定が `auto` のときの自動の経路。前回確かめたときと指紋が同じなら codex を起こさない。
	 * フェーズ2 の複数ホームは、hook を置いたあとにこれを呼べばよい。
	 */
	autoGrant(codexHome?: unknown): Promise<IParadisCodexHookTrustGrantResult> {
		const home = this.resolveHome(codexHome);
		if (home === undefined) {
			return Promise.reject(new Error('unsupported CODEX_HOME'));
		}
		const skipped: IParadisCodexHookTrustGrantResult = { outcome: 'skipped', codexHome: home, hooksPath: join(home, 'hooks.json'), grantedEvents: [] };
		if (paradisCodexHookTrustMode(this.getMode()) !== 'auto') {
			return Promise.resolve(skipped);
		}
		return this.enqueue(home, async () => {
			const fingerprint = await this.backend.fingerprint(home);
			if (fingerprint !== undefined && (await this.readLedger())[home] === fingerprint) {
				return skipped;
			}
			return this.grantAndRecord(home);
		});
	}

	/**
	 * 利用者に確かめる役を1つの窓だけが引き受けるための札。
	 * 通知をまだ出しておらず、ほかの窓が引き受けていなければ true。引き受けた窓は必ず
	 * {@link releasePrompt} で結果を返す（返さずに窓が消えても、一定時間で札は戻る）。
	 */
	claimPrompt(): boolean {
		const now = this.now();
		if (this.promptShown || now < this.promptClaimedUntil) {
			return false;
		}
		this.promptClaimedUntil = now + PROMPT_CLAIM_TTL_MS;
		return true;
	}

	/** 札を返す。`shown` が true なら通知を出したので、この shared process では以後聞かない。 */
	releasePrompt(shown: boolean): void {
		if (shown) {
			this.promptShown = true;
		}
		this.promptClaimedUntil = 0;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private async grantAndRecord(home: string): Promise<IParadisCodexHookTrustGrantResult> {
		const result = await this.backend.grant(home);
		this.logService.info(`[ParadisCodexHookTrust] ${home}: ${result.outcome}${result.grantedEvents.length > 0 ? ` (${result.grantedEvents.join(', ')})` : ''}${result.detail ? ` - ${result.detail}` : ''}`);
		if (result.outcome === 'granted' || result.outcome === 'already-trusted' || result.outcome === 'nothing-installed') {
			const fingerprint = await this.backend.fingerprint(home).catch(() => undefined);
			if (fingerprint !== undefined) {
				const ledger = { ...await this.readLedger(), [home]: fingerprint };
				this.ledger = Promise.resolve(ledger);
				await this.backend.writeLedger(ledger).catch(error => this.logService.warn('[ParadisCodexHookTrust] failed to save the ledger', error));
			}
		}
		return result;
	}

	private readLedger(): Promise<Record<string, string>> {
		this.ledger ??= this.backend.readLedger().catch(() => ({}));
		return this.ledger;
	}

	private scheduleAuto(delayMs: number): void {
		if (this._store.isDisposed) {
			return;
		}
		this.pendingAuto.value = this.backend.schedule(delayMs, () => {
			this.pendingAuto.clear();
			this.autoGrant().catch(error => this.logService.warn('[ParadisCodexHookTrust] automatic trust failed', error));
		});
	}
}

export class ParadisCodexHookTrustChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisCodexHookTrustService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'getStatus': return this.service.getStatus(arg) as Promise<T>;
			case 'grant': return this.service.grant(arg) as Promise<T>;
			case 'claimPrompt': return Promise.resolve(this.service.claimPrompt()) as Promise<T>;
			case 'releasePrompt': return Promise.resolve(this.service.releasePrompt(arg === true)) as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}
}

// ---------- 実物の backend ----------

const LEDGER_FILE_NAME = 'paradis-codex-hook-trust.json';
const VERSION_TIMEOUT_MS = 10_000;

function paradisManagedCodexHookCommand(): string {
	return process.platform === 'win32' ? paradisManagedAgentHookCommandWindows(homedir()) : paradisManagedAgentHookCommand();
}

export function createParadisCodexHookTrustBackend(userDataPath: string, getEnv: () => Promise<NodeJS.ProcessEnv>, logService: ILogService): IParadisCodexHookTrustBackend {
	const ledgerPath = join(userDataPath, LEDGER_FILE_NAME);
	const resolveCodex = async (): Promise<{ readonly command: string; readonly env: NodeJS.ProcessEnv } | undefined> => {
		const shellEnv = await getEnv();
		const launcherDir = shellEnv[PARADIS_CODEX_LAUNCHER_DIR_ENV_VAR];
		const env = paradisDetachedAgentCliEnv(shellEnv);
		const command = await paradisResolveAgentCli('codex', env, { excludeDirs: launcherDir ? [launcherDir] : [] });
		return command === undefined ? undefined : { command, env };
	};
	const io: IParadisCodexHookTrustIO = {
		realpath: realpathOrUndefined,
		async openRpc(codexHome) {
			const codex = await resolveCodex();
			if (codex === undefined) {
				return undefined;
			}
			return paradisOpenCodexAppServer({ command: codex.command, env: codex.env, codexHome, clientName: 'para-code-hook-trust', cwd: codexHome });
		},
	};
	const target = (codexHome: string): IParadisCodexHookTrustTarget => ({ codexHome, managedCommand: paradisManagedCodexHookCommand(), isWindows: process.platform === 'win32' });
	return {
		inspect: codexHome => paradisInspectCodexHookTrust(target(codexHome), io),
		grant: codexHome => paradisGrantCodexHookTrust(target(codexHome), io),
		async fingerprint(codexHome) {
			const codex = await resolveCodex();
			if (codex === undefined) {
				return undefined;
			}
			const version = await paradisRunAgentCli(codex.command, ['--version'], { env: codex.env, timeoutMs: VERSION_TIMEOUT_MS });
			const hash = createHash('sha256');
			hash.update(codex.command).update('\0').update(version.stdout.trim()).update('\0');
			for (const name of ['hooks.json', 'config.toml']) {
				const content = await readOptionalFile(join(codexHome, name));
				hash.update(name).update('\0').update(content ?? '<missing>').update('\0');
			}
			return hash.digest('hex');
		},
		async readLedger() {
			const content = await readOptionalFile(ledgerPath);
			if (content === undefined) {
				return {};
			}
			const parsed: unknown = JSON.parse(content.toString('utf8'));
			const homes = typeof parsed === 'object' && parsed !== null ? (parsed as { homes?: unknown }).homes : undefined;
			const ledger: Record<string, string> = {};
			if (typeof homes === 'object' && homes !== null) {
				for (const [home, value] of Object.entries(homes)) {
					if (typeof value === 'string') {
						ledger[home] = value;
					}
				}
			}
			return ledger;
		},
		writeLedger: ledger => paradisWriteFileAtomic(ledgerPath, Buffer.from(JSON.stringify({ version: 1, homes: ledger }, undefined, '\t'))),
		watchHooks(codexHome, listener) {
			try {
				const watcher = watch(codexHome, { persistent: false }, (_eventType, fileName) => {
					if (fileName === null || fileName.toString() === 'hooks.json') {
						listener();
					}
				});
				watcher.on('error', error => logService.trace(`[ParadisCodexHookTrust] watcher for ${codexHome} stopped`, error));
				return toDisposable(() => watcher.close());
			} catch {
				// ホームがまだ無い（Codex を入れていない）。起動時の確認だけで足りる
				return Disposable.None;
			}
		},
		schedule(delayMs, callback) {
			const handle = setTimeout(callback, delayMs);
			return toDisposable(() => clearTimeout(handle));
		},
	};
}

ParadisSharedProcessContributions.register('codexHookTrust', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentService = accessor.get(INativeEnvironmentService);
	const shellEnv = new ParadisCachedShellEnv(logService, 'ParadisCodexHookTrust', createParadisShellEnvResolver(logService, configurationService, environmentService.args));
	const service = new ParadisCodexHookTrustService(
		createParadisCodexHookTrustBackend(environmentService.userDataPath, () => shellEnv.getEnv(), logService),
		{ defaultCodexHome: paradisCodexHome(), userHome: homedir() },
		() => configurationService.getValue(PARADIS_CODEX_HOOK_TRUST_SETTING),
		Event.map(Event.filter(configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(PARADIS_CODEX_HOOK_TRUST_SETTING)), () => undefined),
		logService,
	);
	server.registerChannel(PARADIS_CODEX_HOOK_TRUST_CHANNEL, new ParadisCodexHookTrustChannel(service));
	return service;
});
