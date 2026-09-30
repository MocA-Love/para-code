/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { suite, test } from 'node:test';
import { classifyParadisReleaseTag, findPreviousParadisStableTag, getParadisSentryRelease, getParadisSentryReleaseFromEnv, planParadisRelease } from '../paradisReleaseChannel.ts';

suite('Para Code release channel', () => {
	test('classifies release tags into stable, beta and other', () => {
		const tags = [
			'v1.135.0-paracode-145',
			'v1.139.1-paracode-146',
			'v1.139.1-paracode-146-beta.1',
			'v1.139.1-paracode-146-beta.12',
			'v1.139.1-paracode-146-rc1',
			'v1.139.1',
			'v1.139.1-paracode-146-beta',
			'v1.139.1-paracode-146-beta.1-rc',
			'v1.139.1-paracode-146-Beta.1',
			'v1.139.1-paracode-',
			'1.139.1-paracode-146',
			'v1.139-paracode-146',
			'v1.139.1-paracode-146\n',
			'vsda-v1.39.1',
			'reh',
		];
		assert.deepStrictEqual(tags.map(tag => [tag, classifyParadisReleaseTag(tag)]), [
			['v1.135.0-paracode-145', 'stable'],
			['v1.139.1-paracode-146', 'stable'],
			['v1.139.1-paracode-146-beta.1', 'beta'],
			['v1.139.1-paracode-146-beta.12', 'beta'],
			['v1.139.1-paracode-146-rc1', 'other'],
			['v1.139.1', 'other'],
			['v1.139.1-paracode-146-beta', 'other'],
			['v1.139.1-paracode-146-beta.1-rc', 'other'],
			['v1.139.1-paracode-146-Beta.1', 'other'],
			['v1.139.1-paracode-', 'other'],
			['1.139.1-paracode-146', 'other'],
			['v1.139-paracode-146', 'other'],
			['v1.139.1-paracode-146\n', 'other'],
			['vsda-v1.39.1', 'other'],
			['reh', 'other'],
		]);
	});

	test('plans what each ref may build and publish', () => {
		const refs = [
			{ name: 'stable tag push', eventName: 'push', refType: 'tag', refName: 'v1.135.0-paracode-145', platforms: '' },
			{ name: 'beta tag push', eventName: 'push', refType: 'tag', refName: 'v1.139.1-paracode-146-beta.1', platforms: '' },
			{ name: 'unknown tag push', eventName: 'push', refType: 'tag', refName: 'v1.139.1-paracode-146-rc1', platforms: '' },
			{ name: 'dispatch on a stable tag', eventName: 'workflow_dispatch', refType: 'tag', refName: 'v1.135.0-paracode-145', platforms: '' },
			{ name: 'dispatch on a stable tag, subset', eventName: 'workflow_dispatch', refType: 'tag', refName: 'v1.135.0-paracode-145', platforms: 'darwin,Linux' },
			{ name: 'dispatch on a beta tag, all', eventName: 'workflow_dispatch', refType: 'tag', refName: 'v1.139.1-paracode-146-beta.1', platforms: '' },
			{ name: 'dispatch on a beta tag, win32 asked', eventName: 'workflow_dispatch', refType: 'tag', refName: 'v1.139.1-paracode-146-beta.1', platforms: 'win32' },
			{ name: 'dispatch on a branch, all', eventName: 'workflow_dispatch', refType: 'branch', refName: 'main', platforms: '' },
			{ name: 'dispatch on a branch, subset', eventName: 'workflow_dispatch', refType: 'branch', refName: 'para/beta-channel', platforms: 'win32' },
		];
		const row = (kind: string, channel: string, publish: boolean, darwin: boolean, win32: boolean, linux: boolean) => ({ kind, channel, publish, darwin, win32, linux });

		assert.deepStrictEqual(Object.fromEntries(refs.map(({ name, ...ref }) => {
			const plan = planParadisRelease(ref);
			assert.strictEqual(plan.isBeta, plan.channel === 'beta');
			assert.strictEqual(plan.error !== undefined, plan.kind === 'other');
			return [name, row(plan.kind, plan.channel, plan.publish, plan.buildDarwin, plan.buildWin32, plan.buildLinux)];
		})), {
			'stable tag push': row('stable', 'stable', true, true, true, true),
			'beta tag push': row('beta', 'beta', true, true, false, false),
			'unknown tag push': row('other', 'stable', false, false, false, false),
			'dispatch on a stable tag': row('stable', 'stable', true, true, true, true),
			'dispatch on a stable tag, subset': row('stable', 'stable', false, true, false, true),
			'dispatch on a beta tag, all': row('beta', 'beta', true, true, false, false),
			'dispatch on a beta tag, win32 asked': row('beta', 'beta', false, false, false, false),
			'dispatch on a branch, all': row('branch', 'stable', false, true, true, true),
			'dispatch on a branch, subset': row('branch', 'stable', false, false, true, false),
		});
	});

	test('finds the stable tag the stable release notes start from', () => {
		const tags = ['v1.139.1-paracode-147', 'reh', 'v1.139.1-paracode-146-beta.2', 'v1.135.0-paracode-145', 'v1.135.0-paracode-144', ' v1.128.0-paracode-9 ', 'v0.3.11'];
		assert.deepStrictEqual({
			next: findPreviousParadisStableTag('v1.139.1-paracode-146', tags),
			rerunOld: findPreviousParadisStableTag('v1.135.0-paracode-145', tags),
			numericNotLexical: findPreviousParadisStableTag('v1.128.0-paracode-10', tags),
			first: findPreviousParadisStableTag('v1.128.0-paracode-1', tags),
			beta: findPreviousParadisStableTag('v1.139.1-paracode-146-beta.1', tags),
			noReleases: findPreviousParadisStableTag('v1.139.1-paracode-146', []),
		}, {
			next: 'v1.135.0-paracode-145',
			rerunOld: 'v1.135.0-paracode-144',
			numericNotLexical: 'v1.128.0-paracode-9',
			first: undefined,
			beta: undefined,
			noReleases: undefined,
		});
	});

	test('names the Sentry release after the paracode number of the release tag', () => {
		const commit = '699deb217ffb02666f2e486ed7d32ce06f319331';
		const tag = (refName: string) => ({ refType: 'tag', refName });
		assert.deepStrictEqual({
			stable: getParadisSentryRelease('1.139.1', commit, tag('v1.139.1-paracode-148')),
			beta: getParadisSentryRelease('1.139.1', commit, tag('v1.139.1-paracode-148-beta.2')),
			leadingZeros: getParadisSentryRelease('1.139.1', commit, tag('v1.139.1-paracode-0148-beta.02')),
			branch: getParadisSentryRelease('1.139.1', commit, { refType: 'branch', refName: 'main' }),
			branchNamedLikeATag: getParadisSentryRelease('1.139.1', commit, { refType: 'branch', refName: 'v1.139.1-paracode-148' }),
			otherTag: getParadisSentryRelease('1.139.1', commit, tag('v1.139.1-paracode-148-rc1')),
			unexpectedVersion: getParadisSentryRelease('1.139.1-insider', commit, tag('v1.139.1-paracode-148')),
			noCommit: getParadisSentryRelease('1.139.1', undefined, tag('v1.139.1-paracode-148')),
			local: getParadisSentryReleaseFromEnv('1.139.1', undefined, {}),
			fromEnv: getParadisSentryReleaseFromEnv('1.139.1', commit, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.139.1-paracode-148-beta.1' }),
		}, {
			stable: `para-code@1.139.1.148+${commit}`,
			beta: `para-code@1.139.1.148-beta.2+${commit}`,
			leadingZeros: `para-code@1.139.1.148-beta.2+${commit}`,
			branch: `para-code@1.139.1+${commit}`,
			branchNamedLikeATag: `para-code@1.139.1+${commit}`,
			otherTag: `para-code@1.139.1+${commit}`,
			unexpectedVersion: `para-code@1.139.1-insider+${commit}`,
			noCommit: 'para-code@1.139.1.148',
			local: 'para-code@1.139.1',
			fromEnv: `para-code@1.139.1.148-beta.1+${commit}`,
		});
	});
});
