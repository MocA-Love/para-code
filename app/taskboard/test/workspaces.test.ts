// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ITaskBoardSlot, ITaskBoardTask } from '@engine/paradisTaskBoard.js';
import { TaskBoardWorkspaceError } from '@engine/paradisTaskBoardEngine.js';
import { GitWorkspaces, inspectClones } from '../server/workspaces.js';

/*
 * 作業場所の git 操作を、使い捨ての git リポジトリで実際に動かして確かめる。
 * origin（bare）と、そこから作ったクローン 2 つとメインのチェックアウトを用意する。
 */

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();

let root: string;
let origin: string;
let main: string;
let cloneA: string;
let cloneB: string;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), 'tb-git-'));
	origin = path.join(root, 'origin.git');
	run(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
	main = path.join(root, 'repo');
	run(root, 'clone', '--quiet', origin, main);
	for (const cwd of [main]) {
		run(cwd, 'config', 'user.email', 'test@example.com');
		run(cwd, 'config', 'user.name', 'test');
	}
	writeFileSync(path.join(main, 'a.txt'), 'one\n');
	run(main, 'add', '.');
	run(main, 'commit', '--quiet', '-m', 'init');
	run(main, 'push', '--quiet', 'origin', 'main');
	run(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
	cloneA = path.join(root, 'repo-1');
	cloneB = path.join(root, 'repo-2');
	for (const c of [cloneA, cloneB]) {
		run(root, 'clone', '--quiet', origin, c);
		run(c, 'config', 'user.email', 'test@example.com');
		run(c, 'config', 'user.name', 'test');
	}
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const task = (branch?: string) => ({ id: 't1', title: 'T', branch } as ITaskBoardTask);
const slot = (p: string): ITaskBoardSlot => ({ id: `clone:${p}`, name: path.basename(p), path: p, kind: 'clone-pool' });

describe('GitWorkspaces', () => {
	test('クローン: 新しいブランチを既定のブランチから作り、別のクローンではリモートのブランチを追う', async () => {
		const ws = new GitWorkspaces(main, path.join(root, 'wt'));
		await ws.prepare(task(), slot(cloneA), 'para/1-x');
		expect(run(cloneA, 'branch', '--show-current')).toBe('para/1-x');
		writeFileSync(path.join(cloneA, 'b.txt'), 'work\n');
		run(cloneA, 'add', '.');
		run(cloneA, 'commit', '--quiet', '-m', 'work');
		run(cloneA, 'push', '--quiet', '-u', 'origin', 'para/1-x');
		await ws.release(task('para/1-x'), slot(cloneA));
		expect(run(cloneA, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
		// PR を出して返した後、別のクローンで続きをする
		await ws.prepare(task('para/1-x'), slot(cloneB), 'para/1-x');
		expect(existsSync(path.join(cloneB, 'b.txt'))).toBe(true);
	});

	test('止めた後は貸し出しも返却もしない（開き直した後の古いボードが作業場所に触らないように）', async () => {
		const ws = new GitWorkspaces(main, path.join(root, 'wt'));
		await ws.stop();
		await expect(ws.prepare(task(), slot(cloneA), 'para/9-z')).rejects.toBeInstanceOf(TaskBoardWorkspaceError);
		await expect(ws.release(task('para/9-z'), slot(cloneA))).rejects.toBeInstanceOf(TaskBoardWorkspaceError);
		expect(run(cloneA, 'branch', '--show-current')).toBe('main');
	});

	test('返却の前に、PR のブランチより先のコミットを push する。別のブランチにいれば push しない', async () => {
		const ws = new GitWorkspaces(main, path.join(root, 'wt'));
		await ws.prepare(task(), slot(cloneA), 'para/3-p');
		run(cloneA, 'push', '--quiet', '-u', 'origin', 'para/3-p');
		writeFileSync(path.join(cloneA, 'later.txt'), 'later\n');
		run(cloneA, 'add', '.');
		run(cloneA, 'commit', '--quiet', '-m', 'later');
		const withPr = { ...task('para/3-p'), pr: { owner: 'o', repo: 'r', number: 1, url: '', title: '', state: 'draft', checks: 'none', review: 'none' } } as ITaskBoardTask;
		await ws.release(withPr, slot(cloneA));
		expect(run(origin, 'log', '-1', '--format=%s', 'para/3-p')).toBe('later');
	});

	test('クローン: 未コミットの変更があれば貸し出しを断り、返却でも触らない', async () => {
		const ws = new GitWorkspaces(main, path.join(root, 'wt'));
		writeFileSync(path.join(cloneA, 'a.txt'), 'local change\n');
		await expect(ws.prepare(task(), slot(cloneA), 'para/2-y')).rejects.toMatchObject({ reason: 'dirty' });
		expect(await inspectClones([cloneA, cloneB, path.join(root, 'nope')])).toMatchObject([{ dirty: true }, { dirty: false }, { missing: true }]);
		await ws.release(task(), slot(cloneA));
		expect(run(cloneA, 'status', '--porcelain')).toContain('a.txt');
		expect(run(cloneA, 'branch', '--show-current')).toBe('main');
	});

	test('ワークツリー: ブランチ名から場所を決め、残っていれば使い直し、返却で消す（変更があれば残す）', async () => {
		const ws = new GitWorkspaces(main, path.join(root, 'wt'));
		const wtSlot: ITaskBoardSlot = { id: 'wt:t1', name: '3-z', path: '', kind: 'worktree' };
		const first = await ws.prepare(task(), wtSlot, 'para/3-z');
		expect(first.path).toBe(ws.worktreeDir('para/3-z'));
		// 返す前に作業場所が残ったまま再着手しても、同じブランチなら使い直す
		const again = await ws.prepare(task('para/3-z'), wtSlot, 'para/3-z');
		expect(again.path).toBe(first.path);
		writeFileSync(path.join(first.path, 'c.txt'), 'wip\n');
		// path が空でも（再起動後など）ブランチ名から場所を求めて片付ける。未コミットの変更があるので残す
		await ws.release(task('para/3-z'), wtSlot);
		expect(existsSync(first.path)).toBe(true);
		rmSync(path.join(first.path, 'c.txt'));
		await ws.release(task('para/3-z'), wtSlot);
		expect(existsSync(first.path)).toBe(false);
	});

	test('ワークツリー: 同じ場所に関係ないディレクトリがあれば断る', async () => {
		const ws = new GitWorkspaces(main, path.join(root, 'wt'));
		execFileSync('mkdir', ['-p', ws.worktreeDir('para/4-w')]);
		await expect(ws.prepare(task(), { id: 'wt:t1', name: '4-w', path: '', kind: 'worktree' }, 'para/4-w')).rejects.toBeInstanceOf(TaskBoardWorkspaceError);
	});
});
