/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MOBILE_HOST_NO_RESPONSE_MESSAGE, PARADIS_MOBILE_STATUS_DEADLINE_MS, PARADIS_MOBILE_STATUS_OPTIONAL_GRACE_MS, paradisIsMobileHostNoResponse, paradisWithHostDeadline } from '../../common/paradisMobileHostDeadline.js';
import { IParadisGitResult } from '../../common/paradisMobileRelay.js';
import { IParadisMobileScmStatusSource, paradisReadMobileScmStatus, paradisReadMobileStatusFiles } from '../../common/paradisMobileScmStatusRead.js';

const NEVER = new Promise<never>(() => { });

/** git の出力（返さないものは `hang` に入れる）。 */
function source(outputs: Record<string, string>, hang: readonly string[] = [], stats: 'ok' | 'hang' = 'ok'): IParadisMobileScmStatusSource & { readonly started: string[] } {
	const started: string[] = [];
	return {
		started,
		runGit: (args): Promise<IParadisGitResult> => {
			const key = args.join(' ');
			started.push(key);
			if (hang.includes(key)) {
				return NEVER;
			}
			return Promise.resolve({ code: 0, stdout: outputs[key] ?? '', stderr: '' });
		},
		statFiles: paths => stats === 'hang' ? NEVER : Promise.resolve(new Map(paths.map(path => [path, { size: 3, mtime: 7 }]))),
	};
}

const OUTPUTS = {
	'status --porcelain=v1': ' M a.ts\n?? new.txt\n',
	'rev-parse --abbrev-ref HEAD': 'main\n',
	'diff --numstat -z': '2\t1\ta.ts\0',
	'diff --cached --numstat -z': '',
	'status --porcelain=v2 --branch --untracked-files=no': '# branch.upstream origin/main\n# branch.ab +1 -0\n',
};

suite('paradisReadMobileScmStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns the full status when every command answers', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		assert.deepStrictEqual(await paradisReadMobileScmStatus(source(OUTPUTS)), {
			t: 'status',
			pathsUnquoted: true,
			branch: 'main',
			files: [{ x: ' ', y: 'M', path: 'a.ts', added: 2, removed: 1 }, { x: '?', y: '?', path: 'new.txt', size: 3, mtime: 7 }],
			upstream: 'origin/main',
			ahead: 1,
			behind: 0,
		});
	}));

	test('omits only the ahead/behind counts when they do not answer in time', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const started = Date.now();
		const status = await paradisReadMobileScmStatus(source(OUTPUTS, ['status --porcelain=v2 --branch --untracked-files=no']));
		assert.deepStrictEqual({ status, elapsed: Date.now() - started }, {
			status: { t: 'status', branch: 'main', files: [{ x: ' ', y: 'M', path: 'a.ts', added: 2, removed: 1 }, { x: '?', y: '?', path: 'new.txt', size: 3, mtime: 7 }], pathsUnquoted: true },
			elapsed: PARADIS_MOBILE_STATUS_OPTIONAL_GRACE_MS,
		});
	}));

	test('never returns a list without the line counts or untracked sizes the review identity needs; it fails as "the host does not respond" instead', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const outcomes: unknown[][] = [];
		for (const make of [
			() => source(OUTPUTS, ['rev-parse --abbrev-ref HEAD']),
			() => source(OUTPUTS, ['diff --numstat -z']),
			() => source(OUTPUTS, ['diff --cached --numstat -z']),
			() => source(OUTPUTS, [], 'hang'),
		]) {
			const started = Date.now();
			const error = await paradisReadMobileScmStatus(make()).then(() => undefined, (e: unknown) => e);
			outcomes.push([paradisIsMobileHostNoResponse(error), (error as Error | undefined)?.message, Date.now() - started]);
		}
		const filesError = await paradisReadMobileStatusFiles(source(OUTPUTS, [], 'hang')).then(() => undefined, (e: unknown) => paradisIsMobileHostNoResponse(e));
		assert.deepStrictEqual({ outcomes, filesError }, {
			outcomes: Array(4).fill([true, PARADIS_MOBILE_HOST_NO_RESPONSE_MESSAGE, PARADIS_MOBILE_STATUS_DEADLINE_MS]),
			filesError: true,
		});
	}));

	test('reads the files with counts for the review, and undefined when git status fails', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const failing: IParadisMobileScmStatusSource = { ...source(OUTPUTS), runGit: async args => ({ code: args[0] === 'status' ? 128 : 0, stdout: '', stderr: 'fatal' }) };
		assert.deepStrictEqual({ files: await paradisReadMobileStatusFiles(source(OUTPUTS)), failed: await paradisReadMobileStatusFiles(failing) }, {
			files: [{ x: ' ', y: 'M', path: 'a.ts', added: 2, removed: 1 }, { x: '?', y: '?', path: 'new.txt', size: 3, mtime: 7 }],
			failed: undefined,
		});
	}));

	test('passes failures through and does not time out a promise that settled in time', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const failed = await paradisWithHostDeadline(Promise.reject(new Error('boom')), 10).then(() => undefined, (e: Error) => e.message);
		assert.deepStrictEqual({ value: await paradisWithHostDeadline(Promise.resolve(1), 10), failed }, { value: 1, failed: 'boom' });
	}));
});
