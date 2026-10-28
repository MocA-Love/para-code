/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブリッジ対応の OpenCode 互換 CLI が、セッションを登録するとき（SessionStart）に名乗ったコマンド名・表示名・会話の DB の
// 場所を、持ち主の確認と実行ファイルの確認が済んだものだけ覚えておく台帳。置き場所は利用者のプロファイル（userData）で、
// リポジトリには何も書かない。覚えたコマンド名は、ターミナルのタイトル・プロセスの判定で `opencode` と同じに扱い、
// 再開には覚えた実行ファイルの絶対パスを使い、DB はセッション履歴の一覧で本家 OpenCode の既定の場所と一緒に探す。
// 最後に名乗ってから 30 日たったものは使わない。コマンド（paradis.openCode.forgetCompatibleClis）で全部忘れられる。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, normalize, relative } from '../../../../base/common/path.js';
import { isLinux, isMacintosh } from '../../../../base/common/platform.js';
import { PARADIS_OPENCODE_COMMAND, paradisIsOpenCodeCliExecutable, paradisIsOpenCodeCompatibleCommand, paradisIsRuntimeOrShellProgram, paradisNormalizeOpenCodeCliLabel, paradisSetOpenCodeCompatibleCommands } from '../../../../platform/terminal/common/paradisOpenCodeCompatibleCli.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';

/** 覚えておく CLI の数と、1 つの CLI について覚える DB の数。 */
const MAX_CLIS = 16;
const MAX_DATABASES_PER_CLI = 4;
const MAX_PATH_LENGTH = 1024;
/** 最後に名乗ってからこの時間がたった CLI は使わない（読み込みのときに捨てる）。 */
export const PARADIS_OPENCODE_CLI_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 覚えた CLI 1 つ。 */
export interface IParadisOpenCodeCli {
	readonly command: string;
	/** 実行ファイルの実体の絶対パス（再開に使う）。 */
	readonly executable: string;
	readonly label?: string;
	/** 会話の DB（新しく見たものが先）。 */
	readonly databases: readonly string[];
	readonly seenAt: number;
	/**
	 * SSH などの接続先（remote authority を小文字にしたもの）で確かめた CLI なら、その接続先。手元なら undefined。
	 * 実行ファイルと DB のパスは、その接続先のマシンのもの。
	 */
	readonly authority?: string;
}

/** 会話の DB と、その会話を再開するもの（覚えた実行ファイルの絶対パス）。 */
export interface IParadisOpenCodeCliDatabase {
	readonly path: string;
	readonly cli: string;
	readonly label?: string;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** XDG のデータの置き場。`/` のような浅い場所（1 段以下）は、ほぼ何でも含んでしまうので使わない。 */
export function paradisOpenCodeXdgDataRoot(env: NodeJS.ProcessEnv): string | undefined {
	const value = env.XDG_DATA_HOME;
	if (value === undefined || !isAbsolute(value)) {
		return undefined;
	}
	const root = normalize(value);
	return root.split(/[\\/]/).filter(Boolean).length >= 2 ? root : undefined;
}

/**
 * CLI が名乗った DB の場所を確かめる。絶対パスで、`..` などを含まない正規の形で、ホームか XDG のデータの置き場の下にあり、
 * 名前が `.db` で終わること。満たさなければ undefined。
 */
export function paradisValidateOpenCodeDatabasePath(path: unknown, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
	if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || !isAbsolute(path) || normalize(path) !== path) {
		return undefined;
	}
	if (!/^[\w.-]+\.db$/.test(basename(path))) {
		return undefined;
	}
	const xdg = paradisOpenCodeXdgDataRoot(env);
	const roots = [home, ...(xdg !== undefined ? [xdg] : [])];
	return roots.some(root => isInside(root, path)) ? path : undefined;
}

/**
 * `lsof -a -p <pid> -d txt -Fn` の出力から、実際に動いている実行ファイルのパス（最初の `n` 行）を取り出す。
 * 形が違う・パスが無ければ undefined。
 */
export function paradisParseLsofExecutable(stdout: string): string | undefined {
	for (const line of stdout.split('\n')) {
		if (line.startsWith('n')) {
			const path = line.slice(1).trim();
			return isAbsolute(path) ? path : undefined;
		}
	}
	return undefined;
}

/**
 * プロセスの実行ファイルの実体のパス（Linux は `/proc/<pid>/exe`、macOS は `lsof` の txt の最初の行を realpath したもの）。
 * 取れなければ undefined（lsof が無い・失敗したときも）。起動行（argv）や `ps -o comm=`（argv[0] になりうる）は名乗り放題なので使わない。
 */
