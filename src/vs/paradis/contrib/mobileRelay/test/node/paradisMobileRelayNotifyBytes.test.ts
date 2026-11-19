/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileRelayService } from '../../node/paradisMobileRelayService.js';

interface INotifyBytesFixture {
	withoutNotifyDetail(bytes: Uint8Array): Uint8Array;
	stampNotifyOrigin(bytes: Uint8Array): Uint8Array;
	quietNotifyBytes(bytes: Uint8Array, reason: string): Uint8Array;
	composeNotifyVariants(bytes: Uint8Array, now: number): object | undefined;
	codexApprovalNotifyHold(bytes: Uint8Array): object | undefined;
	notifyAgentQuestion(info: { terminalId: number; agent: string; text: string; agentToken: string; owner: object; interactionId?: string }): void;
	notifyAgentAutoContinueStopped(token: string, terminalId: number, owner: object): void;
}

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function createFixture(overrides: { pcName?: string; deviceId?: string } = { pcName: 'desk', deviceId: 'pc-1' }): { service: INotifyBytesFixture; dispatched: { json: string; owner: object }[]; holdQueries: string[] } {
	const dispatched: { json: string; owner: object }[] = [];
	const holdQueries: string[] = [];
	const service = Object.assign(Object.create(ParadisMobileRelayService.prototype) as object, {
		state: { mobiles: [], ...(overrides.deviceId !== undefined ? { device: { deviceId: overrides.deviceId } } : {}) },
		pcName: overrides.pcName,
		terminalRegistry: {
			desktopState: () => ({
				terminals: [{ agentToken: 'tok-known', terminalKey: 'w1:7', windowId: 1, ws: 'w1:space', title: 'zsh' }],
				workspaces: [{ id: 'w1:space', name: 'feature-x' }],
			}),
		},
		agentChat: {
			notifyPaneContent: () => undefined,
			codexApprovalNotifyHold: (token: string) => {
				holdQueries.push(token);
				return { since: 5, waitMs: 9 };
			},
		},
		dispatchNotify: (bytes: Uint8Array, owner: object) => dispatched.push({ json: decode(bytes).replace(/"id":"([qe])[0-9a-f-]{36}"/, '"id":"$1<uuid>"').replace(/"at":\d+/, '"at":0'), owner }),
	}) as unknown as INotifyBytesFixture;
	return { service, dispatched, holdQueries };
}

