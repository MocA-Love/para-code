/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// この関数の失敗は「無言のメモリ増加」か「無言のイベント消失」という最悪の形で出るので、
// 記述子の書き換えと、書き換えた後もイベントが届くことの両方を固定しておく。

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILocalPtyService } from '../../../../../platform/terminal/common/terminal.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCreateLocalPtyChannel } from '../../electron-main/paradisLocalPtyChannel.js';

/** 実サービスの代わり。`PtyHostService` と同じ「イベントは own の列挙可能プロパティ」の形にする。 */
function createFakePtyService(): { service: ILocalPtyService; fire: (payload: unknown) => void } {
	const onProcessData = new Emitter<unknown>();
	const names = [
		'onProcessReady', 'onProcessReplay', 'onProcessOrphanQuestion', 'onDidRequestDetach',
		'onDidChangeProperty', 'onProcessExit',
		'onPtyHostExit', 'onPtyHostStart', 'onPtyHostUnresponsive', 'onPtyHostResponsive',
		'onPtyHostRequestResolveVariables',
	];
	const service: Record<string, unknown> = { onProcessData: onProcessData.event };
	for (const name of names) {
		service[name] = new Emitter<unknown>().event;
	}
	return { service: service as unknown as ILocalPtyService, fire: payload => onProcessData.fire(payload) };
}

function createLogCollector(): { logService: ILogService; errors: string[] } {
	const errors: string[] = [];
	const logService = {
		error: (message: string | Error) => errors.push(String(message)),
		warn: () => { },
	} as unknown as ILogService;
	return { logService, errors };
}

suite('paradisCreateLocalPtyChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('直結側で消費されるイベントだけを列挙から外し、ライフサイクル系は残す', () => {
		const { service } = createFakePtyService();
		const { logService, errors } = createLogCollector();

		paradisCreateLocalPtyChannel(service, store.add(new DisposableStore()), logService);

		const enumerable = Object.keys(service).sort();
		assert.deepStrictEqual({ enumerable, errors }, {
			enumerable: [
				'onPtyHostExit',
				'onPtyHostRequestResolveVariables',
				'onPtyHostResponsive',
				'onPtyHostStart',
				'onPtyHostUnresponsive',
			],
			errors: [],
		});
	});

	test('列挙から外したイベントも listen で購読でき、発火が届く', () => {
		const { service, fire } = createFakePtyService();
		const { logService } = createLogCollector();
		const channel = paradisCreateLocalPtyChannel(service, store.add(new DisposableStore()), logService);

		const received: unknown[] = [];
		const listener = channel.listen('ctx', 'onProcessData')(value => received.push(value));
		fire({ id: 1, event: 'hello' });
		listener.dispose();
		fire({ id: 1, event: 'dropped after dispose' });

		assert.deepStrictEqual(received, [{ id: 1, event: 'hello' }]);
	});

	test('想定の形でなければ何もせず、リークが戻ることを error で残す', () => {
		const { service } = createFakePtyService();
		Object.defineProperty(service, 'onProcessData', {
			value: (service as unknown as Record<string, unknown>)['onProcessData'],
			enumerable: true,
			configurable: false,
			writable: false,
		});
		const { logService, errors } = createLogCollector();

		paradisCreateLocalPtyChannel(service, store.add(new DisposableStore()), logService);

		assert.deepStrictEqual({
			stillEnumerable: Object.keys(service).includes('onProcessData'),
			errorCount: errors.length,
			mentionsEvent: errors.every(message => message.includes('onProcessData')),
		}, { stillEnumerable: true, errorCount: 2, mentionsEvent: true });
	});
});
