/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（REH）で、古い版の Para Code サーバーを探す・止める・使っていない版のフォルダを消す。
//
// 実行するのは接続先のこのサーバー自身で、手元のウィンドウは要求と結果だけを受け取る
// （`common/paradisStaleServers.ts`）。手元から pid やパスを受け取って止めることはしない。止めるときも
// その場で ps を読み直し、止めてよいもの（このユーザーの・今より古い版の・誰もつながっていない
// サーバー）を選び直し、手元が通知に出した版との積だけを止める。
//
// 止め方は TERM → 待つ → 残っているものだけ KILL。KILL の前にも読み直し、同じ pid でも
// 別のプロセスに替わっていれば（引数・ユーザー・開始時刻のどれかが違えば）触らない。
//
// 自分自身の server-main が ps に見つからないときは、自分の木を正しく外せる保証が無いので、
// 止めることも消すことも一切しない。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisProcessRow,
	IParadisServerDirEntry,
	IParadisServerLayout,
	IParadisStaleServer,
	IParadisStaleServerInfo,
	IParadisStaleServersResult,
	IParadisStaleServersScan,
	IParadisStaleServersService,
	IParadisStopTarget,
	IParadisTcpState,
	PARADIS_PS_ARGS,
	paradisCommitsToStop,
	paradisFindStaleServers,
	paradisJudgeStaleServer,
	paradisOnlyOlderBuilds,
	paradisParseEstablishedConnections,
	paradisParseListeningPorts,
	paradisParsePsOutput,
	paradisRemainingTargets,
	paradisRemovingDirName,
	paradisSelectLeftoverRemovingDirs,
	paradisSelectRemovableServerDirs,
	paradisSelfServerFound,
	paradisStartedAt,
} from '../common/paradisStaleServers.js';

/** TERM を送ってから待つ上限。 */
const TERM_GRACE_MS = 8_000;
const POLL_MS = 250;
const PS_TIMEOUT_MS = 10_000;
const DU_TIMEOUT_MS = 20_000;

const EMPTY_SCAN: IParadisStaleServersScan = { supported: true, servers: [], removableDirCount: 0, removableBytes: 0, removableAfterStopDirCount: 0, removableAfterStopBytes: 0 };
const NOTHING_DONE: IParadisStaleServersResult = { stoppedServers: 0, forcedProcesses: 0, removedDirs: 0, freedBytes: 0, failedDirs: 0 };

/** 外の世界に触るところ。テストでは差し替える。 */
export interface IParadisStaleServersHost {
	listProcesses(): Promise<IParadisProcessRow[]>;
	/** TCP の待ち受けと確立した接続。調べられない環境では undefined。 */
	tcpState(): Promise<IParadisTcpState | undefined>;
	/** 動いているプロセスの実行ファイル（Linux の `/proc/<pid>/exe`）。調べられなければ undefined。 */
	listExecutables(): Promise<string[] | undefined>;
	realpath(path: string): Promise<string>;
	listBinEntries(binRoot: string): Promise<IParadisServerDirEntry[]>;
	/** フォルダの大きさ（バイト）。測れなければ 0。 */
	sizeOf(path: string): Promise<number>;
	readProduct(binRoot: string, commit: string): Promise<{ readonly version?: string; readonly date?: string } | undefined>;
	signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
	renameDir(from: string, to: string): Promise<void>;
	removeDir(path: string): Promise<void>;
	delay(ms: number): Promise<void>;
	now(): number;
}

function run(command: string, args: readonly string[], timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, [...args], { timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
			if (error) {
				reject(error);
			} else {
				resolve(stdout);
			}
		});
	});
}

