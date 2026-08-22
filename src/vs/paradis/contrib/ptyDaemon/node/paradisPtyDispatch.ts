/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐から流れてくるものを、1本の購読で受けて端末ごとに配る。
//
// **端末ごとに購読してはいけない。** `ProxyChannel` のプロキシは、イベントのプロパティに触る
// たびに新しい購読をサーバーへ張る。端末ごとに `onDidChangeData` を購読すると、常駐側の購読も
// 端末の数だけ増え、**全端末の全出力が本数ぶんソケットを通って、本数ぶんデコードされる**。
// 10本開いていれば10倍で、しかも自分宛でないものは受け取ってから捨てるだけになる。
//
// 出力は最も量が多く最も頻度が高いので、ここだけは配る側を1つに揃える。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisPtyDataEvent, IParadisPtyExitEvent, IParadisPtyHost, IParadisPtyTitleEvent } from '../common/paradisPtyProtocol.js';

/** 1本ぶんの受け口。 */
export interface IParadisPtyStream {
	readonly onData: Event<string>;
	readonly onTitle: Event<string>;
	readonly onExit: Event<number | undefined>;
}

export class ParadisPtyDispatch extends Disposable {

	private readonly data = new Map<number, Emitter<string>>();
	private readonly titles = new Map<number, Emitter<string>>();
	private readonly exits = new Map<number, Emitter<number | undefined>>();

	constructor(host: IParadisPtyHost) {
		super();
		// **購読はここで1回だけ。** 端末ごとに張ると、そのぶん常駐側の購読も増える。
		this._register(host.onDidChangeData((event: IParadisPtyDataEvent) => this.data.get(event.handle)?.fire(event.data)));
		this._register(host.onDidChangeTitle((event: IParadisPtyTitleEvent) => this.titles.get(event.handle)?.fire(event.title)));
		this._register(host.onDidExit((event: IParadisPtyExitEvent) => this.exits.get(event.handle)?.fire(event.code)));
	}

	/**
	 * この handle 宛のものを受け取る。
	 *
	 * 返す `IDisposable` を畳むと受け口が外れる。畳み忘れると、閉じた端末あての発火先が
	 * 残り続ける。
	 */
	listen(handle: number): IParadisPtyStream & IDisposable {
		const store = new DisposableStore();
		const data = store.add(new Emitter<string>());
		const title = store.add(new Emitter<string>());
		const exit = store.add(new Emitter<number | undefined>());
		this.data.set(handle, data);
		this.titles.set(handle, title);
		this.exits.set(handle, exit);
		store.add(toDisposable(() => {
			this.data.delete(handle);
			this.titles.delete(handle);
			this.exits.delete(handle);
		}));
		return { onData: data.event, onTitle: title.event, onExit: exit.event, dispose: () => store.dispose() };
	}
}
