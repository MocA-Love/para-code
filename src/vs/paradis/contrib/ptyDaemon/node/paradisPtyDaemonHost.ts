/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐が抱えているもの全部。凍結した面 (`paradisPtyProtocol.ts`) の実装側。
//
// **終わったターミナルをすぐ捨てない。** ここは (b)「閉じていても走り切らせる」を選んだことの
// 裏返しで、判断としては対になっている。閉じている間にビルドが走り切ったとして、その holder を
// 終了と同時に捨てると、**戻ってきた人は結果を一度も見られない**。走らせ切った意味が無くなる。
// なので終了した holder は `alive: false` のまま控えごと残し、アプリが読んで
// {@link ParadisPtyDaemonHost.release} を呼ぶまで持つ。
//
// 残したものが溜まり続けないかは、常駐そのものの寿命が受け持つ (`paradisPtyDaemonPolicy.ts` の
// 二段の待ち時間)。ここで独自に時間切れを持たない — **同じ判断を2箇所に置かない**。
//
// 知らない handle への `input` / `resize` / `ack` は黙って捨てる。アプリ側の見え方が一瞬古い
// だけのことがあり、そこで例外を投げても呼び出し側にできることが無い。一方 `attach` は投げる:
// 繋げなかったことを知らずに進むと、**空の画面を「出力が無かった」と読む**ことになる。

import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import {
	IParadisPtyAttachment,
	IParadisPtyDataEvent,
	IParadisPtyExitEvent,
	IParadisPtyGreeting,
	IParadisPtySpawnRequest,
	IParadisPtySummary,
	IParadisPtyTitleEvent,
	PARADIS_PTY_PROTOCOL_VERSION,
} from '../common/paradisPtyProtocol.js';
import { IParadisPtyProcess, ParadisPtyHolder } from './paradisPtyHolder.js';

/**
 * 実際に pty を起こす人。
 *
 * 差し替えられるようにしてあるのは、**本物のシェルを起こさずに抱え方を確かめる**ため。
 */
export type ParadisPtySpawner = (request: IParadisPtySpawnRequest) => IParadisPtyProcess;

export class ParadisPtyDaemonHost extends Disposable {

	private readonly holders = new Map<number, ParadisPtyHolder>();

	/**
	 * 1本ぶんの持ち物（holder 本体と、そこへ張った購読）。
	 *
	 * 別に持っているのは、`holders` を引く側を素直に保つため。**畳み忘れの置き場所を1つに
	 * まとめる**ほうが、片付けの手順が増えるより間違えにくい。
	 */
	private readonly perHandle = this._register(new DisposableMap<number, DisposableStore>());

	/** タブと分割の配置。常駐にとってはただの文字列で、展開はアプリ側の仕事。 */
	private readonly layouts = new Map<string, string>();

	private nextHandle = 1;

	private readonly _onDidChangeData = this._register(new Emitter<IParadisPtyDataEvent>());
	readonly onDidChangeData = this._onDidChangeData.event;

	private readonly _onDidExit = this._register(new Emitter<IParadisPtyExitEvent>());
	readonly onDidExit = this._onDidExit.event;

	private readonly _onDidChangeTitle = this._register(new Emitter<IParadisPtyTitleEvent>());
	readonly onDidChangeTitle = this._onDidChangeTitle.event;

	constructor(private readonly spawner: ParadisPtySpawner) {
		super();
	}

	override dispose(): void {
		this.holders.clear();
		super.dispose();
	}

	async hello(): Promise<IParadisPtyGreeting> {
		return { protocolVersion: PARADIS_PTY_PROTOCOL_VERSION, daemonPid: process.pid };
	}

	async list(): Promise<readonly IParadisPtySummary[]> {
		return [...this.holders.values()].map(holder => holder.summary());
	}

	async spawn(request: IParadisPtySpawnRequest): Promise<number> {
		const handle = this.nextHandle++;
		const store = new DisposableStore();
		const holder = store.add(new ParadisPtyHolder(handle, this.spawner(request), request.cols, request.rows, request.metadata));
		store.add(holder.onDidChangeData(data => this._onDidChangeData.fire({ handle, data })));
		store.add(holder.onDidExit(event => this._onDidExit.fire({ handle, code: event.code, signal: event.signal })));
		store.add(holder.onDidChangeTitle(title => this._onDidChangeTitle.fire({ handle, title })));
		this.holders.set(handle, holder);
		this.perHandle.set(handle, store);
		return handle;
	}

	async attach(handle: number): Promise<IParadisPtyAttachment> {
		const holder = this.holders.get(handle);
		if (!holder) {
			throw new Error(`no terminal with handle ${handle}`);
		}
		return holder.attach();
	}

	async detach(handle: number): Promise<void> {
		this.holders.get(handle)?.detach();
	}

	async input(handle: number, data: string): Promise<void> {
		this.holders.get(handle)?.input(data);
	}

	async acknowledge(handle: number, charCount: number): Promise<void> {
		this.holders.get(handle)?.acknowledge(charCount);
	}

	async resize(handle: number, cols: number, rows: number): Promise<void> {
		this.holders.get(handle)?.resize(cols, rows);
	}

	async setMetadata(handle: number, metadata: string): Promise<void> {
		this.holders.get(handle)?.setMetadata(metadata);
	}

	async kill(handle: number, signal?: string): Promise<void> {
		this.holders.get(handle)?.kill(signal);
	}

	/**
	 * 抱えるのをやめる。**終わったものを片付けるのはアプリ側の合図で行う**（冒頭参照）。
	 *
	 * まだ生きているものに対して呼ばれたら、殺してから外す。呼ぶ側が「もう要らない」と
	 * 言っている以上、走らせたまま行方不明にする方が悪い。
	 */
	async release(handle: number): Promise<void> {
		const holder = this.holders.get(handle);
		if (!holder) {
			return;
		}
		this.holders.delete(handle);
		// holder 本体もこの中に居る。畳むのはここ1箇所。
		this.perHandle.deleteAndDispose(handle);
	}

	async setLayout(scopeId: string, layout: string): Promise<void> {
		this.layouts.set(scopeId, layout);
	}

	async getLayout(scopeId: string): Promise<string | undefined> {
		return this.layouts.get(scopeId);
	}

	/** 何本抱えているか。常駐の寿命の判断に使う。 */
	heldCount(): number {
		return this.holders.size;
	}
}
