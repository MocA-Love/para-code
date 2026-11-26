/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「人が答えるもの」の台帳のサービスとチャネル。shared process の登録口から登録する。
//
// 書き込む側（出どころの持ち主: ペインの中継、タスクボードの接続口、Bot）は shared process の中で
// {@link paradisSharedHumanAskService} を直接呼ぶ。ウィンドウ（renderer）へ出すチャネルは、読むことと
// 答えることだけを通す。ウィンドウから待ちを書き込めると、どのウィンドウでも偽の問いを全部の場所
// （のちにスマホも）へ出せてしまうため。

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import {
	IParadisHumanAskAnswerRequest,
	IParadisHumanAskEntry,
	IParadisHumanAskInput,
	IParadisHumanAskSnapshot,
	PARADIS_HUMAN_ASK_CHANNEL,
	ParadisHumanAskAnswerResult,
	ParadisHumanAskSurface,
	paradisHumanAskKey,
	paradisSanitizeHumanAskInput,
	paradisSanitizeHumanAskSummary,
	paradisSanitizeHumanAskSurface,
} from '../common/paradisHumanAsk.js';
import { ParadisHumanAskLedger } from '../common/paradisHumanAskLedger.js';

/** 連続した変更（一覧の知らせと回答が同時に来る等）をまとめてから知らせる間隔。 */
const CHANGE_DELAY = 50;

/**
 * 台帳のサービス。持ち主から来た値を検めて台帳へ入れ、変わったらスナップショットを配り、
 * 答えの依頼を持ち主へ流す。
 */
export class ParadisHumanAskService extends Disposable {

	private readonly ledger: ParadisHumanAskLedger;

	private readonly _onDidChange = this._register(new Emitter<IParadisHumanAskSnapshot>());
	/** 台帳が変わった（少しまとめてから出す）。全部のウィンドウへ配る。 */
	readonly onDidChange: Event<IParadisHumanAskSnapshot> = this._onDidChange.event;

	private readonly _onDidRequestAnswer = this._register(new Emitter<IParadisHumanAskAnswerRequest>());
	/**
	 * 答えを届けてほしい。持ち主は `owner` が自分のものだけを拾い、届けたら {@link resolve}、
	 * 届かなかったら {@link reject} を呼ぶ（決まりは ParadisHumanAskLedger のコメント）。
	 */
	readonly onDidRequestAnswer: Event<IParadisHumanAskAnswerRequest> = this._onDidRequestAnswer.event;

	private readonly changeScheduler = this._register(new RunOnceScheduler(() => this._onDidChange.fire(this.ledger.snapshot()), CHANGE_DELAY));

	constructor(ledger = new ParadisHumanAskLedger()) {
		super();
		this.ledger = ledger;
	}

	getSnapshot(): IParadisHumanAskSnapshot {
		return this.ledger.snapshot();
	}

	get(key: string): IParadisHumanAskEntry | undefined {
		return this.ledger.get(key);
	}

	// ---- 持ち主が呼ぶ ---------------------------------------------------------------------------

	/** 持ち主の待ちを丸ごと置き換える。形の合わないものは入れない（入らなかった数を返す）。 */
	sync(owner: string, values: readonly unknown[]): number {
		const inputs: IParadisHumanAskInput[] = [];
		const keys = new Set<string>();
		let refused = 0;
		for (const value of values) {
			const input = paradisSanitizeHumanAskInput(value);
			const key = input ? paradisHumanAskKey(input.source, input.id) : undefined;
			if (input === undefined || key === undefined || keys.has(key)) {
				refused++;
				continue;
			}
			keys.add(key);
			inputs.push(input);
		}
		this.changed(this.ledger.sync(owner, inputs));
		return refused;
	}

	/** 1 件を足す・書き換える。形が合わなければ false。 */
	upsert(owner: string, value: unknown): boolean {
		const input = paradisSanitizeHumanAskInput(value);
		if (input === undefined) {
			return false;
		}
		this.changed(this.ledger.upsert(owner, input));
		return true;
	}

	resolve(owner: string, key: string, resolution: { readonly surface?: ParadisHumanAskSurface; readonly summary?: string } = {}): boolean {
		const summary = paradisSanitizeHumanAskSummary(resolution.summary);
		return this.changed(this.ledger.resolve(owner, key, { ...(resolution.surface !== undefined ? { surface: resolution.surface } : {}), ...(summary !== undefined ? { summary } : {}) }));
	}

	reject(owner: string, key: string, claim: string): boolean {
		return this.changed(this.ledger.reject(owner, key, claim));
	}

	withdraw(owner: string, key: string): boolean {
		return this.changed(this.ledger.withdraw(owner, key));
	}

	removeOwner(owner: string): boolean {
		return this.changed(this.ledger.removeOwner(owner));
	}

	// ---- 答える場所が呼ぶ -----------------------------------------------------------------------

	/** 答える。押さえられたら、持ち主へ依頼を流す。 */
	answer(key: unknown, answer: unknown, surface: unknown): ParadisHumanAskAnswerResult {
		const where = paradisSanitizeHumanAskSurface(surface);
		if (typeof key !== 'string' || where === undefined) {
			return { ok: false, reason: 'invalid' };
		}
		const result = this.ledger.claim(key, answer, where);
		if (result.ok) {
			this.changed(true);
			this._onDidRequestAnswer.fire(result.request);
		}
		return result;
	}

	private changed(changed: boolean): boolean {
		if (changed) {
			this.ledger.bumpRevision();
			this.changeScheduler.schedule();
		}
		return changed;
	}
}

let shared: ParadisHumanAskService | undefined;

/**
 * shared process に 1 つだけの台帳。出どころの持ち主（のちの PR で足す取り込み役）はここから取る。
 * 登録の順番に左右されないよう、最初に呼ばれたときに作る。
 */
export function paradisSharedHumanAskService(): ParadisHumanAskService {
	shared ??= new ParadisHumanAskService();
	return shared;
}

/** ウィンドウ（renderer）へ出すチャネル。読むことと答えることだけ。答えた場所は `inbox`・`bot` に限る。 */
export class ParadisHumanAskChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisHumanAskService) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onDidChange': return this.service.onDidChange as Event<T>;
			default: throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'getSnapshot': return this.service.getSnapshot() as T;
			case 'answer': {
				// ウィンドウの画面は受信箱と Bot のページだけ。スマホ・ボード・ペインを名乗らせない
				const surface = args[2] === 'bot' ? 'bot' : 'inbox';
				const result = this.service.answer(args[0], args[1], surface);
				// 依頼の中身（答えの本文）はウィンドウへ返さない
				return (result.ok ? { ok: true } : { ok: false, reason: result.reason }) as T;
			}
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

ParadisSharedProcessContributions.register(PARADIS_HUMAN_ASK_CHANNEL, ({ server }) => {
	const service = paradisSharedHumanAskService();
	server.registerChannel(PARADIS_HUMAN_ASK_CHANNEL, new ParadisHumanAskChannel(service));
	return {
		dispose: () => {
			service.dispose();
			if (shared === service) {
				shared = undefined;
			}
		},
	};
});
