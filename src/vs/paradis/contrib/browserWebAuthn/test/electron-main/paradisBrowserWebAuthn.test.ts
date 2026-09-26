/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type { Event, SelectWebauthnAccountDetails, Session, WebContents, WebFrameMain } from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisWebAuthnAccountCandidates } from '../../common/paradisBrowserWebAuthn.js';
import { IParadisWebAuthnChooserRequest, paradisInstallWebAuthnAccountChooser } from '../../electron-main/paradisBrowserWebAuthn.js';

type Listener = (event: Event, details: SelectWebauthnAccountDetails, callback: (credentialId?: string | null) => void) => void;

suite('ParadisBrowserWebAuthn', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns accounts into chooser candidates', () => {
		assert.deepStrictEqual(paradisWebAuthnAccountCandidates([
			{ credentialId: 'a', displayName: 'Alice', name: 'alice@example.com' },
			{ credentialId: 'b', name: 'bob@example.com' },
			{ credentialId: 'c' },
		]), [
			{ deviceId: 'a', label: 'Alice', detail: 'alice@example.com' },
			{ deviceId: 'b', label: 'bob@example.com' },
			{ deviceId: 'c', label: 'パスキー 3' },
		]);
	});

	test('answers single accounts directly and routes multiple accounts through the chooser', () => {
		let listener: Listener | undefined;
		const session = { on: (_name: string, l: Listener) => { listener = l; } } as unknown as Pick<Session, 'on'>;
		const webContents = {} as WebContents;
		const frame = {} as WebFrameMain;
		const requests: IParadisWebAuthnChooserRequest[] = [];
		paradisInstallWebAuthnAccountChooser(session, f => f === frame ? { webContents, origin: 'https://example.com' } : undefined, request => requests.push(request));

		const answers: (string | null | undefined)[] = [];
		const fire = (accounts: SelectWebauthnAccountDetails['accounts'], targetFrame: WebFrameMain | null) => {
			let prevented = false;
			listener!({ preventDefault: () => { prevented = true; } } as Event, { relyingPartyId: 'example.com', accounts, frame: targetFrame }, id => answers.push(id));
			return prevented;
		};
		const two = [{ credentialId: 'a', name: 'alice' }, { credentialId: 'b', name: 'bob' }];

		const prevented = [
			fire([{ credentialId: 'only' }], frame),
			fire(two, null),
			fire(two, frame),
		];
		requests[0].invoke('b');
		requests[0].invoke('forged');
		requests[0].invoke(null);

		assert.deepStrictEqual({
			prevented,
			answers,
			request: { origin: requests[0].origin, deviceType: requests[0].deviceType, ids: requests[0].devices.map(device => device.deviceId), sameContents: requests[0].webContents === webContents },
		}, {
			prevented: [true, true, true],
			answers: ['only', null, 'b', null, null],
			request: { origin: 'https://example.com', deviceType: 'webauthn', ids: ['a', 'b'], sameContents: true },
		});
	});
});