export async function paradisResolveProcessExecutable(pid: number): Promise<string | undefined> {
	if (!Number.isSafeInteger(pid) || pid < 2) {
		return undefined;
	}
	try {
		if (isLinux) {
			const target = (await fs.readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '');
			return isAbsolute(target) ? await fs.realpath(target).catch(() => target) : undefined;
		}
		if (isMacintosh) {
			const stdout = await new Promise<string>((resolve, reject) => execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeout: 3000 }, (error, out) => error ? reject(error) : resolve(out)));
			const path = paradisParseLsofExecutable(stdout);
			return path !== undefined ? await fs.realpath(path) : undefined;
		}
	} catch {
		// 取れない（プロセスが終わった・権限が無い）
	}
	return undefined;
}

/**
 * 名乗ったコマンドが、そのプロセスの実行ファイルの名前と一致するか確かめ、一致すれば実行ファイルの絶対パスを返す。
 * 実行ファイルがランタイム（node・bun・deno・python など）やシェルなら覚えない（スクリプトの名前は名乗り放題なので）。
 */
export async function paradisVerifyOpenCodeCliProcess(pid: number, command: string, resolveExecutable: (pid: number) => Promise<string | undefined> = paradisResolveProcessExecutable): Promise<string | undefined> {
	if (!paradisIsOpenCodeCompatibleCommand(command) || command === PARADIS_OPENCODE_COMMAND) {
		return undefined;
	}
	const executable = await resolveExecutable(pid);
	if (executable === undefined || paradisIsRuntimeOrShellProgram(basename(executable)) || basename(executable) !== command || !paradisIsOpenCodeCliExecutable(executable)) {
		return undefined;
	}
	return executable;
}

/** 接続先の名前（remote authority）として受ける形。 */
export function paradisNormalizeOpenCodeCliAuthority(authority: unknown): string | undefined {
	return typeof authority === 'string' && /^[A-Za-z0-9._+@:%[\]-]{1,300}$/.test(authority) ? authority.toLowerCase() : undefined;
}

/**
 * 接続先で確かめた DB のパスの形だけを見る（ホームの下か・実体はどこかは、接続先で確かめ済み）。正規化した POSIX の絶対パスで、
 * 名前が `.db` で終わること。
 */
function plausibleRemoteDatabasePath(path: unknown): string | undefined {
	return typeof path === 'string' && path.length <= MAX_PATH_LENGTH && path.startsWith('/') && normalize(path) === path && /^[\w.-]+\.db$/.test(basename(path)) ? path : undefined;
}

/**
 * このマシンで、互換 CLI の名乗りを確かめる（接続先では REH サーバーがこれを行う）。プロセスの実行ファイルを確かめ、DB の場所も
 * このマシンのホームか XDG のデータの置き場の下にある `.db` のファイルで、実体のパスも同じ条件を満たすときだけ返す。
 * 実行ファイルを確かめられなければ undefined（DB だけは返さない）。
 */
export async function paradisVerifyOpenCodeCliOnThisHost(input: { readonly pid: number; readonly command: string; readonly databasePath?: string },
	env: NodeJS.ProcessEnv = process.env, home: string = homedir(), resolveExecutable: (pid: number) => Promise<string | undefined> = paradisResolveProcessExecutable): Promise<{ readonly executable: string; readonly databasePath?: string } | undefined> {
	const executable = await paradisVerifyOpenCodeCliProcess(input.pid, input.command, resolveExecutable);
	if (executable === undefined) {
		return undefined;
	}
	const declared = paradisValidateOpenCodeDatabasePath(input.databasePath, env, home);
	let databasePath: string | undefined;
	if (declared !== undefined) {
		const real = await fs.realpath(declared).catch(() => undefined);
		const realHome = await fs.realpath(home).catch(() => home);
		const xdg = paradisOpenCodeXdgDataRoot(env);
		const realXdg = xdg !== undefined ? await fs.realpath(xdg).catch(() => xdg) : undefined;
		const isFile = real !== undefined && await fs.stat(real).then(stat => stat.isFile(), () => false);
		if (isFile && paradisValidateOpenCodeDatabasePath(real, realXdg !== undefined ? { XDG_DATA_HOME: realXdg } : {}, realHome) !== undefined) {
			databasePath = real;
		}
	}
	return { executable, ...(databasePath !== undefined ? { databasePath } : {}) };
}

