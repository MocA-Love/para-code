// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TASK_BOARD_DEFAULT_FLOW } from '@engine/paradisTaskBoardFlow.js';
import { embeddedFlows } from '../server/flows.js';
import { checkCloneFolder, isOtherBoardWorktree } from '../server/repositories.js';

describe('isOtherBoardWorktree', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

	test('finds board worktrees in <repo>-worktrees, but not Para Code spaces there, the repository itself or worktrees elsewhere', async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), 'tb-repos-'));
		dirs.push(root);
		const main = path.join(root, 'app');
		mkdirSync(main);
		const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
		run(main, 'init', '-q');
		run(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
		run(main, 'worktree', 'add', '-q', '-b', 'a', path.join(root, 'app-worktrees', 'a'));
		run(main, 'worktree', 'add', '-q', '-b', 'b', path.join(root, 'elsewhere', 'b'));
		run(main, 'worktree', 'add', '-q', '-b', 'c', path.join(root, 'app-worktrees', 'c'));
		mkdirSync(path.join(root, 'app-worktrees', 'a', '.para'));
		writeFileSync(path.join(root, 'app-worktrees', 'a', '.para', '.task'), 'gh:o/r#1\n');
		expect({
			main: await isOtherBoardWorktree(main),
			defaultRoot: await isOtherBoardWorktree(path.join(root, 'app-worktrees', 'a')),
			elsewhere: await isOtherBoardWorktree(path.join(root, 'elsewhere', 'b')),
			paraCodeSpace: await isOtherBoardWorktree(path.join(root, 'app-worktrees', 'c')),
			notGit: await isOtherBoardWorktree(root),
		}).toEqual({ main: false, defaultRoot: true, elsewhere: false, paraCodeSpace: false, notGit: false });
	}, 20000);
});

describe('checkCloneFolder', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

	// 画面から足すクローンは、同じ origin の別の clone だけ。リポジトリそのもの・そのワークツリー・別のリポジトリ・中のフォルダは断る
	test('accepts only another clone of the same origin', async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), 'tb-clones-'));
		dirs.push(root);
		const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
		const repo = (name: string, origin?: string) => {
			const dir = path.join(root, name);
			mkdirSync(dir);
			run(dir, 'init', '-q');
			run(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
			if (origin) {
				run(dir, 'remote', 'add', 'origin', origin);
			}
			return dir;
		};
		const main = repo('app', 'git@github.com:Example/App.git');
		const clone = repo('app-1', 'https://github.com/example/app');
		const other = repo('other', 'https://github.com/example/other.git');
		const noOrigin = repo('local');
		run(main, 'worktree', 'add', '-q', '-b', 'a', path.join(root, 'wt'));
		mkdirSync(path.join(clone, 'src'));
		const verdict = async (folder: string) => {
			const result = await checkCloneFolder(main, folder);
			return result.ok ? `ok ${path.basename(result.path)}` : result.message;
		};
		expect({
			clone: await verdict(clone),
			itself: await verdict(main),
			worktree: await verdict(path.join(root, 'wt')),
			otherRepo: await verdict(other),
			noOrigin: await verdict(noOrigin),
			inside: await verdict(path.join(clone, 'src')),
			notGit: await verdict(root),
		}).toEqual({
			clone: 'ok app-1',
			itself: 'このリポジトリそのものと、そのワークツリーは足せません。別の場所に clone したフォルダを選んでください',
			worktree: 'このリポジトリそのものと、そのワークツリーは足せません。別の場所に clone したフォルダを選んでください',
			otherRepo: 'このボードのリポジトリと同じ origin の clone を選んでください',
			noOrigin: 'このボードのリポジトリと同じ origin の clone を選んでください',
			inside: 'git のリポジトリの一番上のフォルダを選んでください',
			notGit: 'git のリポジトリの一番上のフォルダを選んでください',
		});
	}, 20000);
});

describe('embeddedFlows', () => {
	// Para Code が開くボードは、組み込みのフローだけをワークツリーで始める（保存したフローは書かれたとおり）
	test('starts the built-in flow in worktrees and leaves saved flows as written', () => {
		const saved = { ...TASK_BOARD_DEFAULT_FLOW, id: 'team', scope: 'team' as const };
		expect([TASK_BOARD_DEFAULT_FLOW.workspace.kind, ...embeddedFlows([TASK_BOARD_DEFAULT_FLOW, saved]).map(flow => `${flow.id} ${flow.workspace.kind} ${flow.workspace.maxRunning}`)]).toEqual(['clone-pool', 'default worktree 4', 'team clone-pool 4']);
	});
});
