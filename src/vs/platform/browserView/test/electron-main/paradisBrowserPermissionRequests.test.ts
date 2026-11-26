/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PermissionCategory, PermissionDecision } from '../../common/browserPermissions.js';
import { paradisAgentAllowsPermission, paradisAnswerPermissionRequest, paradisNotePermissionPrompt, paradisPermissionAllowed, paradisTakePermissionNotes } from '../../electron-main/paradisBrowserPermissionRequests.js';

const ORIGIN = 'https://example.com';

/** A waiting prompt as browserSessionPermissions.ts registers it. */
function prompt(tab: object, category: PermissionCategory, decision: () => PermissionDecision | undefined = () => undefined, origin: string = ORIGIN) {
	const deferred = new DeferredPromise<void>();
	paradisNotePermissionPrompt(tab, origin, category, 30_000, deferred.p, () => deferred.complete(), decision, 0);
	return deferred;
}

suite('paradisBrowserPermissionRequests (permission prompts seen by an agent)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a waiting prompt is told with the time left, and an allow from the agent lasts for that tab and origin only', async () => {
		const tab = {};
		const otherTab = {};
		const waiting = prompt(tab, PermissionCategory.Notifications);
		const told = paradisTakePermissionNotes(tab, 4_000);
		const before = paradisAgentAllowsPermission(tab, ORIGIN, PermissionCategory.Notifications);
		const answer = paradisAnswerPermissionRequest(tab, undefined, true, () => true);
		await waiting.p;
		assert.deepStrictEqual({
			told, before, answer, settled: waiting.isSettled,
			allowed: [
				paradisAgentAllowsPermission(tab, ORIGIN, PermissionCategory.Notifications),
				paradisAgentAllowsPermission(tab, ORIGIN, PermissionCategory.Location),
				paradisAgentAllowsPermission(tab, 'https://other.test', PermissionCategory.Notifications),
				paradisAgentAllowsPermission(otherTab, ORIGIN, PermissionCategory.Notifications),
				paradisAgentAllowsPermission(null, ORIGIN, PermissionCategory.Notifications),
			],
			// the agent's own answer is not told back to it
			after: paradisTakePermissionNotes(tab, 5_000),
		}, {
			told: [{ origin: ORIGIN, category: 'notifications', state: 'pending', secondsLeft: 26 }],
			before: false,
			answer: { ok: true, answered: [{ origin: ORIGIN, category: 'notifications' }] },
			settled: true,
			allowed: [true, false, false, false, false],
			after: [],
		});
	});

	test('a deny from the agent ends the prompt without granting, and only the user can allow what the caller may not', async () => {
		const tab = {};
		const denied = prompt(tab, PermissionCategory.Location);
		const deny = paradisAnswerPermissionRequest(tab, PermissionCategory.Location, false, () => false);
		await denied.p;
		const camera = prompt(tab, PermissionCategory.Camera);
		const refused = paradisAnswerPermissionRequest(tab, undefined, true, category => category !== PermissionCategory.Camera);
		assert.deepStrictEqual({
			deny, granted: paradisAgentAllowsPermission(tab, ORIGIN, PermissionCategory.Location),
			refused, cameraStillWaits: !camera.isSettled, cameraGranted: paradisAgentAllowsPermission(tab, ORIGIN, PermissionCategory.Camera),
		}, {
			deny: { ok: true, answered: [{ origin: ORIGIN, category: 'location' }] }, granted: false,
			refused: { ok: false, reason: 'notAllowed', pending: [{ origin: ORIGIN, category: 'camera' }] }, cameraStillWaits: true, cameraGranted: false,
		});
		camera.complete();
		await camera.p;
	});

	test('what the user recorded wins over the agent: a block recorded after the agent allowed is a deny', async () => {
		const tab = {};
		const waiting = prompt(tab, PermissionCategory.Location);
		paradisAnswerPermissionRequest(tab, undefined, true, () => true);
		await waiting.p;
		let recorded: PermissionDecision | undefined;
		// location is deny-by-default until granted
		const store = { isAllowed: () => recorded === 'allow', getDecision: () => recorded };
		const undecided = paradisPermissionAllowed(store, tab, ORIGIN, PermissionCategory.Location);
		recorded = 'deny';
		const afterUserBlock = paradisPermissionAllowed(store, tab, ORIGIN, PermissionCategory.Location);
		recorded = 'allow';
		assert.deepStrictEqual({
			undecided, afterUserBlock,
			userAllowOnAnotherTab: paradisPermissionAllowed(store, {}, ORIGIN, PermissionCategory.Location),
			agentAllowOnAnotherTab: paradisPermissionAllowed({ isAllowed: () => false, getDecision: () => undefined }, {}, ORIGIN, PermissionCategory.Location),
		}, { undecided: true, afterUserBlock: false, userAllowOnAnotherTab: true, agentAllowOnAnotherTab: false });
	});

	test('several kinds must be named, a prompt that is gone cannot be answered, and how a prompt ended is told once', async () => {
		const tab = {};
		const none = paradisAnswerPermissionRequest(tab, undefined, false, () => true);
		const location = prompt(tab, PermissionCategory.Location);
		const notifications = prompt(tab, PermissionCategory.Notifications, () => 'allow');
		const clipboard = prompt(tab, PermissionCategory.Clipboard, () => 'deny');
		const ambiguous = paradisAnswerPermissionRequest(tab, undefined, false, () => true);
		// nobody answered location (the 30 s passed), the user answered the other two in Para Code
		location.complete();
		notifications.complete();
		clipboard.complete();
		await Promise.all([location.p, notifications.p, clipboard.p]);
		const tooLate = paradisAnswerPermissionRequest(tab, PermissionCategory.Location, true, () => true);
		assert.deepStrictEqual({
			none, ambiguous: ambiguous.ok ? undefined : [ambiguous.reason, ambiguous.pending.length], tooLate,
			lateGrant: paradisAgentAllowsPermission(tab, ORIGIN, PermissionCategory.Location),
			once: paradisTakePermissionNotes(tab),
			twice: paradisTakePermissionNotes(tab),
		}, {
			none: { ok: false, reason: 'none', pending: [] },
			ambiguous: ['ambiguous', 3],
			tooLate: { ok: false, reason: 'none', pending: [] },
			lateGrant: false,
			once: [
				{ origin: ORIGIN, category: 'location', state: 'unanswered' },
				{ origin: ORIGIN, category: 'notifications', state: 'allowedByUser' },
				{ origin: ORIGIN, category: 'clipboard', state: 'deniedByUser' },
			],
			twice: [],
		});
	});
});