function parseCli(value: unknown, now: number): IParadisOpenCodeCli | undefined {
	const raw = value as Partial<Record<keyof IParadisOpenCodeCli, unknown>> | null;
	if (raw === null || typeof raw !== 'object' || !paradisIsOpenCodeCompatibleCommand(raw.command) || !paradisIsOpenCodeCliExecutable(raw.executable)
		|| basename(raw.executable) !== raw.command || typeof raw.seenAt !== 'number' || !Number.isFinite(raw.seenAt) || now - raw.seenAt >= PARADIS_OPENCODE_CLI_TTL_MS) {
		return undefined;
	}
	const label = paradisNormalizeOpenCodeCliLabel(raw.label);
	const authority = raw.authority === undefined ? undefined : paradisNormalizeOpenCodeCliAuthority(raw.authority);
	if (raw.authority !== undefined && authority === undefined) {
		return undefined;
	}
	const validate = authority !== undefined ? plausibleRemoteDatabasePath : (path: unknown) => paradisValidateOpenCodeDatabasePath(path);
	const databases = Array.isArray(raw.databases) ? [...new Set(raw.databases.map(validate).filter((path): path is string => path !== undefined))].slice(0, MAX_DATABASES_PER_CLI) : [];
	return { command: raw.command, executable: raw.executable, ...(label !== undefined ? { label } : {}), databases, seenAt: raw.seenAt, ...(authority !== undefined ? { authority } : {}) };
}

function cliKey(command: string, authority: string | undefined): string {
	return `${authority ?? ''}\0${command}`;
}

export class ParadisOpenCodeCliRegistry {
	private clis: IParadisOpenCodeCli[] = [];
	/** 持ち主の確認の間だけ、名乗ったコマンドをプロセスの判定に入れる（確認できなければ外す）。commands() には出さない。 */
	private readonly trial = new Map<string, number>();
	private storePath: string | undefined;
	private loading: Promise<void> | undefined;
	private writing: Promise<void> = Promise.resolve();

	constructor(private readonly now: () => number = Date.now) { }

	/** 保存先を決めて読み込む（shared process で 1 回。接続先で確かめた CLI も、接続先ごとに手元のここへ覚える）。 */
	initialize(storePath: string): Promise<void> {
		if (this.storePath === storePath && this.loading !== undefined) {
			return this.loading;
		}
		this.storePath = storePath;
		this.loading = (async () => {
			try {
				const parsed = JSON.parse(await fs.readFile(storePath, 'utf8')) as { readonly clis?: unknown };
				const now = this.now();
				const clis = Array.isArray(parsed.clis) ? parsed.clis.map(cli => parseCli(cli, now)).filter((cli): cli is IParadisOpenCodeCli => cli !== undefined) : [];
				const seen = new Set<string>();
				this.clis = clis.filter(cli => !seen.has(cliKey(cli.command, cli.authority)) && seen.add(cliKey(cli.command, cli.authority))).slice(0, MAX_CLIS);
			} catch {
				this.clis = [];
			}
			this.publish();
		})();
		return this.loading;
	}

	/** 読み込みが終わるまで待つ。 */
	async ready(): Promise<void> {
		await this.loading;
	}

	/** 覚えた CLI のうち、そのマシン（`authority`。手元なら undefined）のもの（期限の切れていないもの。新しく見たものが先）。 */
	list(authority?: string): readonly IParadisOpenCodeCli[] {
		const now = this.now();
		const key = authority?.toLowerCase();
		return this.clis.filter(cli => cli.authority === key && now - cli.seenAt < PARADIS_OPENCODE_CLI_TTL_MS);
	}

	/** 手元のマシンで覚えたコマンド名（プロセスの判定に使う。確認中のものは入れない）。 */
	commands(): readonly string[] {
		return this.list().map(cli => cli.command);
	}

	/** どのマシンかを問わず、覚えたコマンド名（タブ名の判定に配る。どのウィンドウのタイトルかは問わないので全部）。 */
	allCommands(): readonly string[] {
		const now = this.now();
		return [...new Set(this.clis.filter(cli => now - cli.seenAt < PARADIS_OPENCODE_CLI_TTL_MS).map(cli => cli.command))];
	}

	/** そのマシンで覚えた実行ファイル（再開に使う）。無ければ undefined。 */
	executableOf(command: string, authority?: string): string | undefined {
		return this.list(authority).find(cli => cli.command === command)?.executable;
	}