/** 本物の外の世界。POSIX だけ（Windows の接続先には版ごとの置き場所が無い）。 */
export const paradisNodeStaleServersHost: IParadisStaleServersHost = {
	async listProcesses() {
		return paradisParsePsOutput(await run('ps', PARADIS_PS_ARGS, PS_TIMEOUT_MS));
	},
	async tcpState() {
		// Linux の `ss` だけで調べる。ほかの環境（macOS など）では調べられないとして undefined を返し、
		// 呼び出し側は「使われているかもしれない」として止めない。
		if (process.platform !== 'linux') {
			return undefined;
		}
		try {
			const [listening, established] = await Promise.all([
				run('ss', ['-Htlnp'], PS_TIMEOUT_MS),
				run('ss', ['-Htnp', 'state', 'established'], PS_TIMEOUT_MS),
			]);
			return { listeningPorts: paradisParseListeningPorts(listening), established: paradisParseEstablishedConnections(established) };
		} catch {
			return undefined;
		}
	},
	async listExecutables() {
		if (process.platform !== 'linux') {
			return undefined;
		}
		try {
			const names = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
			const executables: string[] = [];
			for (const name of names) {
				try {
					executables.push(await fs.readlink(`/proc/${name}/exe`));
				} catch {
					// ほかのユーザーのもの（読めない）か、もう居ない。引数の方で見ている。
				}
			}
			return executables;
		} catch {
			return undefined;
		}
	},
	realpath(path) {
		return fs.realpath(path);
	},
	async listBinEntries(binRoot) {
		const names = await fs.readdir(binRoot);
		const entries: IParadisServerDirEntry[] = [];
		for (const name of names) {
			try {
				// シンボリックリンクはたどらない（lstat）。リンクの先を消しに行かないため。
				const stat = await fs.lstat(join(binRoot, name));
				entries.push({ name, isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs });
			} catch {
				// 読んでいる間に消えた。
			}
		}
		return entries;
	},
	async sizeOf(path) {
		try {
			const stdout = await run('du', ['-sk', path], DU_TIMEOUT_MS);
			const kilobytes = Number(/^\s*(?<size>\d+)/.exec(stdout)?.groups?.size);
			return isFinite(kilobytes) ? kilobytes * 1024 : 0;
		} catch {
			return 0;
		}
	},
	async readProduct(binRoot, commit) {
		try {
			const product = JSON.parse(await fs.readFile(join(binRoot, commit, 'product.json'), 'utf8')) as { version?: unknown; date?: unknown };
			return {
				version: typeof product.version === 'string' ? product.version : undefined,
				date: typeof product.date === 'string' ? product.date : undefined,
			};
		} catch {
			return undefined;
		}
	},
	signal(pid, signal) {
		try {
			process.kill(pid, signal);
		} catch {
			// もう居ない・権限が無い（ほかのユーザーのものは最初から選ばないので、ここに来るのは前者）。
		}
	},
	async renameDir(from, to) {
		await fs.rename(from, to);
	},
	async removeDir(path) {
		await fs.rm(path, { recursive: true, force: true });
	},
	delay(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	},
	now() {
		return Date.now();
	},
};

interface IParadisJudgedServers {
	readonly layout: IParadisServerLayout;
	readonly rows: readonly IParadisProcessRow[];
	/** `rows` を読んだ直後の時刻。ps の etime はこの時点のものなので、開始時刻はこれを基準に求める。 */
	readonly readAt: number;
	readonly stoppable: readonly IParadisStaleServer[];
	readonly products: ReadonlyMap<string, { readonly version?: string; readonly date?: string } | undefined>;
}

export class ParadisStaleServersService implements IParadisStaleServersService {

	/** 進行中の止める処理。2つのウィンドウから同時に押されても1回だけ走らせる。 */
	private stopping: Promise<IParadisStaleServersResult> | undefined;

	constructor(
		/** 版の置き場所が分からないときは undefined。 */
		private readonly layout: IParadisServerLayout | undefined,
		private readonly logService: ILogService,
		private readonly host: IParadisStaleServersHost = paradisNodeStaleServersHost,
	) { }

	async scan(): Promise<IParadisStaleServersScan> {
		const judged = await this.judge();
		if (!judged) {
			return { ...EMPTY_SCAN, supported: this.layout !== undefined };
		}
		const { layout, rows, stoppable, products } = judged;
		// 知らせるのは止めてよいサーバーが動いているときだけ。居なければフォルダの大きさも測らない
		// （繋ぐたびに du を走らせない）。
		if (stoppable.length === 0) {
			return EMPTY_SCAN;
		}
		const entries = await this.listEntries(layout.binRoot);
		const executables = await this.host.listExecutables();
		const now = this.host.now();
		// 消すのと同じく、今の版より古い版だけを数える。
		const olderOnly = async (names: string[]) => {
			const dates = new Map<string, string | undefined>();
			for (const name of names) {
				dates.set(name, products.has(name) ? products.get(name)?.date : (await this.host.readProduct(layout.binRoot, name))?.date);
			}
			return paradisOnlyOlderBuilds(names, dates, products.get(layout.currentCommit)?.date);
		};
		const removableNow = await olderOnly(paradisSelectRemovableServerDirs(entries, rows, layout, now, executables));
		// 止めたら消せるようになるもの。止める対象のプロセスを除いて選び直す（実行ファイルの一覧からも
		// 除けないので、そちらで使われていれば「止めた後」にも数えない＝少なめに見積もる）。
		const stoppedPids = new Set(stoppable.flatMap(server => server.pids));
		const removableAfter = (await olderOnly(paradisSelectRemovableServerDirs(entries, rows.filter(row => !stoppedPids.has(row.pid)), layout, now)))
			.filter(name => !removableNow.includes(name));
		const servers: IParadisStaleServerInfo[] = stoppable.map(server => ({
			commit: server.commit,
			version: products.get(server.commit)?.version,
			elapsedSeconds: server.elapsedSeconds,
			terminalCount: server.terminalCount,
			claudeCount: server.claudeCount,
			codexCount: server.codexCount,
			rssBytes: server.rssBytes,
		}));
		return {
			supported: true,
			servers,
			removableDirCount: removableNow.length,
			removableBytes: await this.sizeOfAll(layout.binRoot, removableNow),
			removableAfterStopDirCount: removableAfter.length,
			removableAfterStopBytes: await this.sizeOfAll(layout.binRoot, removableAfter),
		};
	}

