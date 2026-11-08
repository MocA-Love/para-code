/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisFindSimulatorAx, paradisNormalizeSimulatorAx, paradisPickSimulatorAxTarget } from '../../common/paradisSimulatorAx.js';

/** serve-sim の `axDescribe` の形（AXLabel・AXValue・AXUniqueId・role_description・type・enabled・frame・children）。 */
function node(type: string, label: string, frame: [number, number, number, number], children: unknown[] = [], extra: Record<string, unknown> = {}) {
	return { type, role_description: type.toLowerCase(), AXLabel: label, AXValue: null, AXUniqueId: null, enabled: true, frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] }, children, ...extra };
}

const TREE = [node('Application', 'Settings', [0, 0, 402, 874], [
	node('Button', 'Sign in', [20, 100, 362, 44], [node('StaticText', 'Sign in', [30, 110, 80, 20])]),
	node('TextField', 'Email', [20, 160, 362, 44], [], { AXValue: 'me@example.com', AXUniqueId: 'email' }),
	node('Button', 'Disabled', [20, 220, 362, 44], [], { enabled: false }),
	node('Cell', 'Offscreen row', [0, 900, 402, 44]),
])];

suite('Paradis simulator: accessibility tree', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes the serve-sim tree into roles and points from the screen origin', () => {
		const snapshot = paradisNormalizeSimulatorAx(TREE);
		assert.deepStrictEqual({
			screen: snapshot.screen,
			count: snapshot.count,
			children: snapshot.root.children.map(child => ({ role: child.role, label: child.label, value: child.value, identifier: child.identifier, enabled: child.enabled })),
		}, {
			screen: { width: 402, height: 874 },
			count: 6,
			children: [
				{ role: 'button', label: 'Sign in', value: '', identifier: undefined, enabled: true },
				{ role: 'field', label: 'Email', value: 'me@example.com', identifier: 'email', enabled: true },
				{ role: 'button', label: 'Disabled', value: '', identifier: undefined, enabled: false },
				{ role: 'cell', label: 'Offscreen row', value: '', identifier: undefined, enabled: true },
			],
		});
		assert.throws(() => paradisNormalizeSimulatorAx({ not: 'a tree' }));
	});

	// タップに応える要素を先に、同じなら内側の小さい要素。画面の外の行は返さない
	test('finds elements and picks the tap target', () => {
		const snapshot = paradisNormalizeSimulatorAx(TREE);
		const signIn = paradisFindSimulatorAx(snapshot, { text: 'sign in' });
		const email = paradisFindSimulatorAx(snapshot, { identifier: 'email', exact: true });
		assert.deepStrictEqual({
			signIn: { total: signIn.total, roles: signIn.matches.map(match => match.role), target: paradisPickSimulatorAxTarget(signIn.matches)?.center },
			email: email.matches.map(match => ({ label: match.label, center: match.center })),
			interactableButtons: paradisFindSimulatorAx(snapshot, { role: 'button', interactableOnly: true }).total,
			offscreen: paradisFindSimulatorAx(snapshot, { text: 'Offscreen' }).total,
			nothingAsked: paradisFindSimulatorAx(snapshot, {}).total,
		}, {
			signIn: { total: 2, roles: ['button', 'text'], target: { x: 201, y: 122 } },
			email: [{ label: 'Email', center: { x: 201, y: 182 } }],
			interactableButtons: 1,
			offscreen: 0,
			nothingAsked: 0,
		});
	});
});