suite('ParadisMobileRelayService notify bytes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('通知の JSON の書き換えは、キーの順を保ち、読めないものはそのまま返す', () => {
		const { service } = createFixture();
		const notJson = encode('not json');
		const array = encode('[1]');
		const nullJson = encode('null');
		const noDetail = encode('{"kind":"agent-done","id":"a"}');
		assert.deepStrictEqual({
			withoutDetail: decode(service.withoutNotifyDetail(encode('{"kind":"agent-done","detail":"secret","id":"a"}'))),
			withoutDetailSame: [service.withoutNotifyDetail(noDetail) === noDetail, service.withoutNotifyDetail(notJson) === notJson, service.withoutNotifyDetail(array) === array, service.withoutNotifyDetail(nullJson) === nullJson],
			stamped: decode(service.stampNotifyOrigin(encode('{"kind":"agent-done","pcId":"old","id":"a"}'))),
			stampedSame: [service.stampNotifyOrigin(notJson) === notJson, service.stampNotifyOrigin(array) === array, service.stampNotifyOrigin(nullJson) === nullJson],
			stampedNameOnly: decode(createFixture({ pcName: 'desk' }).service.stampNotifyOrigin(encode('{"id":"a"}'))),
			stampedNothingSame: createFixture({}).service.stampNotifyOrigin(noDetail) === noDetail,
			quiet: decode(service.quietNotifyBytes(encode('{"kind":"agent-done","quiet":"x","id":"a"}'), 'pc-focused')),
			quietSame: [service.quietNotifyBytes(notJson, 'pc-focused') === notJson, service.quietNotifyBytes(array, 'pc-focused') === array, service.quietNotifyBytes(nullJson, 'pc-focused') === nullJson],
		}, {
			withoutDetail: '{"kind":"agent-done","id":"a"}',
			withoutDetailSame: [true, true, true, true],
			stamped: '{"kind":"agent-done","pcId":"pc-1","id":"a","pcName":"desk"}',
			stampedSame: [true, true, true],
			stampedNameOnly: '{"id":"a","pcName":"desk"}',
			stampedNothingSame: true,
			quiet: '{"kind":"agent-done","quiet":"pc-focused","id":"a"}',
			quietSame: [true, true, true],
		});
	});

	test('通知の解析だけをする 2 つは、読めない・オブジェクトでない・対象外の種類で undefined を返す', () => {
		const { service, holdQueries } = createFixture();
		assert.deepStrictEqual({
			compose: ['not json', '[1]', 'null', '7', '{"kind":"other"}'].map(text => service.composeNotifyVariants(encode(text), 0)),
			hold: ['not json', '[1]', 'null', '7', '{"kind":"agent-done","agentToken":"t"}', '{"kind":"agent-question","category":"question","agentToken":"t"}', '{"kind":"agent-question","agentToken":""}', '{"kind":"agent-question","agentToken":"tok"}']
				.map(text => service.codexApprovalNotifyHold(encode(text))),
			holdQueries,
		}, {
			compose: [undefined, undefined, undefined, undefined, undefined],
			hold: [undefined, undefined, undefined, undefined, undefined, undefined, undefined, { token: 'tok', since: 5, waitMs: 9 }],
			holdQueries: ['tok'],
		});
	});

	test('質問と、自動の continue をやめた通知の中身とキーの順', () => {
		const { service, dispatched } = createFixture();
		const owner = { windowId: 1 };
		service.notifyAgentQuestion({ terminalId: 7, agent: 'claude', text: 'どちらにしますか', agentToken: 'tok-known', owner });
		service.notifyAgentQuestion({ terminalId: 8, agent: 'codex', text: 'x'.repeat(7000), agentToken: 'tok-unknown', owner, interactionId: 'int-1' });
		service.notifyAgentAutoContinueStopped('tok-known', 7, owner);
		service.notifyAgentAutoContinueStopped('tok-unknown', 9, owner);
		const longBody = /"body":"(?<body>x+)"/.exec(dispatched[1].json)?.groups?.body.length;
		assert.deepStrictEqual({
			json: dispatched.map(entry => entry.json.replace(/x{100,}/, '<long>')),
			sameOwner: dispatched.every(entry => entry.owner === owner),
			longBody,
		}, {
			json: [
				'{"kind":"agent-question","id":"q<uuid>","title":"feature-x","subtitle":"Claude","body":"どちらにしますか","category":"question","agent":"claude","terminalId":7,"terminalKey":"w1:7","windowId":1,"agentToken":"tok-known","ws":"w1:space","at":0}',
				'{"kind":"agent-question","id":"q<uuid>","title":"Para Code","subtitle":"Codex","body":"<long>","category":"question","agent":"codex","terminalId":8,"agentToken":"tok-unknown","interactionId":"int-1","at":0}',
				'{"kind":"agent-error","id":"e<uuid>","title":"feature-x","subtitle":"Codex","body":"","category":"error","agent":"codex","terminalId":7,"terminalKey":"w1:7","windowId":1,"agentToken":"tok-known","ws":"w1:space","at":0}',
				'{"kind":"agent-error","id":"e<uuid>","title":"Para Code","subtitle":"Codex","body":"","category":"error","agent":"codex","terminalId":9,"agentToken":"tok-unknown","at":0}',
			],
			sameOwner: true,
			longBody: 6000,
		});
	});
});