	stopAndClean(commits: readonly string[]): Promise<IParadisStaleServersResult> {
		if (!this.stopping) {
			this.stopping = this.doStopAndClean(Array.isArray(commits) ? commits : []).finally(() => this.stopping = undefined);
		}
		return this.stopping;
	}

	/**
	 * 今この瞬間の姿で、止めてよいサーバーを選ぶ。置き場所が分からない・自分が見つからないときは
	 * undefined（何もしない）。
	 */
	private async judge(): Promise<IParadisJudgedServers | undefined> {
		const layout = await this.resolveLayout();
		if (!layout) {
			return undefined;
		}
		const rows = await this.host.listProcesses();
		const readAt = this.host.now();
		if (!paradisSelfServerFound(rows, layout)) {
			this.logService.info('[paradisStaleServers] could not find this server in the process list; not touching anything');
			return undefined;
		}
		const stale = paradisFindStaleServers(rows, layout);
		if (stale.length === 0) {
			return { layout, rows, readAt, stoppable: [], products: new Map() };
		}
		const products = new Map<string, { readonly version?: string; readonly date?: string } | undefined>();
		for (const commit of new Set([layout.currentCommit, ...stale.map(server => server.commit)])) {
			products.set(commit, await this.host.readProduct(layout.binRoot, commit));
		}
		const tcp = await this.host.tcpState();
		const stoppable: IParadisStaleServer[] = [];
		for (const server of stale) {
			const verdict = paradisJudgeStaleServer({
				productDate: products.get(server.commit)?.date,
				currentProductDate: products.get(layout.currentCommit)?.date,
				serverPid: server.pid,
				serverArgs: server.args,
				tcp,
			});
			if (verdict === 'stoppable') {
				stoppable.push(server);
			} else {
				this.logService.info(`[paradisStaleServers] leaving the server of build ${server.commit.slice(0, 8)} alone: ${verdict}`);
			}
		}
		return { layout, rows, readAt, stoppable, products };
	}

	/** 置き場所の実体のパスを求め、もとの書き方は別名として持つ。 */
	private async resolveLayout(): Promise<IParadisServerLayout | undefined> {
		const layout = this.layout;
		if (!layout) {
			return undefined;
		}
		try {
			const real = await this.host.realpath(layout.binRoot);
			return { ...layout, binRoot: real, binRootAliases: [layout.binRoot, ...(layout.binRootAliases ?? [])] };
		} catch {
			return layout;
		}
	}

