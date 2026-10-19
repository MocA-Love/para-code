// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { commandPath } from '../server/executables.js';

describe('commandPath', () => {
	test('on Windows finds a command only on absolute PATH entries, never in a relative one such as the working folder', () => {
		const files = new Set(['c:\\tools\\gh.exe', 'repo\\git.exe', '.\\git.exe']);
		// Windows のファイル名は大文字小文字を区別しない
		const exists = (file: string) => files.has(file.toLowerCase());
		// "." と相対の "repo" に置いた git.exe は拾わない
		const env = { Path: '.;repo;C:\\tools' };
		expect({
			gh: commandPath('gh', env, 'win32', exists),
			git: commandPath('git', env, 'win32', exists),
			cmd: commandPath('cmd.exe', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32'),
			posix: commandPath('git', env, 'darwin'),
		}).toEqual({ gh: 'C:\\tools\\gh.EXE', git: 'git', cmd: 'C:\\Windows\\System32\\cmd.exe', posix: 'git' });
	});
});
