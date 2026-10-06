/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * notify.dismiss-sync.v1 の `dismiss-sync` / `dismiss-log` が、app/protocol と PC 側
 * （src/vs/.../common/paradisNotifyDismissLedger.ts）で互いに読めること。
 */

import { describe, expect, test } from 'vitest';
import { decodeNotifyControl, decodeNotifyDismissLog, encodeNotifyDismissSync } from '../src/notify.js';
import { ParadisNotifyDismissLedger, paradisDecodeNotifyDismissSync, paradisEncodeNotifyDismissLog } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisNotifyDismissLedger.js';

describe('notify dismiss-sync interop', () => {
	test('the PC reads the app cursor and the app reads the PC log', () => {
		const ledger = new ParadisNotifyDismissLedger({ newLedgerId: () => 'ledger-0001' });
		ledger.markDismissed('n1', 10, true);
		ledger.markDismissed('n2', 20, true);
		const first = paradisDecodeNotifyDismissSync(encodeNotifyDismissSync(undefined));
		const log = decodeNotifyDismissLog(paradisEncodeNotifyDismissLog(ledger.since(first?.ledger, first?.after ?? 0)));
		const next = paradisDecodeNotifyDismissSync(encodeNotifyDismissSync(log));
		expect({
			first,
			log,
			next,
			after: decodeNotifyDismissLog(paradisEncodeNotifyDismissLog(ledger.since(next?.ledger, next?.after ?? 0))),
			// 旧来の制御メッセージの読み手には、どちらも制御メッセージに見えない
			legacy: [decodeNotifyControl(encodeNotifyDismissSync(undefined)), decodeNotifyControl(paradisEncodeNotifyDismissLog(ledger.since(undefined, 0)))],
			malformed: [decodeNotifyDismissLog(new TextEncoder().encode('{"t":"dismiss-log","ledger":"x","seq":1,"ids":[]}')), decodeNotifyDismissLog(new Uint8Array([0xff]))],
		}).toEqual({
			first: { ledger: undefined, after: 0 },
			log: { ledger: 'ledger-0001', seq: 2, ids: ['n1', 'n2'] },
			next: { ledger: 'ledger-0001', after: 2 },
			after: { ledger: 'ledger-0001', seq: 2, ids: [] },
			legacy: [undefined, undefined],
			malformed: [undefined, undefined],
		});
	});
});
