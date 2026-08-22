/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 配る側の性質。**購読は常駐に対して1本だけ**、というのが要点。
//
// 端末ごとに購読すると、`ProxyChannel` は常駐側にも同じ数の購読を張る。全端末の全出力が
// 本数ぶんソケットを通り、本数ぶんデコードされ、自分宛でないものは受け取ってから捨てられる。
// 出力は最も量が多く頻度も高いので、ここが効く。

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPtyDataEvent, IParadisPtyExitEvent, IParadisPtyHost, IParadisPtyTitleEvent } from '../../common/paradisPtyProtocol.js';
import { ParadisPtyDispatch } from '../../node/paradisPtyDispatch.js';

/** 常駐の代わり。**何回購読されたか**を数える。 */
function countingHost(store: DisposableStore): { host: IParadisPtyHost; subscriptions: () => number; fire: (event: IParadisPtyDataEvent) => void } {
	const data = store.add(new Emitter<IParadisPtyDataEvent>());
	const title = store.add(new Emitter<IParadisPtyTitleEvent>());
	const exit = store.add(new Emitter<IParadisPtyExitEvent>());
	let subscriptions = 0;
	const host = {
		onDidChangeData: (listener: (event: IParadisPtyDataEvent) => void) => { subscriptions++; return data.event(listener); },
		onDidChangeTitle: title.event,
		onDidExit: exit.event,
	} as unknown as IParadisPtyHost;
	return { host, subscriptions: () => subscriptions, fire: event => data.fire(event) };
}

suite('ParadisPtyDispatch', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('端末が何本あっても常駐への購読は1本。宛先ごとに配る', () => {
		const disposables = store.add(new DisposableStore());
		const { host, subscriptions, fire } = countingHost(disposables);
		const dispatch = disposables.add(new ParadisPtyDispatch(host));

		const first: string[] = [];
		const second: string[] = [];
		disposables.add(disposables.add(dispatch.listen(1)).onData(value => first.push(value)));
		disposables.add(disposables.add(dispatch.listen(2)).onData(value => second.push(value)));

		fire({ handle: 1, data: 'to first' });
		fire({ handle: 2, data: 'to second' });
		fire({ handle: 99, data: 'to nobody' });

		assert.deepStrictEqual(
			{ subscriptions: subscriptions(), first, second },
			// 端末ごとに購読すると、ここが本数ぶんに増える＝全出力が本数ぶん流れる。
			{ subscriptions: 1, first: ['to first'], second: ['to second'] },
		);
	});

	test('受け口を畳んだら以後は届かない', () => {
		const disposables = store.add(new DisposableStore());
		const { host, fire } = countingHost(disposables);
		const dispatch = disposables.add(new ParadisPtyDispatch(host));

		const received: string[] = [];
		const stream = dispatch.listen(1);
		disposables.add(stream.onData(value => received.push(value)));
		fire({ handle: 1, data: 'before' });
		stream.dispose();
		fire({ handle: 1, data: 'after' });

		// 畳み忘れると、閉じた端末あての発火先が残り続ける。
		assert.deepStrictEqual({ received }, { received: ['before'] });
	});
});