	private async doStopAndClean(requested: readonly string[]): Promise<IParadisStaleServersResult> {
		// 手元が見た一覧は使わない。今この瞬間に選び直し、手元が出した版との積だけを止める。
		const judged = await this.judge();
		if (!judged) {
			return NOTHING_DONE;
		}
		const { layout, rows, readAt } = judged;
		const commits = new Set(paradisCommitsToStop(requested, judged.stoppable.map(server => server.commit)));
		const servers = judged.stoppable.filter(server => commits.has(server.commit));
		const byPid = new Map(rows.map(row => [row.pid, row]));
		const targets: IParadisStopTarget[] = servers.flatMap(server => server.pids)
			.map(pid => byPid.get(pid))
			.filter((row): row is IParadisProcessRow => row !== undefined)
			.map(row => ({ pid: row.pid, args: row.args, startedAtMs: paradisStartedAt(row, readAt) }));

		let forcedProcesses = 0;
		if (targets.length > 0) {
			this.logService.info(`[paradisStaleServers] stopping ${servers.length} server(s) of older builds (${servers.map(server => server.commit.slice(0, 8)).join(', ')}), ${targets.length} process(es)`);
			for (const target of targets) {
				this.host.signal(target.pid, 'SIGTERM');
			}
			let remaining = targets.map(target => target.pid);
			const deadline = this.host.now() + TERM_GRACE_MS;
			while (remaining.length > 0 && this.host.now() < deadline) {
				await this.host.delay(POLL_MS);
				const current = await this.readProcesses();
				remaining = paradisRemainingTargets(targets, current.rows, layout.uid, current.readAt);
			}
			if (remaining.length > 0) {
				// KILL の直前にもう一度読み直す（pid の使い回しで別のものに替わっていないか）。
				const current = await this.readProcesses();
				const stillThere = paradisRemainingTargets(targets.filter(target => remaining.includes(target.pid)), current.rows, layout.uid, current.readAt);
				for (const pid of stillThere) {
					this.host.signal(pid, 'SIGKILL');
				}
				forcedProcesses = stillThere.length;
				this.logService.info(`[paradisStaleServers] ${stillThere.length} process(es) did not stop on TERM; sent KILL`);
				await this.host.delay(POLL_MS);
			}
		}

		// 動いていない版のフォルダだけ消す。止めた後の姿で選び直す。
		const afterRows = await this.host.listProcesses();
		if (!paradisSelfServerFound(afterRows, layout)) {
			return { ...NOTHING_DONE, stoppedServers: servers.length, forcedProcesses };
		}
		const entries = await this.listEntries(layout.binRoot);
		// 前の掃除で消しきれずに残った退避フォルダを先に消す（版としては使われていない）。
		for (const name of paradisSelectLeftoverRemovingDirs(entries)) {
			try {
				await this.host.removeDir(join(layout.binRoot, name));
			} catch (error) {
				this.logService.warn(`[paradisStaleServers] could not remove the leftover ${name}`, error);
			}
		}
		// 消すのは今の版より古い版だけ（date が読めなければ消さない）。先に更新した別の PC が
		// これから使う新しい版を消さないため。
		const candidates = paradisSelectRemovableServerDirs(entries, afterRows, layout, this.host.now(), await this.host.listExecutables());
		const dates = new Map<string, string | undefined>();
		for (const name of [layout.currentCommit, ...candidates]) {
			dates.set(name, (await this.host.readProduct(layout.binRoot, name))?.date);
		}
		const removable = paradisOnlyOlderBuilds(candidates, dates, dates.get(layout.currentCommit));
		let removedDirs = 0;
		let failedDirs = 0;
		let freedBytes = 0;
		for (const name of removable) {
			const path = join(layout.binRoot, name);
			const size = await this.host.sizeOf(path);
			// 先に名前を変えて退避してから消す。消している途中のフォルダを、版として使わせない。
			const removing = join(layout.binRoot, paradisRemovingDirName(name, this.host.now()));
			try {
				await this.host.renameDir(path, removing);
			} catch (error) {
				failedDirs++;
				this.logService.warn(`[paradisStaleServers] could not move ${name} aside; leaving it`, error);
				continue;
			}
			try {
				await this.host.removeDir(removing);
				removedDirs++;
				freedBytes += size;
			} catch (error) {
				failedDirs++;
				this.logService.warn(`[paradisStaleServers] could not remove ${name}`, error);
			}
		}
		this.logService.info(`[paradisStaleServers] removed ${removedDirs} unused build folder(s)${failedDirs > 0 ? `, ${failedDirs} failed` : ''}`);
		return { stoppedServers: servers.length, forcedProcesses, removedDirs, freedBytes, failedDirs };
	}

	/** ps を読み、読んだ直後の時刻と一緒に返す（etime の基準をずらさないため）。 */
	private async readProcesses(): Promise<{ readonly rows: IParadisProcessRow[]; readonly readAt: number }> {
		const rows = await this.host.listProcesses();
		return { rows, readAt: this.host.now() };
	}

	private async listEntries(binRoot: string): Promise<IParadisServerDirEntry[]> {
		try {
			return await this.host.listBinEntries(binRoot);
		} catch (error) {
			this.logService.trace('[paradisStaleServers] could not read the build folders', error);
			return [];
		}
	}

	private async sizeOfAll(binRoot: string, names: readonly string[]): Promise<number> {
		let total = 0;
		for (const name of names) {
			total += await this.host.sizeOf(join(binRoot, name));
		}
		return total;
	}
}

/** チャネルに出す面。`scan` と `stopAndClean` だけを持つ薄いもの（クラスの他のメソッドを呼ばせない）。 */
export function paradisStaleServersSurface(service: IParadisStaleServersService): IParadisStaleServersService {
	return {
		scan: () => service.scan(),
		stopAndClean: commits => service.stopAndClean(commits),
	};
}
