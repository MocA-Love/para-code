/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSentryProcessEnvironment, isParadisSentryDevelopmentBuild, paradisSentryEnvironment, paradisSentryRelease } from '../../common/paradisSentryConfiguration.js';

suite('paradisSentryRelease', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports the release stamped at package time and falls back to version and commit without it', () => {
		assert.deepStrictEqual([
			paradisSentryRelease('1.139.1', 'abc123', 'para-code@1.139.1.148+abc123'),
			paradisSentryRelease('1.139.1', 'abc123', ' para-code@1.139.1.148-beta.1+abc123 '),
			paradisSentryRelease('1.139.1', 'abc123', ''),
			paradisSentryRelease('1.139.1', 'abc123', undefined),
			paradisSentryRelease('1.139.1', undefined, undefined),
		], [
			'para-code@1.139.1.148+abc123',
			'para-code@1.139.1.148-beta.1+abc123',
			'para-code@1.139.1+abc123',
			'para-code@1.139.1+abc123',
			'para-code@1.139.1',
		]);
	});
});

suite('paradisSentryEnvironment', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('skips builds run out of sources and files CI smoke tests of the packaged build under local', () => {
		const cases: IParadisSentryProcessEnvironment[] = [
			{},
			{ VSCODE_DEV: '1' },
			{ VSCODE_DEV: '1', CI: 'true' },
			{ VSCODE_DEV: '' },
			{ CI: 'true' },
			{ GITHUB_ACTIONS: 'true' },
			{ CI: 'false' },
			{ CI: '0', GITHUB_ACTIONS: '' },
		];
		assert.deepStrictEqual(cases.map(env => ({
			skipped: isParadisSentryDevelopmentBuild(env),
			environment: paradisSentryEnvironment(env),
		})), [
			{ skipped: false, environment: 'production' },
			{ skipped: true, environment: 'local' },
			{ skipped: true, environment: 'local' },
			{ skipped: false, environment: 'production' },
			{ skipped: false, environment: 'local' },
			{ skipped: false, environment: 'local' },
			{ skipped: false, environment: 'production' },
			{ skipped: false, environment: 'production' },
		]);
	});
});
