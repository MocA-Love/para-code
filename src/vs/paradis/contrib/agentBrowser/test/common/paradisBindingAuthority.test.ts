/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisBindingAuthorityManifest,
	IParadisBindingAuthorityPane,
	ParadisBindingAuthority,
	ParadisBindingAuthorityError,
	ParadisBindingAuthorityErrorReason,
	ParadisBindingAuthorityScope,
	paradisParseBindingAuthorityManifest,
} from '../../common/paradisBindingAuthority.js';

interface ITestDescriptor {
	readonly targetId: string;
}

interface ITestBindingIdentity {
	readonly generation: number;
}

type TestAuthority = ParadisBindingAuthority<string, object, ITestDescriptor, ITestBindingIdentity>;

function createAuthority(options: {
	readonly now: () => number;
	readonly createTicketId: () => string;
	readonly copyDescriptor?: (descriptor: ITestDescriptor) => ITestDescriptor;
} = {
		now: () => 0,
		createTicketId: () => 'unused',
	}): TestAuthority {
	return new ParadisBindingAuthority({
		...options,
		copyDescriptor: options.copyDescriptor ?? (descriptor => Object.freeze({ ...descriptor })),
	});
}

function manifest(
	revision: number,
	complete: boolean,
	panes: readonly { readonly token: string; readonly shellPid?: number; readonly scope: ParadisBindingAuthorityScope }[],
	browserViews: readonly { readonly viewId: string; readonly scope: ParadisBindingAuthorityScope }[],
): IParadisBindingAuthorityManifest {
	return { revision, complete, panes, browserViews };
}

function assertAuthorityError(action: () => unknown, reason: ParadisBindingAuthorityErrorReason): void {
	assert.throws(action, error => error instanceof ParadisBindingAuthorityError && error.reason === reason);
}

function getBindingStateCount(authority: TestAuthority): number {
	const bindingStates: unknown = Reflect.get(authority, 'bindingStates');
	assert.ok(bindingStates instanceof Map);
	return bindingStates.size;
}

function getBindingStateValue(authority: TestAuthority, token: string): unknown {
	const bindingStates: unknown = Reflect.get(authority, 'bindingStates');
	assert.ok(bindingStates instanceof Map);
	return bindingStates.get(token);
}

function summarizeOwnerRelease<T extends {
	readonly retiredTokens: readonly string[];
	readonly retiredViewIds: readonly string[];
	readonly bindingRetirements: readonly {
		readonly token: string;
		readonly bindingIdentity: ITestBindingIdentity | undefined;
	}[];
}>(release: T): unknown {
	return {
		...release,
		bindingRetirements: release.bindingRetirements.map(retirement => ({
			token: retirement.token,
			bindingIdentity: retirement.bindingIdentity,
		})),
	};
}

