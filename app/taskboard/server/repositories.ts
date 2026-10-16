// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ITaskBoardRepositoryChoice } from '@engine/paradisTaskBoard.js';
import { git } from './workspaces.js';

/*
 * 上部のメニューで切り替えられるリポジトリの候補。
 * - 最近ボードで開いたリポジトリ（~/.para-code/taskboard/recent.json）
 * - Para Code につないでいるときは、Para Code のウィンドウに登録されたリポジトリ
 */

const MAX_RECENT = 20;

interface IRecent {
	readonly path: string;
	readonly label: string;
	readonly at: number;
}

function recentFile(): string {
	return path.join(os.homedir(), '.para-code', 'taskboard', 'recent.json');
}

async function readRecent(): Promise<IRecent[]> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(recentFile(), 'utf8'));
		return Array.isArray(parsed) ? parsed.filter((r): r is IRecent => typeof r?.path === 'string' && typeof r?.label === 'string' && typeof r?.at === 'number') : [];
	} catch {
		return [];
	}
}

/** どのボードかを問わず、個人設定に書かれた作業場所（クローン・ワークツリーの置き場）。 */
export async function boardPlaces(): Promise<{ readonly clones: readonly string[]; readonly worktreeRoots: readonly string[] }> {
	const root = path.join(os.homedir(), '.para-code', 'taskboard');
	const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	const clones: string[] = [];
	const worktreeRoots: string[] = [];
	for (const dir of dirs.filter(d => d.isDirectory())) {
		try {
			const settings = JSON.parse(await fs.readFile(path.join(root, dir.name, 'settings.json'), 'utf8')) as { clones?: unknown; worktreeRoot?: unknown };
			if (Array.isArray(settings.clones)) {
				clones.push(...settings.clones.filter((c): c is string => typeof c === 'string').map(c => path.resolve(c)));
			}
			if (typeof settings.worktreeRoot === 'string') {
				worktreeRoots.push(path.resolve(settings.worktreeRoot));
			}
		} catch {
			// 設定の無いボード
		}
	}
	return { clones, worktreeRoots };
}

/**
 * ほかのボードが既定の置き場（`<リポジトリ>-worktrees`）に作ったワークツリーか。既定の置き場は個人設定に
 * 記録されないので {@link boardPlaces} では分からない。`--git-common-dir` で本体のリポジトリを引いて確かめる。
 * この置き場は Para Code 本体の「新しいスペース」の既定でもあるので、ボードが作業場所に置く持ち主の印
 * （`.para/.task`）があるものだけをボードの作業場所とみなす。本体のリポジトリそのものは含めない。
 */
export async function isOtherBoardWorktree(toplevel: string): Promise<boolean> {
	const real = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
	const common = await git(toplevel, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 5000).catch(() => undefined);
	if (!common || path.basename(common) !== '.git') {
		return false;
	}
	const main = real(path.dirname(common));
	if (main === real(toplevel)) {
		return false;
	}
	const root = path.join(path.dirname(main), `${path.basename(main)}-worktrees`);
	return real(toplevel).startsWith(`${real(root)}${path.sep}`)
		&& await fs.access(path.join(toplevel, '.para', '.task')).then(() => true, () => false);
}

/** 開いたリポジトリを最近の一覧の先頭に入れる。 */
export async function rememberRepository(repoPath: string, label: string): Promise<void> {
	const list = [{ path: repoPath, label, at: Date.now() }, ...(await readRecent()).filter(r => r.path !== repoPath)].slice(0, MAX_RECENT);
	await fs.mkdir(path.dirname(recentFile()), { recursive: true });
	const tmp = `${recentFile()}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(list), 'utf8');
	await fs.rename(tmp, recentFile());
}

/** 最近の一覧と Para Code のリポジトリを、重複を除いて並べる（最近開いたものが先）。 */
export async function repositoryChoices(paraCode: readonly { readonly path: string; readonly name: string }[]): Promise<ITaskBoardRepositoryChoice[]> {
	const seen = new Set<string>();
	const out: ITaskBoardRepositoryChoice[] = [];
	for (const r of await readRecent()) {
		if (!seen.has(r.path)) {
			seen.add(r.path);
			out.push({ path: r.path, label: r.label, source: 'recent', openedAt: r.at });
		}
	}
	for (const r of paraCode) {
		if (!seen.has(r.path)) {
			seen.add(r.path);
			out.push({ path: r.path, label: r.name || path.basename(r.path), source: 'para-code' });
		}
	}
	return out;
}
