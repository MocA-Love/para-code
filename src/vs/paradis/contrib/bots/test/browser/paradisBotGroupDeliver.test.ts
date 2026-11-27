/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBotGroupDeliverDependencies, paradisBotGroupDeliver, paradisWaitForLoaded } from '../../browser/paradisBotGroupDeliver.js';

const HASH_A = 'a'.repeat(64);

suite('Paradis bot group deliver', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function deps(overrides: Partial<IParadisBotGroupDeliverDependencies> = {}): IParadisBotGroupDeliverDependencies {
		return {
			waitForLoaded: async () => true,
			groups: () => [{ members: ['a', 'b'] }],
			botIdByPaneHash: async hash => hash === HASH_A ? 'a' : undefined,
			...overrides,
		};
	}

	test('同じグループのメンバーへの伝言は受け箱に入れる（queued）。メンバーでない・自分宛ては断る', async () => {
		assert.deepStrictEqual({
			queued: await paradisBotGroupDeliver(deps(), HASH_A, 'b'),
			notMember: await paradisBotGroupDeliver(deps(), 'b'.repeat(64), 'b'),
			otherGroup: await paradisBotGroupDeliver(deps(), HASH_A, 'c'),
			self: await paradisBotGroupDeliver(deps(), HASH_A, 'a'),
		}, {
			queued: { kind: 'queued' },
			notMember: { kind: 'refused', reason: 'you and that bot are not in the same group, so do not send it again' },
			otherGroup: { kind: 'refused', reason: 'you and that bot are not in the same group, so do not send it again' },
			self: { kind: 'refused', reason: 'it was addressed to yourself, so do not send it again' },
		});
	});

	test('台帳を読み込む前に来た最初の伝言は、読み込みを待ってから照らす。読めなければ「同じグループでない」にしない', async () => {
		const bots = store.add(new Emitter<void>());
		const groups = store.add(new Emitter<void>());
		const botsLedger = { snapshot: { revision: 0 }, onDidChange: bots.event };
		const groupsLedger = { snapshot: { revision: 0 }, onDidChange: groups.event };
		let members: string[] = [];
		const waiting = paradisBotGroupDeliver(deps({
			waitForLoaded: () => paradisWaitForLoaded([botsLedger, groupsLedger], 1000),
			groups: () => [{ members }],
		}), HASH_A, 'b');
		botsLedger.snapshot.revision = 1;
		bots.fire();
		members = ['a', 'b'];
		groupsLedger.snapshot.revision = 1;
		groups.fire();
		const notLoaded = await paradisBotGroupDeliver(deps({ waitForLoaded: () => paradisWaitForLoaded([{ snapshot: { revision: 0 }, onDidChange: groups.event }], 1) }), HASH_A, 'b');
		assert.deepStrictEqual({ first: await waiting, notLoaded }, {
			first: { kind: 'queued' },
			notLoaded: { kind: 'refused', reason: 'Para Code in that bot\'s window has not finished loading the bot groups yet' },
		});
	});
});