suite('ParadisBindingAuthority', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('manifest parsing', () => {
		test('strictly parses a valid manifest into an immutable owned copy', () => {
			const source = {
				revision: 1,
				complete: true,
				panes: [
					{ token: 'pidless', scope: { kind: 'unscoped' } },
					{ token: 'managed', shellPid: 42, scope: { kind: 'managed', stateKey: 'repo' } },
				],
				browserViews: [
					{ viewId: 'pending', scope: { kind: 'pending' } },
					{ viewId: 'managed-view', scope: { kind: 'managed', stateKey: 'repo' } },
				],
			};

			const parsed = paradisParseBindingAuthorityManifest(source);
			assert.deepStrictEqual(parsed, source);

			source.revision = 2;
			source.panes[0].token = 'mutated';
			source.panes[0].scope = { kind: 'managed', stateKey: 'other' };
			source.browserViews.length = 0;

			assert.deepStrictEqual(parsed, {
				revision: 1,
				complete: true,
				panes: [
					{ token: 'pidless', scope: { kind: 'unscoped' } },
					{ token: 'managed', shellPid: 42, scope: { kind: 'managed', stateKey: 'repo' } },
				],
				browserViews: [
					{ viewId: 'pending', scope: { kind: 'pending' } },
					{ viewId: 'managed-view', scope: { kind: 'managed', stateKey: 'repo' } },
				],
			});
			assert.strictEqual(Object.isFrozen(parsed), true);
			assert.strictEqual(Object.isFrozen(parsed.panes), true);
			assert.strictEqual(Object.isFrozen(parsed.panes[0]), true);
			assert.strictEqual(Object.isFrozen(parsed.panes[0].scope), true);
			assert.strictEqual(Object.isFrozen(parsed.browserViews), true);
			assert.strictEqual(Object.isFrozen(parsed.browserViews[0]), true);
			assert.strictEqual(Object.isFrozen(parsed.browserViews[0].scope), true);
		});

		test('rejects every invalid type, bound, shape, and duplicate without returning a partial manifest', () => {
			const valid = (): IParadisBindingAuthorityManifest => ({
				revision: 1,
				complete: true,
				panes: [{ token: 'token', shellPid: 1, scope: { kind: 'managed', stateKey: 'repo' } }],
				browserViews: [{ viewId: 'view', scope: { kind: 'managed', stateKey: 'repo' } }],
			});
			const invalidValues: readonly unknown[] = [
				null,
				[],
				{ ...valid(), revision: 0 },
				{ ...valid(), revision: -1 },
				{ ...valid(), revision: 1.5 },
				{ ...valid(), revision: Number.MAX_SAFE_INTEGER + 1 },
				{ ...valid(), revision: '1' },
				{ ...valid(), complete: 1 },
				{ ...valid(), complete: 'true' },
				{ ...valid(), panes: null },
				{ ...valid(), browserViews: null },
				{ ...valid(), unexpected: true },
				{ ...valid(), panes: [{ token: '', scope: { kind: 'unscoped' } }] },
				{ ...valid(), panes: [{ token: 'x'.repeat(201), scope: { kind: 'unscoped' } }] },
				{ ...valid(), panes: [{ token: 1, scope: { kind: 'unscoped' } }] },
				{ ...valid(), panes: [{ token: 'token', shellPid: 0, scope: { kind: 'unscoped' } }] },
				{ ...valid(), panes: [{ token: 'token', shellPid: 1.5, scope: { kind: 'unscoped' } }] },
				{ ...valid(), panes: [{ token: 'token', shellPid: Number.MAX_SAFE_INTEGER + 1, scope: { kind: 'unscoped' } }] },
				{ ...valid(), panes: [{ token: 'token', shellPid: '1', scope: { kind: 'unscoped' } }] },
				{ ...valid(), panes: [{ token: 'token', shellPid: undefined, scope: { kind: 'unscoped' } }] },
				{ ...valid(), panes: [{ token: 'token', scope: null }] },
				{ ...valid(), panes: [{ token: 'token', scope: { kind: 'managed', stateKey: '' } }] },
				{ ...valid(), panes: [{ token: 'token', scope: { kind: 'managed', stateKey: 'x'.repeat(4097) } }] },
				{ ...valid(), panes: [{ token: 'token', scope: { kind: 'managed', stateKey: 1 } }] },
				{ ...valid(), panes: [{ token: 'token', scope: { kind: 'managed', stateKey: 'repo', extra: true } }] },
				{ ...valid(), panes: [{ token: 'token', scope: { kind: 'unscoped', stateKey: 'repo' } }] },
				{ ...valid(), panes: [{ token: 'token', scope: { kind: 'pending', extra: true } }] },
				{ ...valid(), panes: [{ token: 'token', scope: { kind: 'other' } }] },
				{ ...valid(), panes: [{ token: 'token', scope: { kind: 'unscoped' }, extra: true }] },
				{ ...valid(), panes: [valid().panes[0], valid().panes[0]] },
				{
					...valid(),
					panes: [
						{ token: 'token-a', shellPid: 42, scope: { kind: 'unscoped' } },
						{ token: 'token-b', shellPid: 42, scope: { kind: 'unscoped' } },
					],
				},
				{ ...valid(), browserViews: [{ viewId: '', scope: { kind: 'unscoped' } }] },
				{ ...valid(), browserViews: [{ viewId: 'x'.repeat(513), scope: { kind: 'unscoped' } }] },
				{ ...valid(), browserViews: [{ viewId: 1, scope: { kind: 'unscoped' } }] },
				{ ...valid(), browserViews: [{ viewId: 'view', scope: { kind: 'unscoped' }, extra: true }] },
				{ ...valid(), browserViews: [valid().browserViews[0], valid().browserViews[0]] },
				{ ...valid(), panes: Array.from({ length: 4097 }, (_, index) => ({ token: `token-${index}`, scope: { kind: 'unscoped' } })) },
				{ ...valid(), browserViews: Array.from({ length: 4097 }, (_, index) => ({ viewId: `view-${index}`, scope: { kind: 'unscoped' } })) },
			];

			for (const invalid of invalidValues) {
				assert.throws(() => paradisParseBindingAuthorityManifest(invalid), /Invalid binding authority manifest/);
			}
		});

		test('accepts inclusive maximum field lengths and entry counts', () => {
			const parsed = paradisParseBindingAuthorityManifest({
				revision: Number.MAX_SAFE_INTEGER,
				complete: false,
				panes: Array.from({ length: 4096 }, (_, index) => ({
					token: index === 0 ? 'x'.repeat(200) : `token-${index}`,
					shellPid: index === 0 ? Number.MAX_SAFE_INTEGER : index,
					scope: { kind: 'managed', stateKey: 'x'.repeat(4096) },
				})),
				browserViews: Array.from({ length: 4096 }, (_, index) => ({
					viewId: index === 0 ? 'x'.repeat(512) : `view-${index}`,
					scope: { kind: 'unscoped' },
				})),
			});

			assert.deepStrictEqual(
				{ revision: parsed.revision, panes: parsed.panes.length, browserViews: parsed.browserViews.length },
				{ revision: Number.MAX_SAFE_INTEGER, panes: 4096, browserViews: 4096 },
			);
		});

		test('rejects hidden and symbol own keys and fails closed for hostile proxies', () => {
			const valid = (): IParadisBindingAuthorityManifest => ({
				revision: 1,
				complete: true,
				panes: [{ token: 'token', scope: { kind: 'unscoped' } }],
				browserViews: [{ viewId: 'view', scope: { kind: 'unscoped' } }],
			});
			const hidden = valid() as IParadisBindingAuthorityManifest & { hidden?: boolean };
			Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
			const symbol = valid() as IParadisBindingAuthorityManifest & { [key: symbol]: boolean };
			symbol[Symbol('unexpected')] = true;
			const hostileOwnKeys = new Proxy(valid(), {
				ownKeys: () => { throw new Error('hostile ownKeys'); },
			});
			const hostileGetter = new Proxy(valid(), {
				get: (target, property, receiver) => property === 'revision'
					? (() => { throw new Error('hostile getter'); })()
					: Reflect.get(target, property, receiver),
			});

			for (const invalid of [hidden, symbol, hostileOwnKeys, hostileGetter]) {
				assert.throws(
					() => paradisParseBindingAuthorityManifest(invalid),
					(error: unknown) => error instanceof Error && error.message === 'Invalid binding authority manifest',
				);
			}
		});

		test('snapshots each getter once so validation and the owned copy cannot diverge', () => {
			const reads = new Map<string, number>();
			const once = <T>(key: string, first: T, later: unknown): (() => unknown) => () => {
				const count = (reads.get(key) ?? 0) + 1;
				reads.set(key, count);
				return count === 1 ? first : later;
			};
			const pane = {
				get token() { return once('token', 'token', 1)(); },
				get shellPid() { return once('shellPid', 42, '42')(); },
				get scope() { return once('paneScope', { kind: 'unscoped' }, null)(); },
			};
			const source = {
				get revision() { return once('revision', 1, '1')(); },
				get complete() { return once('complete', true, 1)(); },
				get panes() { return once('panes', [pane], 'invalid')(); },
				get browserViews() { return once('browserViews', [], 'invalid')(); },
			};

			assert.deepStrictEqual(paradisParseBindingAuthorityManifest(source), {
				revision: 1,
				complete: true,
				panes: [{ token: 'token', shellPid: 42, scope: { kind: 'unscoped' } }],
				browserViews: [],
			});
			assert.deepStrictEqual(Object.fromEntries(reads), {
				revision: 1,
				complete: 1,
				panes: 1,
				browserViews: 1,
				token: 1,
				shellPid: 1,
				paneScope: 1,
			});
		});
	});

	suite('connection and owner authority', () => {
		test('uses connection object identity and requires the replacement connection first manifest', () => {
			const authority = createAuthority();
			const firstConnection = {};
			const replacementConnection = {};
			authority.registerConnection('window:1', firstConnection);
			authority.acceptManifest(firstConnection, manifest(
				1,
				true,
				[{ token: 'token', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view', scope: { kind: 'unscoped' } }],
			));

			authority.registerConnection('window:1', replacementConnection);

			assertAuthorityError(
				() => authority.acceptManifest(firstConnection, manifest(2, true, [], [])),
				'staleConnection',
			);
			assertAuthorityError(
				() => authority.capturePrepareSnapshot(firstConnection, 1, 'token', 'view'),
				'staleConnection',
			);
			assertAuthorityError(
				() => authority.capturePrepareSnapshot(replacementConnection, 1, 'token', 'view'),
				'manifestRequired',
			);

			assert.deepStrictEqual(
				authority.acceptManifest(replacementConnection, manifest(
					1,
					true,
					[{ token: 'token', scope: { kind: 'unscoped' } }],
					[{ viewId: 'view', scope: { kind: 'unscoped' } }],
				)),
				{ accepted: true, revision: 1, retiredTokens: [], retiredViewIds: [], bindingRetirements: [] },
			);
		});

		test('rejects registering one connection object to another window without changing either window state', () => {
			const ids = ['ticket-a', 'ticket-b'];
			const authority = createAuthority({ now: () => 0, createTicketId: () => ids.shift() ?? 'unexpected' });
			const connectionA = {};
			const connectionB = {};
			authority.registerConnection('window:A', connectionA);
			authority.acceptManifest(connectionA, manifest(
				1,
				true,
				[{ token: 'token-a', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view-a', scope: { kind: 'unscoped' } }],
			));
			const ticketA = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionA, 1, 'token-a', 'view-a'),
				{ targetId: 'target-a' },
			);
			authority.registerConnection('window:B', connectionB);
			authority.acceptManifest(connectionB, manifest(
				1,
				true,
				[{ token: 'token-b', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view-b', scope: { kind: 'unscoped' } }],
			));
			const ticketB = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionB, 1, 'token-b', 'view-b'),
				{ targetId: 'target-b' },
			);

			assertAuthorityError(
				() => authority.registerConnection('window:B', connectionA),
				'connectionAlreadyRegistered',
			);
			assert.deepStrictEqual(
				authority.commitTicket(connectionA, ticketA.id, { generation: 1 }).descriptor,
				{ targetId: 'target-a' },
			);
			assert.deepStrictEqual(
				authority.commitTicket(connectionB, ticketB.id, { generation: 1 }).descriptor,
				{ targetId: 'target-b' },
			);
		});

		test('a PIDless pane acquires ownership and another window cannot steal either owner', () => {
			const authority = createAuthority();
			const connectionA = {};
			const connectionB = {};
			const connectionC = {};
			authority.registerConnection('window:A', connectionA);
			authority.registerConnection('window:B', connectionB);
			authority.registerConnection('window:C', connectionC);
			authority.acceptManifest(connectionA, manifest(
				1,
				true,
				[{ token: 'owned-token', scope: { kind: 'unscoped' } }],
				[{ viewId: 'owned-view', scope: { kind: 'unscoped' } }],
			));

			assertAuthorityError(
				() => authority.acceptManifest(connectionB, manifest(
					1,
					false,
					[{ token: 'owned-token', scope: { kind: 'unscoped' } }],
					[{ viewId: 'free-view', scope: { kind: 'unscoped' } }],
				)),
				'ownerConflict',
			);
			assertAuthorityError(
				() => authority.acceptManifest(connectionB, manifest(
					1,
					true,
					[{ token: 'free-token', scope: { kind: 'unscoped' } }],
					[{ viewId: 'owned-view', scope: { kind: 'unscoped' } }],
				)),
				'ownerConflict',
			);

			assert.deepStrictEqual(
				authority.acceptManifest(connectionC, manifest(
					1,
					true,
					[{ token: 'free-token', scope: { kind: 'unscoped' } }],
					[{ viewId: 'free-view', scope: { kind: 'unscoped' } }],
				)),
				{ accepted: true, revision: 1, retiredTokens: [], retiredViewIds: [], bindingRetirements: [] },
			);
		});

		test('does not auto-promote a rejected manifest after the conflicting owner releases', () => {
			const authority = createAuthority();
			const connectionA = {};
			const connectionB = {};
			authority.registerConnection('window:A', connectionA);
			authority.registerConnection('window:B', connectionB);
			authority.acceptManifest(connectionA, manifest(
				1,
				true,
				[{ token: 'token', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view', scope: { kind: 'unscoped' } }],
			));
			assertAuthorityError(
				() => authority.acceptManifest(connectionB, manifest(
					1,
					true,
					[{ token: 'token', scope: { kind: 'unscoped' } }],
					[{ viewId: 'view', scope: { kind: 'unscoped' } }],
				)),
				'ownerConflict',
			);

			const release = authority.acceptManifest(connectionA, manifest(2, true, [], []));
			assert.deepStrictEqual(summarizeOwnerRelease(release), {
				accepted: true,
				revision: 2,
				retiredTokens: ['token'],
				retiredViewIds: ['view'],
				bindingRetirements: [{ token: 'token', bindingIdentity: undefined }],
			});
			assertAuthorityError(
				() => authority.capturePrepareSnapshot(connectionB, 1, 'token', 'view'),
				'manifestRequired',
			);

			authority.acceptManifest(connectionB, manifest(
				1,
				true,
				[{ token: 'token', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view', scope: { kind: 'unscoped' } }],
			));
			assert.strictEqual(authority.capturePrepareSnapshot(connectionB, 1, 'token', 'view').revision, 1);
		});

		test('incomplete omission retains owner locks while removing prepare eligibility', () => {
			const authority = createAuthority();
			const connectionA = {};
			const connectionB = {};
			authority.registerConnection('window:A', connectionA);
			authority.registerConnection('window:B', connectionB);
			authority.acceptManifest(connectionA, manifest(
				1,
				true,
				[{ token: 'token', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view', scope: { kind: 'unscoped' } }],
			));

			assert.deepStrictEqual(
				authority.acceptManifest(connectionA, manifest(2, false, [], [])),
				{ accepted: true, revision: 2, retiredTokens: [], retiredViewIds: [], bindingRetirements: [] },
			);
			assertAuthorityError(
				() => authority.capturePrepareSnapshot(connectionA, 2, 'token', 'view'),
				'missingEntry',
			);
			assertAuthorityError(
				() => authority.acceptManifest(connectionB, manifest(
					1,
					true,
					[{ token: 'token', scope: { kind: 'unscoped' } }],
					[{ viewId: 'view', scope: { kind: 'unscoped' } }],
				)),
				'ownerConflict',
			);
		});

		test('exposes only the exact accepted manifest and current present owned tokens', () => {
			const authority = createAuthority();
			const connectionA = {};
			const connectionB = {};
			authority.registerConnection('window:A', connectionA);
			authority.registerConnection('window:B', connectionB);
			assertAuthorityError(() => authority.getCurrentAcceptedManifest(connectionA), 'manifestRequired');

			const source = manifest(
				1,
				false,
				[
					{ token: 'pending-token', scope: { kind: 'pending' } },
					{ token: 'owned-token', scope: { kind: 'unscoped' } },
				],
				[],
			);
			authority.acceptManifest(connectionA, source);
			const accepted = authority.getCurrentAcceptedManifest(connectionA);
			assert.strictEqual(accepted, authority.getCurrentAcceptedManifest(connectionA));
			assert.strictEqual(Object.isFrozen(accepted), true);
			assert.deepStrictEqual(authority.listCurrentOwnedTokens(connectionA), ['pending-token', 'owned-token']);
			assert.strictEqual(Object.isFrozen(authority.listCurrentOwnedTokens(connectionA)), true);
			assert.strictEqual(authority.isCurrentOwnedToken(connectionA, 'pending-token'), true);
			assert.strictEqual(authority.isCurrentOwnedToken(connectionA, 'unknown-token'), false);
			assert.strictEqual(authority.isOwnedToken('owned-token'), true);
			assert.strictEqual(authority.isOwnedToken('unknown-token'), false);

			authority.acceptManifest(connectionA, manifest(2, false, [], []));
			assert.deepStrictEqual(authority.listCurrentOwnedTokens(connectionA), []);
			assert.strictEqual(authority.isCurrentOwnedToken(connectionA, 'owned-token'), false);
			assert.strictEqual(authority.isOwnedToken('owned-token'), true);
			assertAuthorityError(() => authority.listCurrentOwnedTokens(connectionB), 'manifestRequired');
		});

		test('complete omission and confirmed window destruction release locks and report retired IDs', () => {
			const authority = createAuthority();
			const connectionA = {};
			const connectionB = {};
			const connectionC = {};
			authority.registerConnection('window:A', connectionA);
			authority.registerConnection('window:B', connectionB);
			authority.registerConnection('window:C', connectionC);
			authority.acceptManifest(connectionA, manifest(
				1,
				true,
				[{ token: 'token-a', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view-a', scope: { kind: 'unscoped' } }],
			));

			const manifestRelease = authority.acceptManifest(connectionA, manifest(2, true, [], []));
			assert.deepStrictEqual(summarizeOwnerRelease(manifestRelease), {
				accepted: true,
				revision: 2,
				retiredTokens: ['token-a'],
				retiredViewIds: ['view-a'],
				bindingRetirements: [{ token: 'token-a', bindingIdentity: undefined }],
			});
			authority.acceptManifest(connectionB, manifest(
				1,
				true,
				[{ token: 'token-a', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view-a', scope: { kind: 'unscoped' } }],
			));

			const destructionRelease = authority.destroyWindow('window:B');
			assert.deepStrictEqual(summarizeOwnerRelease(destructionRelease), {
				retiredTokens: ['token-a'],
				retiredViewIds: ['view-a'],
				bindingRetirements: [{ token: 'token-a', bindingIdentity: undefined }],
			});
			assert.strictEqual(Object.isFrozen(destructionRelease), true);
			assert.strictEqual(Object.isFrozen(destructionRelease.retiredTokens), true);
			assert.strictEqual(Object.isFrozen(destructionRelease.retiredViewIds), true);
			assert.strictEqual(Object.isFrozen(destructionRelease.bindingRetirements), true);
			assert.strictEqual(Object.isFrozen(destructionRelease.bindingRetirements[0]), true);
			authority.acceptManifest(connectionC, manifest(
				1,
				true,
				[{ token: 'token-a', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view-a', scope: { kind: 'unscoped' } }],
			));
			assertAuthorityError(
				() => authority.acceptManifest(connectionB, manifest(2, true, [], [])),
				'staleConnection',
			);
		});

		test('a rejected revision leaves the previous revision and authority unchanged', () => {
			const authority = createAuthority();
			const connection = {};
			authority.registerConnection('window:1', connection);
			authority.acceptManifest(connection, manifest(
				1,
				true,
				[{ token: 'token', scope: { kind: 'managed', stateKey: 'repo' } }],
				[{ viewId: 'view', scope: { kind: 'managed', stateKey: 'repo' } }],
			));

			assertAuthorityError(
				() => authority.acceptManifest(connection, manifest(1, true, [], [])),
				'staleRevision',
			);
			assertAuthorityError(
				() => authority.acceptManifest(connection, { ...manifest(2, true, [], []), complete: 1 }),
				'invalidManifest',
			);

			const snapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');
			assert.deepStrictEqual(
				{ revision: snapshot.revision, token: snapshot.token, viewId: snapshot.viewId, scope: snapshot.scope },
				{ revision: 1, token: 'token', viewId: 'view', scope: { kind: 'managed', stateKey: 'repo' } },
			);
		});

		test('prepare rejects a revision mismatch, pending scope, and unequal stable scopes', () => {
			const authority = createAuthority();
			const connection = {};
			authority.registerConnection('window:1', connection);
			authority.acceptManifest(connection, manifest(
				1,
				true,
				[
					{ token: 'pending-token', scope: { kind: 'pending' } },
					{ token: 'unscoped-token', scope: { kind: 'unscoped' } },
					{ token: 'managed-token', scope: { kind: 'managed', stateKey: 'repo-a' } },
				],
				[
					{ viewId: 'pending-view', scope: { kind: 'pending' } },
					{ viewId: 'unscoped-view', scope: { kind: 'unscoped' } },
					{ viewId: 'managed-view', scope: { kind: 'managed', stateKey: 'repo-b' } },
				],
			));

			assertAuthorityError(
				() => authority.capturePrepareSnapshot(connection, 2, 'unscoped-token', 'unscoped-view'),
				'revisionMismatch',
			);
			assertAuthorityError(
				() => authority.capturePrepareSnapshot(connection, 1, 'pending-token', 'unscoped-view'),
				'pendingScope',
			);
			assertAuthorityError(
				() => authority.capturePrepareSnapshot(connection, 1, 'unscoped-token', 'pending-view'),
				'pendingScope',
			);
			assertAuthorityError(
				() => authority.capturePrepareSnapshot(connection, 1, 'unscoped-token', 'managed-view'),
				'scopeMismatch',
			);
			assertAuthorityError(
				() => authority.capturePrepareSnapshot(connection, 1, 'managed-token', 'managed-view'),
				'scopeMismatch',
			);
		});
	});

	test('owner lifecycle leases survive incomplete recovery but reject retirement and token ABA', () => {
		const authority = createAuthority();
		const connectionA = {};
		const connectionB = {};
		authority.registerConnection('window-a', connectionA);
		authority.registerConnection('window-b', connectionB);
		authority.acceptManifest(connectionA, manifest(1, false, [{ token: 'token-a', scope: { kind: 'unscoped' } }], []));
		const firstLease = authority.captureOwnedTokenLease('token-a');
		assert.ok(firstLease);
		assert.strictEqual(authority.isOwnedTokenLeaseCurrent(firstLease), true);

		authority.acceptManifest(connectionA, manifest(2, false, [], []));
		assert.strictEqual(authority.isOwnedTokenLeaseCurrent(firstLease), true);
		assert.strictEqual(authority.captureOwnedTokenLease('token-a'), firstLease);

		authority.acceptManifest(connectionA, manifest(3, true, [], []));
		assert.strictEqual(authority.isOwnedTokenLeaseCurrent(firstLease), false);
		assert.strictEqual(authority.captureOwnedTokenLease('token-a'), undefined);

		authority.acceptManifest(connectionB, manifest(1, true, [{ token: 'token-a', scope: { kind: 'unscoped' } }], []));
		const secondLease = authority.captureOwnedTokenLease('token-a');
		assert.ok(secondLease);
		assert.notStrictEqual(secondLease, firstLease);
		assert.strictEqual(authority.isOwnedTokenLeaseCurrent(firstLease), false);
		assert.strictEqual(authority.isOwnedTokenLeaseCurrent(secondLease), true);
		authority.destroyWindow('window-b');
		assert.strictEqual(authority.isOwnedTokenLeaseCurrent(secondLease), false);
	});

	suite('prepare tickets and commit authority', () => {
		function registerReadyConnection(authority: TestAuthority, connection: object, window = 'window:1'): void {
			authority.registerConnection(window, connection);
			authority.acceptManifest(connection, manifest(
				1,
				true,
				[{ token: 'token', scope: { kind: 'managed', stateKey: 'repo' } }],
				[{ viewId: 'view', scope: { kind: 'managed', stateKey: 'repo' } }],
			));
		}

		test('await-time connection, manifest, scope, owner, and binding changes invalidate snapshots', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const firstConnection = {};
			registerReadyConnection(authority, firstConnection);

			const revisionSnapshot = authority.capturePrepareSnapshot(firstConnection, 1, 'token', 'view');
			authority.acceptManifest(firstConnection, manifest(
				2,
				true,
				[{ token: 'token', scope: { kind: 'managed', stateKey: 'other-repo' } }],
				[{ viewId: 'view', scope: { kind: 'managed', stateKey: 'other-repo' } }],
			));
			assertAuthorityError(
				() => authority.issueTicket(revisionSnapshot, { targetId: 'target' }),
				'staleSnapshot',
			);

			const connectionSnapshot = authority.capturePrepareSnapshot(firstConnection, 2, 'token', 'view');
			const replacementConnection = {};
			authority.registerConnection('window:1', replacementConnection);
			authority.acceptManifest(replacementConnection, manifest(
				1,
				true,
				[{ token: 'token', scope: { kind: 'managed', stateKey: 'other-repo' } }],
				[{ viewId: 'view', scope: { kind: 'managed', stateKey: 'other-repo' } }],
			));
			assertAuthorityError(
				() => authority.issueTicket(connectionSnapshot, { targetId: 'target' }),
				'staleSnapshot',
			);

			const bindingSnapshot = authority.capturePrepareSnapshot(replacementConnection, 1, 'token', 'view');
			authority.recordBindingMutation('token', { generation: 1 });
			assertAuthorityError(
				() => authority.issueTicket(bindingSnapshot, { targetId: 'target' }),
				'staleSnapshot',
			);

			const ownerSnapshot = authority.capturePrepareSnapshot(replacementConnection, 1, 'token', 'view');
			authority.acceptManifest(replacementConnection, manifest(2, true, [], []));
			const otherConnection = {};
			registerReadyConnection(authority, otherConnection, 'window:2');
			assertAuthorityError(
				() => authority.issueTicket(ownerSnapshot, { targetId: 'target' }),
				'staleSnapshot',
			);
		});

		test('the first parallel ticket commit wins in reverse order and invalidates siblings and replay', () => {
			const ids = ['first', 'second'];
			const authority = createAuthority({ now: () => 0, createTicketId: () => ids.shift() ?? 'unexpected' });
			const connection = {};
			registerReadyConnection(authority, connection);
			const snapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');
			const first = authority.issueTicket(snapshot, { targetId: 'target-1' });
			const second = authority.issueTicket(snapshot, { targetId: 'target-2' });

			assert.deepStrictEqual(
				authority.commitTicket(connection, second.id, { generation: 1 }),
				{
					token: 'token',
					viewId: 'view',
					descriptor: { targetId: 'target-2' },
					scope: { kind: 'managed', stateKey: 'repo' },
				},
			);
			assertAuthorityError(() => authority.commitTicket(connection, first.id, { generation: 2 }), 'invalidTicket');
			assertAuthorityError(() => authority.commitTicket(connection, second.id, { generation: 2 }), 'invalidTicket');
		});

		test('manifest and external binding mutations invalidate already issued tickets', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const connection = {};
			registerReadyConnection(authority, connection);
			const first = authority.issueTicket(
				authority.capturePrepareSnapshot(connection, 1, 'token', 'view'),
				{ targetId: 'target-1' },
			);
			authority.acceptManifest(connection, manifest(
				2,
				true,
				[{ token: 'token', scope: { kind: 'managed', stateKey: 'repo' } }],
				[{ viewId: 'view', scope: { kind: 'managed', stateKey: 'repo' } }],
			));
			assertAuthorityError(() => authority.commitTicket(connection, first.id, { generation: 1 }), 'invalidTicket');

			const second = authority.issueTicket(
				authority.capturePrepareSnapshot(connection, 2, 'token', 'view'),
				{ targetId: 'target-2' },
			);
			authority.recordBindingMutation('token', undefined);
			assertAuthorityError(() => authority.commitTicket(connection, second.id, { generation: 2 }), 'invalidTicket');
		});

		test('complete omission retains binding state until retirement completion invalidates a new owner snapshot', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const connectionA = {};
			const retiredIdentity = { generation: 7 };
			registerReadyConnection(authority, connectionA, 'window:A');
			authority.recordBindingMutation('token', retiredIdentity);
			const oldSnapshot = authority.capturePrepareSnapshot(connectionA, 1, 'token', 'view');
			const oldTicket = authority.issueTicket(oldSnapshot, { targetId: 'old-target' });

			const release = authority.acceptManifest(connectionA, manifest(2, true, [], []));
			assert.deepStrictEqual(summarizeOwnerRelease(release), {
				accepted: true,
				revision: 2,
				retiredTokens: ['token'],
				retiredViewIds: ['view'],
				bindingRetirements: [{ token: 'token', bindingIdentity: retiredIdentity }],
			});
			assert.strictEqual(Object.isFrozen(release), true);
			assert.strictEqual(Object.isFrozen(release.retiredTokens), true);
			assert.strictEqual(Object.isFrozen(release.retiredViewIds), true);
			assert.strictEqual(Object.isFrozen(release.bindingRetirements), true);
			assert.strictEqual(Object.isFrozen(release.bindingRetirements[0]), true);
			assert.deepStrictEqual(getBindingStateValue(authority, 'token'), { epoch: 1, identity: retiredIdentity });
			assertAuthorityError(() => authority.issueTicket(oldSnapshot, { targetId: 'stale-snapshot' }), 'staleSnapshot');
			assertAuthorityError(
				() => authority.commitTicket(connectionA, oldTicket.id, { generation: 8 }),
				'invalidTicket',
			);

			const connectionB = {};
			registerReadyConnection(authority, connectionB, 'window:B');
			const beforeRetirementSnapshot = authority.capturePrepareSnapshot(connectionB, 1, 'token', 'view');
			const beforeRetirementTicket = authority.issueTicket(
				beforeRetirementSnapshot,
				{ targetId: 'before-retirement' },
			);
			assert.strictEqual(authority.completeBindingRetirement(release.bindingRetirements[0]), true);
			assert.deepStrictEqual(getBindingStateValue(authority, 'token'), { epoch: 2, identity: undefined });
			assertAuthorityError(
				() => authority.issueTicket(beforeRetirementSnapshot, { targetId: 'stale-after-retirement' }),
				'staleSnapshot',
			);
			assertAuthorityError(
				() => authority.commitTicket(connectionB, beforeRetirementTicket.id, { generation: 1 }),
				'invalidTicket',
			);

			const freshTicket = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionB, 1, 'token', 'view'),
				{ targetId: 'fresh-target' },
			);
			assert.deepStrictEqual(
				authority.commitTicket(connectionB, freshTicket.id, { generation: 1 }).descriptor,
				{ targetId: 'fresh-target' },
			);
		});

		test('retirement completion deletes binding state when no owner has reacquired the token', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const connection = {};
			const retiredIdentity = { generation: 7 };
			registerReadyConnection(authority, connection);
			authority.recordBindingMutation('token', retiredIdentity);
			const oldSnapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');
			const oldTicket = authority.issueTicket(oldSnapshot, { targetId: 'old-target' });
			const release = authority.acceptManifest(connection, manifest(2, true, [], []));
			assert.strictEqual(getBindingStateCount(authority), 1);

			assert.strictEqual(authority.completeBindingRetirement(release.bindingRetirements[0]), true);
			assert.strictEqual(getBindingStateCount(authority), 0);
			assert.strictEqual(authority.completeBindingRetirement(release.bindingRetirements[0]), false);
			assert.strictEqual(getBindingStateCount(authority), 0);
			assertAuthorityError(
				() => authority.commitTicket(connection, oldTicket.id, { generation: 8 }),
				'invalidTicket',
			);
		});

		test('an older retirement cannot match after a newer retirement deletes and recreates default binding state', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const connectionA = {};
			registerReadyConnection(authority, connectionA, 'window:A');
			const releaseA = authority.acceptManifest(connectionA, manifest(2, true, [], []));

			const connectionB = {};
			registerReadyConnection(authority, connectionB, 'window:B');
			const releaseB = authority.acceptManifest(connectionB, manifest(2, true, [], []));
			assert.strictEqual(authority.completeBindingRetirement(releaseB.bindingRetirements[0]), true);
			assert.strictEqual(getBindingStateCount(authority), 0);

			const connectionC = {};
			registerReadyConnection(authority, connectionC, 'window:C');
			const preservedTicket = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionC, 1, 'token', 'view'),
				{ targetId: 'preserved' },
			);

			assert.strictEqual(authority.completeBindingRetirement(releaseA.bindingRetirements[0]), false);
			assert.strictEqual(getBindingStateCount(authority), 0);
			assert.deepStrictEqual(
				authority.commitTicket(connectionC, preservedTicket.id, { generation: 1 }).descriptor,
				{ targetId: 'preserved' },
			);
		});

		test('window destruction retains binding state until retirement completion invalidates the next owner', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const oldConnection = {};
			const retiredIdentity = { generation: 7 };
			registerReadyConnection(authority, oldConnection, 'window:A');
			authority.recordBindingMutation('token', retiredIdentity);
			const oldSnapshot = authority.capturePrepareSnapshot(oldConnection, 1, 'token', 'view');
			const oldTicket = authority.issueTicket(oldSnapshot, { targetId: 'old-target' });

			const release = authority.destroyWindow('window:A');
			assert.deepStrictEqual(summarizeOwnerRelease(release), {
				retiredTokens: ['token'],
				retiredViewIds: ['view'],
				bindingRetirements: [{ token: 'token', bindingIdentity: retiredIdentity }],
			});
			assert.deepStrictEqual(getBindingStateValue(authority, 'token'), { epoch: 1, identity: retiredIdentity });
			assertAuthorityError(
				() => authority.commitTicket(oldConnection, oldTicket.id, { generation: 8 }),
				'staleConnection',
			);

			const newConnection = {};
			registerReadyConnection(authority, newConnection, 'window:B');
			assertAuthorityError(() => authority.issueTicket(oldSnapshot, { targetId: 'stale-snapshot' }), 'staleSnapshot');
			const beforeRetirementSnapshot = authority.capturePrepareSnapshot(newConnection, 1, 'token', 'view');
			const beforeRetirementTicket = authority.issueTicket(
				beforeRetirementSnapshot,
				{ targetId: 'before-retirement' },
			);
			assert.strictEqual(authority.completeBindingRetirement(release.bindingRetirements[0]), true);
			assertAuthorityError(
				() => authority.commitTicket(newConnection, beforeRetirementTicket.id, { generation: 1 }),
				'invalidTicket',
			);
			const freshTicket = authority.issueTicket(
				authority.capturePrepareSnapshot(newConnection, 1, 'token', 'view'),
				{ targetId: 'new-target' },
			);
			assert.deepStrictEqual(
				authority.commitTicket(newConnection, freshTicket.id, { generation: 1 }).descriptor,
				{ targetId: 'new-target' },
			);
		});

		test('complete retirement clears binding state for the maximum manifest token set', () => {
			const authority = createAuthority();
			const connection = {};
			const panes = Array.from({ length: 4096 }, (_, index): IParadisBindingAuthorityPane => ({
				token: `token-${index}`,
				scope: { kind: 'unscoped' },
			}));
			authority.registerConnection('window:1', connection);
			authority.acceptManifest(connection, manifest(1, true, panes, []));
			const identities = panes.map((): ITestBindingIdentity => ({ generation: 1 }));
			for (let index = 0; index < panes.length; index++) {
				authority.recordBindingMutation(panes[index].token, identities[index]);
			}
			assert.strictEqual(getBindingStateCount(authority), 4096);

			const release = authority.acceptManifest(connection, manifest(2, true, [], []));
			assert.strictEqual(getBindingStateCount(authority), 4096);
			assert.strictEqual(release.bindingRetirements.length, 4096);
			for (const retirement of release.bindingRetirements) {
				assert.strictEqual(authority.completeBindingRetirement(retirement), true);
			}
			assert.strictEqual(getBindingStateCount(authority), 0);
		});

		test('an ABA identity match at a different mutation epoch leaves the new binding and ticket unchanged', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const connectionA = {};
			const retiredIdentity = { generation: 1 };
			registerReadyConnection(authority, connectionA, 'window:A');
			authority.recordBindingMutation('token', retiredIdentity);
			const release = authority.acceptManifest(connectionA, manifest(2, true, [], []));

			const connectionB = {};
			registerReadyConnection(authority, connectionB, 'window:B');
			const bindingTicket = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionB, 1, 'token', 'view'),
				{ targetId: 'new-binding' },
			);
			authority.commitTicket(connectionB, bindingTicket.id, retiredIdentity);
			const preservedTicket = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionB, 1, 'token', 'view'),
				{ targetId: 'preserved' },
			);

			assert.strictEqual(authority.completeBindingRetirement(release.bindingRetirements[0]), false);
			assert.deepStrictEqual(getBindingStateValue(authority, 'token'), { epoch: 2, identity: retiredIdentity });
			assert.deepStrictEqual(
				authority.commitTicket(connectionB, preservedTicket.id, { generation: 3 }).descriptor,
				{ targetId: 'preserved' },
			);
		});

		test('forged retirement handles are rejected without changing live authority', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const connectionA = {};
			const retiredIdentity = { generation: 1 };
			registerReadyConnection(authority, connectionA, 'window:A');
			authority.recordBindingMutation('token', retiredIdentity);
			authority.acceptManifest(connectionA, manifest(2, true, [], []));

			const connectionB = {};
			registerReadyConnection(authority, connectionB, 'window:B');
			const ticket = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionB, 1, 'token', 'view'),
				{ targetId: 'preserved' },
			);
			const forged = Object.freeze({ token: 'token', bindingIdentity: retiredIdentity });

			assert.strictEqual(authority.completeBindingRetirement(forged), false);
			assert.deepStrictEqual(getBindingStateValue(authority, 'token'), { epoch: 1, identity: retiredIdentity });
			assert.deepStrictEqual(
				authority.commitTicket(connectionB, ticket.id, { generation: 2 }).descriptor,
				{ targetId: 'preserved' },
			);
		});

		test('abandon authenticates and consumes an ownerless retirement exactly once', () => {
			const authority = createAuthority();
			const connection = {};
			registerReadyConnection(authority, connection);
			const identity = { generation: 7 };
			authority.recordBindingMutation('token', identity);
			const release = authority.acceptManifest(connection, manifest(2, true, [], []));
			const retirement = release.bindingRetirements[0];

			assert.strictEqual(authority.abandonBindingRetirement(retirement), 'abandoned');
			assert.strictEqual(getBindingStateCount(authority), 0);
			assert.strictEqual(authority.abandonBindingRetirement(retirement), 'invalid');
			assert.strictEqual(authority.completeBindingRetirement(retirement), false);
			assert.strictEqual(
				authority.abandonBindingRetirement(Object.freeze({ token: 'token', bindingIdentity: identity })),
				'invalid',
			);
		});

		test('abandon reports superseded without modifying a reacquired owner or newer binding state', () => {
			const authority = createAuthority();
			const connectionA = {};
			registerReadyConnection(authority, connectionA, 'window:A');
			const identity = { generation: 1 };
			authority.recordBindingMutation('token', identity);
			const release = authority.acceptManifest(connectionA, manifest(2, true, [], []));

			const connectionB = {};
			registerReadyConnection(authority, connectionB, 'window:B');
			authority.recordBindingMutation('token', { generation: 2 });
			assert.strictEqual(authority.abandonBindingRetirement(release.bindingRetirements[0]), 'superseded');
			assert.deepStrictEqual(getBindingStateValue(authority, 'token'), { epoch: 2, identity: { generation: 2 } });
			assert.strictEqual(authority.abandonBindingRetirement(release.bindingRetirements[0]), 'invalid');
		});

		test('undefined retirement handles work for owner-reacquired and ownerless states', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const connectionA = {};
			registerReadyConnection(authority, connectionA, 'window:A');
			const releaseA = authority.acceptManifest(connectionA, manifest(2, true, [], []));

			const connectionB = {};
			registerReadyConnection(authority, connectionB, 'window:B');
			const snapshot = authority.capturePrepareSnapshot(connectionB, 1, 'token', 'view');
			const ticket = authority.issueTicket(snapshot, { targetId: 'before-retirement' });
			assert.strictEqual(authority.completeBindingRetirement(releaseA.bindingRetirements[0]), true);
			assert.deepStrictEqual(getBindingStateValue(authority, 'token'), { epoch: 1, identity: undefined });
			assertAuthorityError(() => authority.issueTicket(snapshot, { targetId: 'stale' }), 'staleSnapshot');
			assertAuthorityError(() => authority.commitTicket(connectionB, ticket.id, { generation: 1 }), 'invalidTicket');

			const releaseB = authority.acceptManifest(connectionB, manifest(2, true, [], []));
			assert.strictEqual(authority.completeBindingRetirement(releaseB.bindingRetirements[0]), true);
			assert.strictEqual(getBindingStateCount(authority), 0);
		});

		test('copy-owns the descriptor when issuing a ticket', () => {
			const authority = createAuthority({ now: () => 0, createTicketId: () => 'ticket' });
			const connection = {};
			registerReadyConnection(authority, connection);
			const descriptor = { targetId: 'original-target' };
			const ticket = authority.issueTicket(
				authority.capturePrepareSnapshot(connection, 1, 'token', 'view'),
				descriptor,
			);

			descriptor.targetId = 'mutated-target';
			const committed = authority.commitTicket(connection, ticket.id, { generation: 1 });
			assert.deepStrictEqual(committed.descriptor, { targetId: 'original-target' });
			assert.strictEqual(Object.isFrozen(committed.descriptor), true);
		});

		test('exposes an opaque commit preparation without consuming the ticket and revalidates it at commit', () => {
			const authority = createAuthority({ now: () => 0, createTicketId: () => 'ticket' });
			const connection = {};
			registerReadyConnection(authority, connection);
			const ticket = authority.issueTicket(
				authority.capturePrepareSnapshot(connection, 1, 'token', 'view'),
				{ targetId: 'target' },
			);

			const preparation = authority.prepareTicketCommit(connection, ticket.id);
			assert.deepStrictEqual(preparation, {
				token: 'token',
				viewId: 'view',
				descriptor: { targetId: 'target' },
				scope: { kind: 'managed', stateKey: 'repo' },
			});
			assert.strictEqual(Object.isFrozen(preparation), true);

			// External capacity preflight may stop here without consuming authority.
			const committed = authority.commitPreparedTicket(connection, preparation, { generation: 1 });
			assert.deepStrictEqual(committed, preparation);
			assertAuthorityError(
				() => authority.commitPreparedTicket(connection, preparation, { generation: 2 }),
				'invalidTicket',
			);
		});

		test('rejects fabricated cross-connection and stale commit preparations without touching another live ticket', () => {
			const ids = ['ticket-a', 'ticket-b'];
			const authority = createAuthority({ now: () => 0, createTicketId: () => ids.shift() ?? 'unexpected' });
			const connectionA = {};
			const connectionB = {};
			registerReadyConnection(authority, connectionA, 'window:A');
			authority.registerConnection('window:B', connectionB);
			authority.acceptManifest(connectionB, manifest(
				1,
				true,
				[{ token: 'token-b', scope: { kind: 'unscoped' } }],
				[{ viewId: 'view-b', scope: { kind: 'unscoped' } }],
			));
			const ticketA = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionA, 1, 'token', 'view'),
				{ targetId: 'target-a' },
			);
			const ticketB = authority.issueTicket(
				authority.capturePrepareSnapshot(connectionB, 1, 'token-b', 'view-b'),
				{ targetId: 'target-b' },
			);
			const preparationA = authority.prepareTicketCommit(connectionA, ticketA.id);

			assertAuthorityError(
				() => authority.commitPreparedTicket(connectionB, preparationA, { generation: 1 }),
				'invalidTicket',
			);
			assertAuthorityError(
				() => authority.commitPreparedTicket(connectionA, Object.freeze({ ...preparationA }), { generation: 1 }),
				'invalidTicket',
			);

			authority.recordBindingMutation('token', { generation: 9 });
			assertAuthorityError(
				() => authority.commitPreparedTicket(connectionA, preparationA, { generation: 1 }),
				'invalidTicket',
			);
			const preparationB = authority.prepareTicketCommit(connectionB, ticketB.id);
			assert.deepStrictEqual(
				authority.commitPreparedTicket(connectionB, preparationB, { generation: 1 }).descriptor,
				{ targetId: 'target-b' },
			);
		});

		test('a descriptor copy failure consumes no ticket ID, live slot, or tombstone record', () => {
			let idFactoryCalls = 0;
			let copyAttempts = 0;
			const authority = createAuthority({
				now: () => 0,
				createTicketId: () => `ticket-${idFactoryCalls++}`,
				copyDescriptor: descriptor => {
					if (copyAttempts++ === 0) {
						throw new Error('descriptor copy failed');
					}
					return Object.freeze({ ...descriptor });
				},
			});
			const connection = {};
			registerReadyConnection(authority, connection);
			const snapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');

			assert.throws(
				() => authority.issueTicket(snapshot, { targetId: 'failed' }),
				/descriptor copy failed/,
			);
			assert.strictEqual(idFactoryCalls, 0);
			const first = authority.issueTicket(snapshot, { targetId: 'first' });
			assert.strictEqual(first.id, 'ticket-0');
			for (let index = 1; index < 2048; index++) {
				authority.issueTicket(snapshot, { targetId: `target-${index}` });
			}
			assertAuthorityError(
				() => authority.issueTicket(snapshot, { targetId: 'overflow' }),
				'activeTicketCapacity',
			);
		});

		test('abort is idempotent, affects only the named ticket, and prevents replay', () => {
			const ids = ['first', 'second'];
			const authority = createAuthority({ now: () => 0, createTicketId: () => ids.shift() ?? 'unexpected' });
			const connection = {};
			registerReadyConnection(authority, connection);
			const snapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');
			const first = authority.issueTicket(snapshot, { targetId: 'target-1' });
			const second = authority.issueTicket(snapshot, { targetId: 'target-2' });

			authority.abortTicket(connection, first.id);
			authority.abortTicket(connection, first.id);
			assertAuthorityError(() => authority.commitTicket(connection, first.id, { generation: 1 }), 'invalidTicket');
			assert.deepStrictEqual(
				authority.commitTicket(connection, second.id, { generation: 1 }).descriptor,
				{ targetId: 'target-2' },
			);
		});

		test('a different current window cannot commit or abort another connection ticket', () => {
			const ids = ['abort-ticket', 'commit-ticket'];
			const authority = createAuthority({ now: () => 0, createTicketId: () => ids.shift() ?? 'unexpected' });
			const connectionA = {};
			const connectionB = {};
			registerReadyConnection(authority, connectionA, 'window:A');
			const snapshot = authority.capturePrepareSnapshot(connectionA, 1, 'token', 'view');
			const abortTicket = authority.issueTicket(snapshot, { targetId: 'abort-target' });
			const commitTicket = authority.issueTicket(snapshot, { targetId: 'commit-target' });
			authority.registerConnection('window:B', connectionB);
			authority.acceptManifest(connectionB, manifest(
				1,
				true,
				[{ token: 'other-token', scope: { kind: 'unscoped' } }],
				[{ viewId: 'other-view', scope: { kind: 'unscoped' } }],
			));

			assertAuthorityError(() => authority.abortTicket(connectionB, abortTicket.id), 'invalidTicket');
			assertAuthorityError(
				() => authority.commitTicket(connectionB, commitTicket.id, { generation: 1 }),
				'invalidTicket',
			);

			authority.abortTicket(connectionA, abortTicket.id);
			authority.abortTicket(connectionA, abortTicket.id);
			assertAuthorityError(
				() => authority.commitTicket(connectionA, abortTicket.id, { generation: 1 }),
				'invalidTicket',
			);
			assert.deepStrictEqual(
				authority.commitTicket(connectionA, commitTicket.id, { generation: 1 }).descriptor,
				{ targetId: 'commit-target' },
			);
		});

		test('a replaced connection cannot commit or abort after its replacement becomes current', () => {
			const ids = ['commit-ticket', 'abort-ticket'];
			const authority = createAuthority({ now: () => 0, createTicketId: () => ids.shift() ?? 'unexpected' });
			const oldConnection = {};
			registerReadyConnection(authority, oldConnection);
			const snapshot = authority.capturePrepareSnapshot(oldConnection, 1, 'token', 'view');
			const commitTicket = authority.issueTicket(snapshot, { targetId: 'commit-target' });
			const abortTicket = authority.issueTicket(snapshot, { targetId: 'abort-target' });
			const replacementConnection = {};
			authority.registerConnection('window:1', replacementConnection);
			authority.acceptManifest(replacementConnection, manifest(
				1,
				true,
				[{ token: 'token', scope: { kind: 'managed', stateKey: 'repo' } }],
				[{ viewId: 'view', scope: { kind: 'managed', stateKey: 'repo' } }],
			));

			assertAuthorityError(
				() => authority.commitTicket(oldConnection, commitTicket.id, { generation: 1 }),
				'staleConnection',
			);
			assertAuthorityError(() => authority.abortTicket(oldConnection, abortTicket.id), 'staleConnection');
			assertAuthorityError(
				() => authority.commitTicket(replacementConnection, commitTicket.id, { generation: 1 }),
				'invalidTicket',
			);
			assertAuthorityError(() => authority.abortTicket(replacementConnection, abortTicket.id), 'invalidTicket');
		});

		test('tickets expire after exactly 10,000 ms and expired IDs can be reused', () => {
			let now = 0;
			const authority = createAuthority({ now: () => now, createTicketId: () => 'same-id' });
			const connection = {};
			registerReadyConnection(authority, connection);
			const snapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');
			const ticket = authority.issueTicket(snapshot, { targetId: 'target-1' });
			assert.deepStrictEqual(ticket, { id: 'same-id', expiresAt: 10_000 });

			now = 10_000;
			assertAuthorityError(() => authority.commitTicket(connection, ticket.id, { generation: 1 }), 'expiredTicket');
			assert.deepStrictEqual(
				authority.issueTicket(snapshot, { targetId: 'target-2' }),
				{ id: 'same-id', expiresAt: 20_000 },
			);
		});

		test('enforces the 2,048 live-ticket cap without evicting a valid ticket', () => {
			let nextTicket = 0;
			const authority = createAuthority({ now: () => 0, createTicketId: () => `ticket-${nextTicket++}` });
			const connection = {};
			registerReadyConnection(authority, connection);
			const snapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');
			const tickets = Array.from({ length: 2048 }, () => authority.issueTicket(snapshot, { targetId: 'target' }));

			assertAuthorityError(
				() => authority.issueTicket(snapshot, { targetId: 'overflow' }),
				'activeTicketCapacity',
			);
			assert.deepStrictEqual(
				authority.commitTicket(connection, tickets[0].id, { generation: 1 }).descriptor,
				{ targetId: 'target' },
			);
		});

		test('ID collisions cannot overwrite live or reuse committed and aborted tombstones before expiry', () => {
			let now = 0;
			const committedAuthority = createAuthority({ now: () => now, createTicketId: () => 'same-id' });
			const committedConnection = {};
			registerReadyConnection(committedAuthority, committedConnection);
			const initialSnapshot = committedAuthority.capturePrepareSnapshot(committedConnection, 1, 'token', 'view');
			const ticket = committedAuthority.issueTicket(initialSnapshot, { targetId: 'original' });
			assertAuthorityError(
				() => committedAuthority.issueTicket(initialSnapshot, { targetId: 'collision' }),
				'ticketIdCollision',
			);
			assert.deepStrictEqual(
				committedAuthority.commitTicket(committedConnection, ticket.id, { generation: 1 }).descriptor,
				{ targetId: 'original' },
			);
			const committedSnapshot = committedAuthority.capturePrepareSnapshot(committedConnection, 1, 'token', 'view');
			assertAuthorityError(
				() => committedAuthority.issueTicket(committedSnapshot, { targetId: 'committed-reuse' }),
				'ticketIdCollision',
			);
			now = 10_000;
			assert.strictEqual(committedAuthority.issueTicket(committedSnapshot, { targetId: 'after-expiry' }).id, 'same-id');

			now = 0;
			const abortedAuthority = createAuthority({ now: () => now, createTicketId: () => 'same-id' });
			const abortedConnection = {};
			registerReadyConnection(abortedAuthority, abortedConnection);
			const abortedSnapshot = abortedAuthority.capturePrepareSnapshot(abortedConnection, 1, 'token', 'view');
			const aborted = abortedAuthority.issueTicket(abortedSnapshot, { targetId: 'aborted' });
			abortedAuthority.abortTicket(abortedConnection, aborted.id);
			assertAuthorityError(
				() => abortedAuthority.issueTicket(abortedSnapshot, { targetId: 'aborted-reuse' }),
				'ticketIdCollision',
			);
			now = 10_000;
			assert.strictEqual(abortedAuthority.issueTicket(abortedSnapshot, { targetId: 'after-expiry' }).id, 'same-id');
		});

		test('enforces the 4,096 total-record cap and cleans expired tombstones opportunistically', () => {
			let now = 0;
			let nextTicket = 0;
			const authority = createAuthority({ now: () => now, createTicketId: () => `ticket-${nextTicket++}` });
			const connection = {};
			registerReadyConnection(authority, connection);
			const snapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');

			for (let batch = 0; batch < 2; batch++) {
				const tickets = Array.from({ length: 2048 }, () => authority.issueTicket(snapshot, { targetId: 'target' }));
				for (const ticket of tickets) {
					authority.abortTicket(connection, ticket.id);
				}
			}
			assertAuthorityError(
				() => authority.issueTicket(snapshot, { targetId: 'overflow' }),
				'totalTicketCapacity',
			);

			now = 10_000;
			assert.strictEqual(authority.issueTicket(snapshot, { targetId: 'after-expiry' }).id, 'ticket-4096');
		});

		test('repeated abort, expiry, and connection replacement do not cause unbounded ticket growth', () => {
			let now = 0;
			let nextTicket = 0;
			const authority = createAuthority({ now: () => now, createTicketId: () => `ticket-${nextTicket++}` });
			let connection: object = {};
			registerReadyConnection(authority, connection);

			for (let cycle = 0; cycle < 6; cycle++) {
				const snapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');
				const tickets = Array.from({ length: 1024 }, () => authority.issueTicket(snapshot, { targetId: 'target' }));
				for (const ticket of tickets.slice(0, 512)) {
					authority.abortTicket(connection, ticket.id);
				}
				const replacement = {};
				authority.registerConnection('window:1', replacement);
				authority.acceptManifest(replacement, manifest(
					1,
					true,
					[{ token: 'token', scope: { kind: 'managed', stateKey: 'repo' } }],
					[{ viewId: 'view', scope: { kind: 'managed', stateKey: 'repo' } }],
				));
				connection = replacement;
				now += 10_000;
			}

			const finalSnapshot = authority.capturePrepareSnapshot(connection, 1, 'token', 'view');
			assert.strictEqual(authority.issueTicket(finalSnapshot, { targetId: 'final' }).id, 'ticket-6144');
		});
	});
});
