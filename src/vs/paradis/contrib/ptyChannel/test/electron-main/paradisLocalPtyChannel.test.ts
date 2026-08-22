/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// この関数の失敗は「無言のメモリ増加」か「無言のイベント消失」という最悪の形で出る。
// どちらも動かしている分には気づけないので、両方をここで固定する。

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILocalPtyService } from '../../../../../platform/terminal/common/terminal.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCreateLocalPtyChannel } from '../../electron-main/paradisLocalPtyChannel.js';

/** 実サービスの代わり。`PtyHostService` と同じ「イベントは own の列挙可能プロパティ」の形にする。 */
function createFakePtyService(store: DisposableStore): {
	service: ILocalPtyService;
	fire: (payload: unknown) => void;
	/** 誰かが購読しているか。**溜め込みが戻っていないこと**はここで見る。 */
	hasDataListeners: () => boolean;
} {
	const onProcessData = store.add(new Emitter<unknown>());
	const names = [
		'onProcessReady', 'onProcessReplay', 'onProcessOrphanQuestion', 'onDidRequestDetach',
		'onDidChangeProperty', 'onProcessExit',
		'onPtyHostExit', 'onPtyHostStart', 'onPtyHostUnresponsive', 'onPtyHostResponsive',
		'onPtyHostRequestResolveVariables',
	];
	const service: Record<string, unknown> = { onProcessData: onProcessData.event };
	for (const name of names) {
		service[name] = store.add(new Emitter<unknown>()).event;
	}
	return {
		service: service as unknown as ILocalPtyService,
		fire: payload => onProcessData.fire(payload),
		hasDataListeners: () => onProcessData.hasListeners(),
	};
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

	test('誰も聞いていない間は購読すらせず、listen すればその場から同期で届く', () => {
		const disposables = store.add(new DisposableStore());
		const { service, fire, hasDataListeners } = createFakePtyService(disposables);
		const { logService, errors } = createLogCollector();
		const channel = paradisCreateLocalPtyChannel(service, disposables, logService);

		// チャネルを作っただけでは誰も購読しない。ここが真なら、出力は main に溜まらない。
		const subscribedOnCreate = hasDataListeners();
		fire({ id: 1, event: 'nobody is listening' });

		const received: unknown[] = [];
		const listener = channel.listen('ctx', 'onProcessData')(value => received.push(value));
		const subscribedOnListen = hasDataListeners();

		// **間に `Event.buffer` を挟まないので、最初の1回もタイマーを待たずに届く。**
		fire({ id: 1, event: 'hello' });
		listener.dispose();
		fire({ id: 1, event: 'dropped after dispose' });

		assert.deepStrictEqual(
			{ subscribedOnCreate, subscribedOnListen, received, subscribedAfterDispose: hasDataListeners(), errors },
			{
				subscribedOnCreate: false,
				subscribedOnListen: true,
				// 誰も聞いていない間に出たものは溜めない。聞き始めてからの1件だけが届く。
				received: [{ id: 1, event: 'hello' }],
				subscribedAfterDispose: false,
				errors: [],
			},
		);
	});

	test('知らないイベントが増えていたら error で残す', () => {
		const disposables = store.add(new DisposableStore());
		const { service } = createFakePtyService(disposables);
		(service as unknown as Record<string, unknown>)['onSomethingNoisy'] = store.add(new Emitter<unknown>()).event;
		const { logService, errors } = createLogCollector();

		paradisCreateLocalPtyChannel(service, disposables, logService);

		assert.deepStrictEqual(
			{ errorCount: errors.length, mentionsEvent: errors.every(message => message.includes('onSomethingNoisy')) },
			{ errorCount: 1, mentionsEvent: true },
		);
	});
});
