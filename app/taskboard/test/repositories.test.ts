// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { isOtherBoardWorktree } from '../server/repositories.js';

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
