/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import {
	paradisDaemonHandlesTerminal,
	paradisRemoteHandlesTerminal,
} from '../../common/paradisTerminalKeepPlan.js';

/** 全組み合わせ。ウィンドウ2通り × 端末2通り × 残せるか2通り。 */
const CASES = [true, false].flatMap(windowRemote =>
	[true, false].flatMap(hasRemoteAuthority =>
		[true, false].map(shouldPersist => ({ windowRemote, hasRemoteAuthority, shouldPersist }))));

suite('ParadisTerminalKeepPlan handover', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('never lets both places claim the same terminal', () => {
		// 残すかどうかは全員の答えを OR で束ねるので、2つが同時に true になると、誰も
		// 繋ぎ直せない端末が「残す」扱いになる。ここが崩れないことが OR の前提。
		const both = CASES.filter(c =>
			paradisDaemonHandlesTerminal(c.windowRemote, c)
			&& paradisRemoteHandlesTerminal(c.windowRemote, c));
		assert.deepStrictEqual(both, []);
	});

	test('claims exactly the terminals each place can reattach to', () => {
		const claimed = CASES.map(c => ({
			...c,
			by: paradisDaemonHandlesTerminal(c.windowRemote, c) ? 'daemon'
				: paradisRemoteHandlesTerminal(c.windowRemote, c) ? 'remote'
					: 'nobody',
		}));
		assert.deepStrictEqual(claimed, [
			// 接続先のウィンドウ。ローカル端末は**誰も引き受けない**——ここが埋まっていなくて
			// 事故になった。残しても、そのウィンドウは開くとき接続先しか見ないので拾われない。
			{ windowRemote: true, hasRemoteAuthority: true, shouldPersist: true, by: 'remote' },
			{ windowRemote: true, hasRemoteAuthority: true, shouldPersist: false, by: 'nobody' },
			{ windowRemote: true, hasRemoteAuthority: false, shouldPersist: true, by: 'nobody' },
			{ windowRemote: true, hasRemoteAuthority: false, shouldPersist: false, by: 'nobody' },
			// ローカルのウィンドウ。接続先の端末はここには居ないが、居ても引き受けない。
			{ windowRemote: false, hasRemoteAuthority: true, shouldPersist: true, by: 'nobody' },
			{ windowRemote: false, hasRemoteAuthority: true, shouldPersist: false, by: 'nobody' },
			{ windowRemote: false, hasRemoteAuthority: false, shouldPersist: true, by: 'daemon' },
			{ windowRemote: false, hasRemoteAuthority: false, shouldPersist: false, by: 'nobody' },
		]);
	});
});
