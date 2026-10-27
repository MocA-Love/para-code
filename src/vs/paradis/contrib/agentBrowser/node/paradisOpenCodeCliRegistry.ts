/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブリッジ対応の OpenCode 互換 CLI が、セッションを登録するとき（SessionStart）に名乗ったコマンド名・表示名・会話の DB の
// 場所を、持ち主の確認が済んだものだけ覚えておく台帳。置き場所は利用者のプロファイル（userData）で、リポジトリには何も
// 書かない。覚えたコマンド名は、ターミナルのタイトル・プロセスの判定・再開のコマンドで `opencode` と同じに扱い、DB は
// セッション履歴の一覧で本家 OpenCode の既定の場所と一緒に探す。

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, normalize, relative } from '../../../../base/common/path.js';
import { PARADIS_OPENCODE_COMMAND, paradisIsOpenCodeCompatibleCommand, paradisNormalizeOpenCodeCliLabel, paradisSetOpenCodeCompatibleCommands } from '../../../../platform/terminal/common/paradisOpenCodeCompatibleCli.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';

/** 覚えておく CLI の数と、1 つの CLI について覚える DB の数。 */
const MAX_CLIS = 8;
const MAX_DATABASES_PER_CLI = 4;
const MAX_PATH_LENGTH = 1024;

/** 覚えた CLI 1 つ。 */
export interface IParadisOpenCodeCli {
	readonly command: string;
	readonly label?: string;
	/** 会話の DB（新しく見たものが先）。 */
	readonly databases: readonly string[];
	readonly seenAt: number;
}

/** 会話の DB と、その会話を再開するコマンド。 */
export interface IParadisOpenCodeCliDatabase {
	readonly path: string;
	readonly command: string;
	readonly label?: string;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
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
	const roots = [home, ...(env.XDG_DATA_HOME !== undefined && isAbsolute(env.XDG_DATA_HOME) ? [normalize(env.XDG_DATA_HOME)] : [])];
	return roots.some(root => isInside(root, path)) ? path : undefined;
}

function parseCli(value: unknown): IParadisOpenCodeCli | undefined {
	const raw = value as Partial<Record<keyof IParadisOpenCodeCli, unknown>> | null;
	if (raw === null || typeof raw !== 'object' || !paradisIsOpenCodeCompatibleCommand(raw.command) || typeof raw.seenAt !== 'number' || !Number.isFinite(raw.seenAt)) {
		return undefined;
	}
	const label = paradisNormalizeOpenCodeCliLabel(raw.label);
	const databases = Array.isArray(raw.databases) ? [...new Set(raw.databases.map(path => paradisValidateOpenCodeDatabasePath(path)).filter((path): path is string => path !== undefined))].slice(0, MAX_DATABASES_PER_CLI) : [];
	return { command: raw.command, ...(label !== undefined ? { label } : {}), databases, seenAt: raw.seenAt };
}

export class ParadisOpenCodeCliRegistry {
	private clis: IParadisOpenCodeCli[] = [];
	/** 持ち主の確認の間だけ、名乗ったコマンドを判定に入れる（確認できなければ外す）。 */
	private readonly trial = new Map<string, number>();
	private storePath: string | undefined;
	private loading: Promise<void> | undefined;
	private writing: Promise<void> = Promise.resolve();

	/** 保存先を決めて読み込む（shared process で 1 回。接続先のサーバーでは呼ばないので、覚えた CLI は無い）。 */
	initialize(storePath: string): Promise<void> {
		if (this.storePath === storePath && this.loading !== undefined) {
			return this.loading;
		}
		this.storePath = storePath;
		this.loading = (async () => {
			try {
				const parsed = JSON.parse(await fs.readFile(storePath, 'utf8')) as { readonly clis?: unknown };
				const clis = Array.isArray(parsed.clis) ? parsed.clis.map(parseCli).filter((cli): cli is IParadisOpenCodeCli => cli !== undefined) : [];
				const seen = new Set<string>();
				this.clis = clis.filter(cli => !seen.has(cli.command) && seen.add(cli.command)).slice(0, MAX_CLIS);
			} catch {
				this.clis = [];
			}
			this.publish();
		})();
		return this.loading;
	}

	/** 覚えた CLI（新しく見たものが先）。 */
	list(): readonly IParadisOpenCodeCli[] {
		return this.clis;
	}

	/** 判定に使うコマンド名（覚えたものと、確認中のもの）。 */
	commands(): readonly string[] {
		return [...new Set([...this.clis.map(cli => cli.command), ...this.trial.keys()])];
	}

	/** 覚えた DB と、その会話を再開するコマンド。 */
	databases(): readonly IParadisOpenCodeCliDatabase[] {
		return this.clis.flatMap(cli => cli.databases.map(path => ({ path, command: cli.command, ...(cli.label !== undefined ? { label: cli.label } : {}) })));
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
	 * 持ち主の確認が済んだ CLI を覚える。名前が使えなければ何もしない。DB は確かめて通ったものだけを足す（接続先のペインの
	 * DB は手元のパスではないので、呼ぶ側が渡さない）。
	 */
	async remember(input: { readonly command: string; readonly label?: string; readonly databasePath?: string }, now = Date.now()): Promise<void> {
		await this.loading;
		if (!paradisIsOpenCodeCompatibleCommand(input.command) || input.command === PARADIS_OPENCODE_COMMAND) {
			return;
		}
		const previous = this.clis.find(cli => cli.command === input.command);
		const label = paradisNormalizeOpenCodeCliLabel(input.label) ?? previous?.label;
		const database = paradisValidateOpenCodeDatabasePath(input.databasePath);
		const databases = [...new Set([...(database !== undefined ? [database] : []), ...(previous?.databases ?? [])])].slice(0, MAX_DATABASES_PER_CLI);
		const next: IParadisOpenCodeCli = { command: input.command, ...(label !== undefined ? { label } : {}), databases, seenAt: now };
		const unchanged = previous !== undefined && previous.label === next.label && previous.databases.length === next.databases.length
			&& previous.databases.every((path, index) => path === next.databases[index]) && now - previous.seenAt < 24 * 60 * 60 * 1000;
		if (unchanged) {
			return;
		}
		this.clis = [next, ...this.clis.filter(cli => cli.command !== input.command)].slice(0, MAX_CLIS);
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
		paradisSetOpenCodeCompatibleCommands(this.commands());
	}

	private persist(): Promise<void> {
		const storePath = this.storePath;
		if (storePath === undefined) {
			return Promise.resolve();
		}
		const content = JSON.stringify({ version: 1, clis: this.clis });
		this.writing = this.writing.then(() => paradisWriteFileAtomic(storePath, content, { newFileMode: 0o600, forceMode: 0o600, rejectSymlink: true })).catch(() => { /* 覚えられなくても、今の起動の間は使える */ });
		return this.writing;
	}
}

export const paradisOpenCodeCliRegistry = new ParadisOpenCodeCliRegistry();
