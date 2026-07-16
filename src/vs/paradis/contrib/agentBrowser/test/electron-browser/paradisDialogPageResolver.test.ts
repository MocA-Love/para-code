/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisBrowserScopeService, ParadisBindingScopeEligibilityError } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { paradisGetBindingErrorMessage, paradisGetPaneBindingAction, paradisGetPaneQuickPickState, paradisResolveDialogPage, paradisRunDialogBind } from '../../electron-browser/paradisDialogPageResolver.js';
import { resolveDialogPageModel } from '../../electron-browser/paradisDialogPageModelResolver.js';

suite('paradisResolveDialogPage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns an exact existing binding without waiting for initialization fallback', async () => {
		const barrier = new DeferredPromise<void>();
		const exact = { id: 'exact' };
		const resolved = await paradisResolveDialogPage({
			exactPageId: 'exact',
			getKnownPage: id => id === 'exact' ? exact : undefined,
			initializationBarrier: barrier.p,
			getActivePage: () => ({ id: 'active' }),
			getContextualPage: () => ({ id: 'contextual' }),
		});
		assert.strictEqual(resolved, exact);
	});

	test('waits for initialization before active and contextual fallback', async () => {
		const barrier = new DeferredPromise<void>();
		const active = { id: 'active' };
		let settled = false;
		const result = paradisResolveDialogPage({
			getKnownPage: () => undefined,
			initializationBarrier: barrier.p,
			getActivePage: () => active,
			getContextualPage: () => ({ id: 'contextual' }),
		}).then(value => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		assert.strictEqual(settled, false);
		barrier.complete();
		assert.strictEqual(await result, active);
	});

	test('captures services synchronously before waiting for browser initialization', async () => {
		const barrier = new DeferredPromise<void>();
		let accessorValid = true;
		const editorService = { activeEditor: undefined };
		const browserViewWorkbenchService = {
			getKnownBrowserViews: () => new Map(),
			getContextualBrowserViews: () => new Map(),
		};
		const browserScopeService = {
			initializationBarrier: barrier.p,
			resolveScope: () => ({ kind: 'unscoped' }),
		};
		const accessor: ServicesAccessor = {
			get: service => {
				if (!accessorValid) {
					throw new Error('service accessor expired');
				}
				if (service === IEditorService) {
					return editorService as never;
				}
				if (service === IBrowserViewWorkbenchService) {
					return browserViewWorkbenchService as never;
				}
				if (service === IParadisBrowserScopeService) {
					return browserScopeService as never;
				}
				throw new Error(`Unexpected service: ${service.toString()}`);
			}
		};

		const result = resolveDialogPageModel(accessor);
		accessorValid = false;
		barrier.complete();
		assert.strictEqual(await result, undefined);
	});

	test('rechecks exact binding after the barrier before active fallback', async () => {
		const barrier = new DeferredPromise<void>();
		const exact = { id: 'exact' };
		let available = false;
		const result = paradisResolveDialogPage({
			exactPageId: 'exact',
			getKnownPage: () => available ? exact : undefined,
			initializationBarrier: barrier.p,
			getActivePage: () => ({ id: 'active' }),
			getContextualPage: () => ({ id: 'contextual' }),
		});
		available = true;
		barrier.complete();
		assert.strictEqual(await result, exact);
	});

	test('falls back to contextual page when there is no active page', async () => {
		const contextual = { id: 'contextual' };
		assert.strictEqual(await paradisResolveDialogPage({
			getKnownPage: () => undefined,
			initializationBarrier: Promise.resolve(),
			getActivePage: () => undefined,
			getContextualPage: () => contextual,
		}), contextual);
	});

	test('rejects an outgoing active page and falls back to the stable current contextual page', async () => {
		const outgoing = { id: 'outgoing' };
		const contextual = { id: 'contextual' };
		assert.strictEqual(await paradisResolveDialogPage({
			getKnownPage: () => undefined,
			initializationBarrier: Promise.resolve(),
			getActivePage: () => outgoing,
			getContextualPage: () => contextual,
			isStableContextualPage: page => page === contextual,
		}), contextual);
	});

	test('catches dialog bind failures and reports them without rejecting', async () => {
		let error: unknown;
		assert.strictEqual(await paradisRunDialogBind(
			() => Promise.reject(new Error('bind failed')),
			value => error = value,
		), false);
		assert.ok(error instanceof Error);
	});

	test('maps typed scope errors to localized QuickPick and Dialog text without exposing internal retry strings', () => {
		const quickPickMessages = {
			pending: 'quick: syncing',
			differentScope: 'quick: different space',
			generic: (detail: string) => `quick: failed: ${detail}`,
		};
		const dialogMessages = {
			pending: 'dialog: syncing',
			differentScope: 'dialog: different space',
			generic: (detail: string) => `dialog: failed: ${detail}`,
		};
		for (const reason of ['pending', 'differentScope'] as const) {
			const error = new ParadisBindingScopeEligibilityError(reason);
			const quickPick = paradisGetBindingErrorMessage(error, quickPickMessages);
			const dialog = paradisGetBindingErrorMessage(error, dialogMessages);
			assert.strictEqual(quickPick, quickPickMessages[reason]);
			assert.strictEqual(dialog, dialogMessages[reason]);
			assert.ok(!quickPick.includes('PARA_BROWSER_RETRYABLE'));
			assert.ok(!dialog.includes('PARA_BROWSER_RETRYABLE'));
		}
		assert.strictEqual(
			paradisGetBindingErrorMessage(new Error('ipc offline'), quickPickMessages),
			'quick: failed: ipc offline',
		);
	});

	test('keeps existing ineligible bindings unbindable while blocking new/rebind actions', () => {
		assert.strictEqual(paradisGetPaneBindingAction('other-page', 'current-page', { eligible: false, reason: 'differentScope' }), 'unbind');
		assert.strictEqual(paradisGetPaneBindingAction(undefined, 'current-page', { eligible: false, reason: 'pending' }), 'disabled');
		assert.strictEqual(paradisGetPaneBindingAction(undefined, 'current-page', { eligible: true }), 'bind');
		assert.strictEqual(paradisGetPaneBindingAction('current-page', 'current-page', { eligible: false, reason: 'pending' }), 'unbind');
		assert.deepStrictEqual(paradisGetPaneQuickPickState({ eligible: false, reason: 'pending' }), { pickable: false, disabled: true });
		assert.deepStrictEqual(paradisGetPaneQuickPickState({ eligible: false, reason: 'differentScope' }), { pickable: false, disabled: true });
		assert.deepStrictEqual(paradisGetPaneQuickPickState({ eligible: true }), { pickable: true, disabled: false });
	});
});
