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

export class Store {
	private timer: NodeJS.Timeout | undefined;
	private pending: (() => ITaskBoardPersisted) | undefined;
	private writing: Promise<void> = Promise.resolve();
	/** 閉じた後は書かない（別のリポジトリで開き直した後も、古いエンジンのタイマーが動き続けるため）。 */
	private closed = false;

	constructor(private readonly dir: string) { }

	get directory(): string {
		return this.dir;
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