	/** そのマシンで覚えた DB と、その会話を再開する実行ファイル。 */
	databases(authority?: string): readonly IParadisOpenCodeCliDatabase[] {
		return this.list(authority).flatMap(cli => cli.databases.map(path => ({ path, cli: cli.executable, ...(cli.label !== undefined ? { label: cli.label } : {}) })));
	}

	/**
	 * 持ち主の確認の間だけ、名乗ったコマンドをプロセスの判定に入れる。返した関数で外す（覚えた後に外しても、覚えたものは残る）。
	 * `opencode` と使えない名前は入れない。
	 */
	beginTrial(command: string): () => void {
		if (!paradisIsOpenCodeCompatibleCommand(command) || command === PARADIS_OPENCODE_COMMAND) {
			return () => { };
		}
		this.trial.set(command, (this.trial.get(command) ?? 0) + 1);
		this.publish();
		let ended = false;
		return () => {
			if (ended) {
				return;
			}
			ended = true;
			const count = (this.trial.get(command) ?? 1) - 1;
			if (count > 0) {
				this.trial.set(command, count);
			} else {
				this.trial.delete(command);
			}
			this.publish();
		};
	}

	/**
	 * 持ち主の確認と実行ファイルの確認が済んだ CLI を覚える。名前・実行ファイルが使えなければ何もしない。DB は確かめて
	 * 通ったものだけを足す。
	 */
	async remember(input: { readonly command: string; readonly executable: string; readonly label?: string; readonly databasePath?: string; readonly authority?: string }): Promise<void> {
		await this.loading;
		const authority = input.authority === undefined ? undefined : paradisNormalizeOpenCodeCliAuthority(input.authority);
		if (!paradisIsOpenCodeCompatibleCommand(input.command) || input.command === PARADIS_OPENCODE_COMMAND || !paradisIsOpenCodeCliExecutable(input.executable) || basename(input.executable) !== input.command
			|| (input.authority !== undefined && authority === undefined)) {
			return;
		}
		const now = this.now();
		const previous = this.list(authority).find(cli => cli.command === input.command);
		const label = paradisNormalizeOpenCodeCliLabel(input.label) ?? previous?.label;
		// 接続先の DB は接続先で確かめ済み（ここではそのマシンのホームを知らないので、形だけ見る）
		const database = authority !== undefined ? plausibleRemoteDatabasePath(input.databasePath) : paradisValidateOpenCodeDatabasePath(input.databasePath);
		const databases = [...new Set([...(database !== undefined ? [database] : []), ...(previous?.databases ?? [])])].slice(0, MAX_DATABASES_PER_CLI);
		const next: IParadisOpenCodeCli = { command: input.command, executable: input.executable, ...(label !== undefined ? { label } : {}), databases, seenAt: now, ...(authority !== undefined ? { authority } : {}) };
		const unchanged = previous !== undefined && previous.executable === next.executable && previous.label === next.label && previous.databases.length === next.databases.length
			&& previous.databases.every((path, index) => path === next.databases[index]) && now - previous.seenAt < 24 * 60 * 60 * 1000;
		if (unchanged) {
			return;
		}
		this.clis = [next, ...this.clis.filter(cli => cliKey(cli.command, cli.authority) !== cliKey(input.command, authority))].slice(0, MAX_CLIS);
		this.publish();
		await this.persist();
	}

	/** 覚えたものを全部忘れ、保存したものも消す（コマンド paradis.openCode.forgetCompatibleClis）。 */
	async forgetAll(): Promise<void> {
		await this.loading;
		this.clis = [];
		this.publish();
		await this.persist();
	}

	/** 覚えたものを忘れる（保存先も外す。テストのため）。 */
	clear(): void {
		this.clis = [];
		this.trial.clear();
		this.storePath = undefined;
		this.loading = undefined;
		this.publish();
	}

	private publish(): void {
		paradisSetOpenCodeCompatibleCommands([...new Set([...this.commands(), ...this.trial.keys()])]);
	}

	private persist(): Promise<void> {
		const storePath = this.storePath;
		if (storePath === undefined) {
			return Promise.resolve();
		}
		const content = JSON.stringify({ version: 2, clis: this.clis });
		this.writing = this.writing
			.then(() => fs.mkdir(dirname(storePath), { recursive: true }))
			.then(() => paradisWriteFileAtomic(storePath, content, { newFileMode: 0o600, forceMode: 0o600, rejectSymlink: true }))
			.catch(() => { /* 覚えられなくても、今の起動の間は使える */ });
		return this.writing;
	}
}

export const paradisOpenCodeCliRegistry = new ParadisOpenCodeCliRegistry();
