/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import {
	ParadisSpaceDefaultTarget,
	paradisParseSpaceDefaults,
	paradisPruneSpaceDefaults,
	paradisResolveSpaceDefault,
	paradisSerializeSpaceDefaults,
	paradisSpaceDefaultTargetsEqual,
} from '../../common/paradisBrowserSpaceDefaults.js';

const WORK: ParadisSpaceDefaultTarget = { kind: 'profile', profileId: '0123456789ab' };
const QA: ParadisSpaceDefaultTarget = { kind: 'profile', profileId: 'abcdef012345' };
const EPHEMERAL: ParadisSpaceDefaultTarget = { kind: 'scope', scope: BrowserViewStorageScope.Ephemeral };

const REPOSITORY = 'repo-shop-web';
const WORKTREE = 'worktree:file:///Users/example/projects/shop-web-checkout';

suite('paradisBrowserSpaceDefaults', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a worktree uses its own default first, then its main tree\'s, and nothing when inheritance is off', () => {
		const onlyParent = new Map<string, ParadisSpaceDefaultTarget>([[REPOSITORY, WORK]]);
		const both = new Map<string, ParadisSpaceDefaultTarget>([[REPOSITORY, WORK], [WORKTREE, EPHEMERAL]]);
		assert.deepStrictEqual([
			paradisResolveSpaceDefault(both, WORKTREE, REPOSITORY, true),
			paradisResolveSpaceDefault(onlyParent, WORKTREE, REPOSITORY, true),
			paradisResolveSpaceDefault(onlyParent, WORKTREE, REPOSITORY, false),
			paradisResolveSpaceDefault(onlyParent, REPOSITORY, undefined, true),
			paradisResolveSpaceDefault(new Map(), REPOSITORY, undefined, true),
		], [
			{ target: EPHEMERAL, inherited: false },
			{ target: WORK, inherited: true },
			undefined,
			{ target: WORK, inherited: false },
			undefined,
		]);
	});

	test('the table survives a round trip and drops entries it cannot use', () => {
		const raw = JSON.stringify({
			[REPOSITORY]: WORK,
			[WORKTREE]: EPHEMERAL,
			'agent-space': { kind: 'scope', scope: BrowserViewStorageScope.Agent },
			'bad-profile': { kind: 'profile', profileId: 'not-an-id' },
			'': WORK,
		});
		const parsed = paradisParseSpaceDefaults(raw);
		assert.deepStrictEqual([...parsed], [[REPOSITORY, WORK], [WORKTREE, EPHEMERAL]]);
		assert.deepStrictEqual([...paradisParseSpaceDefaults(paradisSerializeSpaceDefaults(parsed))], [...parsed]);
		assert.deepStrictEqual([...paradisParseSpaceDefaults('{broken'), ...paradisParseSpaceDefaults('[]')], []);
	});

	test('pruning removes only defaults that point at deleted profiles', () => {
		const defaults = new Map<string, ParadisSpaceDefaultTarget>([[REPOSITORY, WORK], [WORKTREE, QA], ['docs-site', EPHEMERAL]]);
		const removed = paradisPruneSpaceDefaults(defaults, new Set([WORK.kind === 'profile' ? WORK.profileId : '']));
		assert.deepStrictEqual({ removed, left: [...defaults.keys()] }, { removed: [WORKTREE], left: [REPOSITORY, 'docs-site'] });
	});

	test('targets compare by what they point at', () => {
		assert.deepStrictEqual([
			paradisSpaceDefaultTargetsEqual(WORK, { kind: 'profile', profileId: '0123456789ab' }),
			paradisSpaceDefaultTargetsEqual(WORK, QA),
			paradisSpaceDefaultTargetsEqual(EPHEMERAL, { kind: 'scope', scope: BrowserViewStorageScope.Global }),
			paradisSpaceDefaultTargetsEqual(undefined, undefined),
			paradisSpaceDefaultTargetsEqual(WORK, undefined),
		], [true, false, false, true, false]);
	});
});
