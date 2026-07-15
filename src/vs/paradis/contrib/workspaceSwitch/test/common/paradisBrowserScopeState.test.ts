/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisBrowserScopeState, paradisParseBrowserScopeStorage } from '../../common/paradisBrowserScopeState.js';
import { ParadisBindingScopeEligibilityError, isParadisBindingScopeEligibilityError, paradisEvaluateBindingScopeEligibility, paradisRequireBindingScopeEligibility } from '../../common/paradisWorkspaceSwitch.js';

suite('ParadisBrowserScopeState', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('distinguishes absent, valid, and corrupt storage', () => {
		assert.deepStrictEqual(paradisParseBrowserScopeStorage(undefined), { kind: 'absent' });
		assert.deepStrictEqual(paradisParseBrowserScopeStorage(JSON.stringify({ version: 1, entries: [{ viewId: 'view-a', stateKey: 'space-a' }] })), {
			kind: 'valid',
			entries: [['view-a', 'space-a']],
		});
		assert.deepStrictEqual(paradisParseBrowserScopeStorage('{'), { kind: 'corrupt' });
		assert.deepStrictEqual(paradisParseBrowserScopeStorage(JSON.stringify({
			version: 1, entries: [
				{ viewId: 'view-a', stateKey: 'space-a' },
				{ viewId: 'view-a', stateKey: 'space-b' },
			]
		})), { kind: 'corrupt' });
	});

	test('keeps unknown initial views pending until an explicit stable tag', () => {
		const state = store.add(new ParadisBrowserScopeState(undefined));
		assert.deepStrictEqual(state.resolveScope('unknown'), { kind: 'pending' });
		state.tagManaged('unknown', 'space-a', 'initialTag');
		assert.deepStrictEqual(state.resolveScope('unknown'), { kind: 'managed', stateKey: 'space-a' });
	});

	test('restores inactive managed views and distinguishes stable reassignment from retirement', () => {
		const state = store.add(new ParadisBrowserScopeState(JSON.stringify({
			version: 1,
			entries: [{ viewId: 'view-a', stateKey: 'space-a' }],
		})));
		const events: unknown[] = [];
		store.add(state.onDidChangeStableScope(event => events.push(event)));
		assert.deepStrictEqual(state.resolveScope('view-a'), { kind: 'managed', stateKey: 'space-a' });

		state.tagManaged('view-a', 'space-b', 'reassign');
		assert.deepStrictEqual(state.resolveScope('view-a'), { kind: 'managed', stateKey: 'space-b' });
		assert.deepStrictEqual(events, [{
			viewId: 'view-a',
			previousScope: { kind: 'managed', stateKey: 'space-a' },
			scope: { kind: 'managed', stateKey: 'space-b' },
			revision: 1,
			reason: 'reassign',
		}]);

		assert.deepStrictEqual(state.retireScope('space-b'), ['view-a']);
		assert.strictEqual(state.isRetiredBeforeInitialization('view-a'), true);
		assert.deepStrictEqual(events[1], {
			viewId: 'view-a',
			previousScope: { kind: 'managed', stateKey: 'space-b' },
			scope: undefined,
			revision: 2,
			reason: 'scopeRetire',
		});
	});

	test('deletes persisted mapping on user close without emitting a scope reassignment', () => {
		const state = store.add(new ParadisBrowserScopeState(JSON.stringify({
			version: 1,
			entries: [{ viewId: 'view-a', stateKey: 'space-a' }],
		})));
		let eventCount = 0;
		store.add(state.onDidChangeStableScope(() => eventCount++));
		assert.strictEqual(state.deleteForUserClose('view-a'), true);
		assert.strictEqual(eventCount, 0);
		assert.deepStrictEqual(JSON.parse(state.serialize()), { version: 1, entries: [] });
	});

	test('allows only equal stable scopes', () => {
		assert.deepStrictEqual(paradisEvaluateBindingScopeEligibility(
			{ kind: 'managed', stateKey: 'space-a' },
			{ kind: 'managed', stateKey: 'space-a' },
		), { eligible: true });
		assert.deepStrictEqual(paradisEvaluateBindingScopeEligibility(
			{ kind: 'managed', stateKey: 'space-a' },
			{ kind: 'managed', stateKey: 'space-b' },
		), { eligible: false, reason: 'differentScope' });
		assert.deepStrictEqual(paradisEvaluateBindingScopeEligibility(
			{ kind: 'unscoped' },
			{ kind: 'unscoped' },
		), { eligible: true });
		assert.deepStrictEqual(paradisEvaluateBindingScopeEligibility(
			{ kind: 'pending' },
			{ kind: 'unscoped' },
		), { eligible: false, reason: 'pending' });
		for (const reason of ['pending', 'differentScope'] as const) {
			let thrown: unknown;
			try {
				paradisRequireBindingScopeEligibility({ eligible: false, reason });
			} catch (error) {
				thrown = error;
			}
			assert.ok(thrown instanceof ParadisBindingScopeEligibilityError);
			assert.strictEqual(isParadisBindingScopeEligibilityError(thrown), true);
			assert.strictEqual(thrown.reason, reason);
			assert.match(thrown.message, /PARA_BROWSER_RETRYABLE/);
		}
		assert.strictEqual(isParadisBindingScopeEligibilityError(new Error('other')), false);
		assert.doesNotThrow(() => paradisRequireBindingScopeEligibility({ eligible: true }));
	});

	test('keeps live tombstones after a successful snapshot and clears only snapshot-absent ids', () => {
		const state = store.add(new ParadisBrowserScopeState(JSON.stringify({
			version: 1,
			entries: [
				{ viewId: 'still-live', stateKey: 'space-a' },
				{ viewId: 'snapshot-absent', stateKey: 'space-a' },
			],
		})));
		state.retireScope('space-a');
		state.completeInitialization(true, new Set(['still-live']));
		assert.strictEqual(state.isRetiredBeforeInitialization('still-live'), true);
		assert.strictEqual(state.isRetiredBeforeInitialization('snapshot-absent'), false);
		state.convergeRetiredView('still-live');
		assert.strictEqual(state.isRetiredBeforeInitialization('still-live'), false);
	});
});
