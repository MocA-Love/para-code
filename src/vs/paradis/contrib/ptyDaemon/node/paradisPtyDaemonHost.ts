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
	IParadisPtyHost,
	IParadisPtySpawnRequest,
	IParadisPtySummary,
	IParadisPtyTitleEvent,
	PARADIS_PTY_PROTOCOL_VERSION,
} from '../common/paradisPtyProtocol.js';
import { paradisDecodeTerminalMetadata } from '../common/paradisTerminalMetadata.js';
import { IParadisPtyProcess, ParadisPtyHolder } from './paradisPtyHolder.js';

/**
 * 実際に pty を起こす人。
 *
 * 差し替えられるようにしてあるのは、**本物のシェルを起こさずに抱え方を確かめる**ため。
 */
export type ParadisPtySpawner = (request: IParadisPtySpawnRequest) => IParadisPtyProcess;

export class ParadisPtyDaemonHost extends Disposable implements IParadisPtyHost {

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

	/**
	 * いま誰が何を見ているか。
	 *
	 * **相手ごとに持つ。** ひとまとめにすると、2つのサーバーが繋いでいるときに片方が消えた
	 * 場合の扱いを誤る。全部離せば生きている側の窓が無音になり、何も離さなければ消えた側の
	 * 端末が永久に戻らない。持ち分は互いに素なので、消えた相手の分だけ離せば両方避けられる。
	 */
	private readonly viewers = new Map<string, Set<number>>();

	/** どのスペースのものか。預けられた時点でほぐしておく（{@link heldSpaces}）。 */
	private readonly spaces = new Map<number, string>();

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
		// 実際に畳むのは `perHandle`（holder 本体もその中に居る）。ここは引ける表を空にするだけ。
		this.holders.clear();
		this.viewers.clear();
		this.spaces.clear();
		super.dispose();
	}

	async hello(): Promise<IParadisPtyGreeting> {
		return { protocolVersion: PARADIS_PTY_PROTOCOL_VERSION, daemonPid: process.pid };
	}

	async list(): Promise<readonly IParadisPtySummary[]> {
		return [...this.holders.values()].map(holder => holder.summary());
	}

	async spawn(request: IParadisPtySpawnRequest): Promise<IParadisPtySummary> {
		const handle = this.nextHandle++;
		// **起こしてから入れ物を作る。** 逆にすると、起動が失敗したときに入れ物だけが誰にも
		// 畳まれずに残る。
		const pty = this.spawner(request);
		const store = new DisposableStore();
		const holder = store.add(new ParadisPtyHolder(handle, pty, request.cols, request.rows, request.metadata));
		store.add(holder.onDidChangeData(data => this._onDidChangeData.fire({ handle, data })));
		store.add(holder.onDidExit(event => this._onDidExit.fire({ handle, code: event.code, signal: event.signal })));
		store.add(holder.onDidChangeTitle(title => this._onDidChangeTitle.fire({ handle, title })));
		this.holders.set(handle, holder);
		this.perHandle.set(handle, store);
		this.spaces.set(handle, paradisDecodeTerminalMetadata(request.metadata).workspaceName);
		return holder.summary();
	}

	async attach(handle: number, viewer: string): Promise<IParadisPtyAttachment> {
		const holder = this.holders.get(handle);
		if (!holder) {
			throw new Error(`no terminal with handle ${handle}`);
		}
		let watched = this.viewers.get(viewer);
		if (!watched) {
			watched = new Set<number>();
			this.viewers.set(viewer, watched);
		}
		watched.add(handle);
		return holder.attach();
	}

	/**
	 * 見ている相手が消えた。**繋いでいた全部を離す。**
	 *
	 * これが無いと、アプリが落ちた・強制終了された・機械ごと寝たときに、常駐側は「まだ誰かが
	 * 見ている」と思い続ける。すると未確認の文字が数え上がり、誰も受け取ったと言わないので
	 * 高水位で pty が止まる。**閉じている間も走り切らせるという判断が、そこで無言で覆る。**
	 *
	 * アプリ側からの `detach` はあくまで行儀の良い場合の話で、落ちた場合には届かない。
	 * 接続が切れたこと自体を合図にしないと、この設計は成立しない。
	 */
	releaseViewers(viewer: string): void {
		const watched = this.viewers.get(viewer);
		if (!watched) {
			return;
		}
		this.viewers.delete(viewer);
		for (const handle of watched) {
			this.holders.get(handle)?.detach();
		}
	}

	async detach(handle: number): Promise<void> {
		this.forgetHandle(handle);
		this.holders.get(handle)?.detach();
	}

	/** どの相手の持ち分からも外す。 */
	private forgetHandle(handle: number): void {
		for (const watched of this.viewers.values()) {
			watched.delete(handle);
		}
	}

	async input(handle: number, data: string, binary?: boolean): Promise<void> {
		this.holders.get(handle)?.input(data, binary);
	}

	async acknowledge(handle: number, charCount: number): Promise<void> {
		this.holders.get(handle)?.acknowledge(charCount);
	}

	async resize(handle: number, cols: number, rows: number): Promise<void> {
		this.holders.get(handle)?.resize(cols, rows);
	}

	async setMetadata(handle: number, metadata: string): Promise<void> {
		if (!this.holders.has(handle)) {
			return;
		}
		this.holders.get(handle)?.setMetadata(metadata);
		this.spaces.set(handle, paradisDecodeTerminalMetadata(metadata).workspaceName);
	}

	async clearScrollback(handle: number): Promise<void> {
		this.holders.get(handle)?.clearScrollback();
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
		this.forgetHandle(handle);
		this.spaces.delete(handle);
		// holder 本体もこの中に居る。畳むのはここ1箇所。
		this.perHandle.deleteAndDispose(handle);
	}

	async setLayout(scopeId: string, layout: string): Promise<void> {
		// 空の配置は覚えない。**消す道が他に無い**ので、これが唯一の掃除口になる
		// （スペースを消しても、常駐は消えたことを知らない）。
		if (layout.length === 0) {
			this.layouts.delete(scopeId);
			return;
		}
		this.layouts.set(scopeId, layout);
	}

	async getLayout(scopeId: string): Promise<string | undefined> {
		return this.layouts.get(scopeId);
	}

	/** 何本抱えているか。常駐の寿命の判断に使う。 */
	heldCount(): number {
		return this.holders.size;
	}

	/**
	 * 抱えているものが、どのスペースのものか。
	 *
	 * **預けられた時点でほぐしておく。** 寿命は1分ごとに見るので、そのたびに預かりものを
	 * 全件 parse する必要が無い。常駐が中身を読むのはここ1点だけで、読めなくても本数は
	 * 数えられる（寿命の判断は名前ではなく本数で決まる）。
	 */
	heldSpaces(): readonly { readonly workspaceName: string }[] {
		return [...this.spaces.values()].map(workspaceName => ({ workspaceName }));
	}
}
