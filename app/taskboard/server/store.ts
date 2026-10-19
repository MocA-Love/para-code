// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ITaskBoardPersisted } from '@engine/paradisTaskBoardEngine.js';

/*
 * 台帳と個人設定の保存先。リポジトリごとに分ける。
 *   ~/.para-code/taskboard/<repo のパスの hash>/state.json     台帳
 *   ~/.para-code/taskboard/<repo のパスの hash>/settings.json  クローンの場所など（リポジトリに書かない個人の設定）
 */

export interface ILocalSettings {
	/** クローンの使い回しに使うディレクトリ（絶対パス）。 */
	readonly clones?: readonly string[];
	readonly worktreeRoot?: string;
	readonly speed?: number;
}

export function dataDir(repoPath: string | undefined, override?: string): string {
	if (override) {
		return override;
	}
	const key = createHash('sha256').update(repoPath ?? 'no-repo').digest('hex').slice(0, 16);
	return path.join(os.homedir(), '.para-code', 'taskboard', key);
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as T;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		// 壊れたファイルは退避して空から始める（黙って上書きしない）
		await fs.rename(file, `${file}.broken-${Date.now()}`).catch(() => undefined);
		return undefined;
	}
}

async function writeJson(file: string, data: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
	await fs.rename(tmp, file);
}

/** 台帳を開いているボード。同じリポジトリを 2 つのボードで開くと、両方のエンジンが同じ台帳と作業場所を使ってしまう。 */
export interface IStoreOwner {
	readonly pid: number;
	/** 台帳の場所（断るときに、どの印かを伝えるため。書くときは入れない）。 */
	readonly dir?: string;
	/** Para Code が起動したボードか、手で起動したボード（pnpm dev 等）か。 */
	readonly mode: 'embedded' | 'standalone';
	readonly at: number;
}

/** ほかの生きているボードが台帳を開いている。 */
export class StoreBusyError extends Error {
	constructor(readonly owner: IStoreOwner) {
		super(`another task board (pid ${owner.pid}, ${owner.mode}) has this repository open (${owner.dir})`);
		this.name = 'StoreBusyError';
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// 権限が無いだけなら生きている
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** 台帳のディレクトリを開いている、自分以外の生きているボード。 */
export async function storeOwner(dir: string): Promise<IStoreOwner | undefined> {
	try {
		const owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8')) as IStoreOwner;
		return typeof owner?.pid === 'number' && owner.pid !== process.pid && alive(owner.pid) ? { ...owner, dir } : undefined;
	} catch {
		return undefined;
	}
}

export class Store {
	private timer: NodeJS.Timeout | undefined;
	private pending: (() => ITaskBoardPersisted) | undefined;
	private writing: Promise<void> = Promise.resolve();
	/** 閉じた後は書かない（別のリポジトリで開き直した後も、古いエンジンのタイマーが動き続けるため）。 */
	private closed = false;
	private locked = false;

	constructor(private readonly dir: string) { }

	get directory(): string {
		return this.dir;
	}

	/** 台帳を自分のものにする。ほかの生きているボードが開いていれば StoreBusyError。閉じると手放す。 */
	async lock(mode: IStoreOwner['mode']): Promise<void> {
		const other = await storeOwner(this.dir);
		if (other) {
			throw new StoreBusyError(other);
		}
		await writeJson(path.join(this.dir, 'owner.json'), { pid: process.pid, mode, at: Date.now() } satisfies IStoreOwner);
		this.locked = true;
	}

	loadState(): Promise<ITaskBoardPersisted | undefined> {
		return readJson<ITaskBoardPersisted>(path.join(this.dir, 'state.json'));
	}

	loadSettings(): Promise<ILocalSettings | undefined> {
		return readJson<ILocalSettings>(path.join(this.dir, 'settings.json'));
	}

	saveSettings(settings: ILocalSettings): Promise<void> {
		return writeJson(path.join(this.dir, 'settings.json'), settings);
	}

	/**
	 * 変更が続く間は 1 秒まとめてから書く。台帳の組み立て（serialize）も書く直前に 1 回だけ行う
	 * （成果物を含むと大きいので、変更のたびには組み立てない）。
	 */
	scheduleSave(state: () => ITaskBoardPersisted): void {
		if (this.closed) {
			return;
		}
		this.pending = state;
		if (this.timer) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.closed) {
				void this.flush();
			}
		}, 1000);
	}

	/** 残りを書き出し、以後の保存を断る。 */
	async close(): Promise<void> {
		// 先に閉じてから書く（書いている間に予約された保存が、閉じた後に古い内容で書かないように）
		this.closed = true;
		await this.flush();
		if (this.locked) {
			this.locked = false;
			const file = path.join(this.dir, 'owner.json');
			const owner = await fs.readFile(file, 'utf8').then(text => JSON.parse(text) as IStoreOwner, () => undefined);
			if (owner?.pid === process.pid) {
				await fs.rm(file, { force: true });
			}
		}
	}

	flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		const state = this.pending;
		this.pending = undefined;
		if (!state) {
			return this.writing;
		}
		this.writing = this.writing.then(() => writeJson(path.join(this.dir, 'state.json'), state())).catch(err => {
			console.error('[taskboard] failed to save state:', err);
		});
		return this.writing;
	}
}
