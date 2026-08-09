/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisParseWorkspaceLifecycleConfig, paradisResolveLifecycleTimeoutMinutes, paradisUpdateWorkspaceLifecycleConfig, PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES, PARADIS_LIFECYCLE_TIMEOUT_MINUTES_MAX, PARADIS_LIFECYCLE_TIMEOUT_MINUTES_MIN } from '../../common/paradisWorkspaceLifecycle.js';

suite('Paradis workspace lifecycle configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads trimmed script strings and ignores wrong types', () => {
		assert.deepStrictEqual(paradisParseWorkspaceLifecycleConfig(`{
			// repository lifecycle
			"setupScript": " bun install ",
			"teardownScript": false
		}`), { setupScript: 'bun install' });
	});

	test('reads per-repository timeouts and clamps them into range', () => {
		assert.deepStrictEqual(paradisParseWorkspaceLifecycleConfig(`{
			"teardownScript": "docker compose down --rmi all --volumes",
			"teardownTimeoutMinutes": 30,
			"setupTimeoutMinutes": 9999
		}`), {
			teardownScript: 'docker compose down --rmi all --volumes',
			setupTimeoutMinutes: PARADIS_LIFECYCLE_TIMEOUT_MINUTES_MAX,
			teardownTimeoutMinutes: 30
		});
	});

	test('falls back to the default timeout for missing or invalid values', () => {
		assert.deepStrictEqual([
			paradisResolveLifecycleTimeoutMinutes(undefined),
			paradisResolveLifecycleTimeoutMinutes('30'),
			paradisResolveLifecycleTimeoutMinutes(Number.NaN),
			paradisResolveLifecycleTimeoutMinutes(0),
			paradisResolveLifecycleTimeoutMinutes(30)
		], [
			PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES,
			PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES,
			PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES,
			PARADIS_LIFECYCLE_TIMEOUT_MINUTES_MIN,
			30
		]);
	});

	test('throws for malformed JSONC', () => {
		assert.throws(() => paradisParseWorkspaceLifecycleConfig('{ "setupScript": '));
	});

	test('updates scripts while preserving existing fields', () => {
		const updated = paradisUpdateWorkspaceLifecycleConfig(
			'{ "presets": [{ "name": "dev" }], "future": 7 }',
			{ setupScript: 'bun install', teardownScript: undefined }
		);
		assert.deepStrictEqual(JSON.parse(updated), {
			presets: [{ name: 'dev' }],
			future: 7,
			setupScript: 'bun install'
		});
	});
});
