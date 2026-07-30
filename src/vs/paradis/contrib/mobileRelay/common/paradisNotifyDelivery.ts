/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 1件のNotifyを「どの経路で送るか」「スマホでバナーを出させるか」を決める。
//
// 何を直しているのか:
// 以前は「リレーにモバイルのソケットが残っていればオンライン」とみなし、オンラインならAPNs
// プッシュを送らなかった。しかしiOSはアプリをバックグラウンドへ回したときソケットを
// half-openのまま放置する（`app/relay/src/deviceDO.ts` の acceptMobile のコメント参照）。
// PCからは繋がって見えたままなので、通知は死んだソケットへ流れて消え、プッシュも送られない。
// 「他のアプリを開いている間だけ通知が来ない」の正体がこれ。
//
// そこで判断材料をソケットの有無から **最後にモバイルから何か受け取った時刻** へ変える。
// モバイルはフォアグラウンドの間25秒おきにstate要求を送ってくる（`app/mobile/src/appState.ts`
// のハートビート）ので、それより十分長い無音が続いたソケットは信用しない。
//
// 役割分担:
// - PCは「この通知はユーザーの注意を引くべきか」を決める（種別設定・PCフォーカス）。
//   プッシュは届いた時点で表示されてしまい取り消せないので、ここはPCが決めるしかない。
// - モバイルは「いまの画面状況でバナーを出す意味があるか」だけを決める（前面かどうか、
//   そのエージェントの画面を開いていないか）。PCが知り得ない条件だけを見る。
// この線引きにより、以前オンライン経路とオフライン経路の2箇所に写しがあった種別フィルタが
// 1箇所に畳まれる。

import { NotifyKind, ParadisNotifyQuiet } from './paradisMobileProtocol.js';

/**
 * モバイルが同期してきた通知設定。未同期なら `undefined`、古い版から読んだ記録では
 * 一部のキーが欠けていることがあるため全て省略可にしてある（既定値は下記コメント参照）。
 */
export interface IParadisNotifyPrefs {
	readonly agentDone?: boolean;
	readonly agentQuestion?: boolean;
	/** PC操作中は鳴らさないか。 */
	readonly pcFocusQuiet?: boolean;
	/**
	 * 旧アプリ（`pcFocusQuiet` を知らない版）が送ってきた値。**読み取り専用**で、
	 * こちらへ書き戻してはいけない（旧いPara Codeはこのキーを「配信そのものを止める」と
	 * 解釈するため、true を残すと巻き戻し時にその挙動が復活する）。
	 */
	readonly suppressWhenPcFocused?: boolean;
}

/** 「PC操作中は鳴らさない」の実効値。未設定なら既定オン。 */
export function paradisNotifyPcFocusQuiet(prefs: IParadisNotifyPrefs | undefined): boolean {
	return prefs?.pcFocusQuiet ?? prefs?.suppressWhenPcFocused ?? true;
}

export interface IParadisNotifyDeliveryInput {
	readonly kind: NotifyKind | undefined;
	readonly prefs: IParadisNotifyPrefs | undefined;
	readonly pcFocused: boolean;
	/** E2Eセッションが確立し、現行プロトコルで話せる状態か。 */
	readonly sessionReady: boolean;
	/** 最後にこのモバイルから何か受け取ってからの経過ms。受信実績が無ければ `undefined`。 */
	readonly msSinceLastInbound: number | undefined;
}

export interface IParadisNotifyDelivery {
	/** E2Eフレームとして送るか（通知一覧のため。バナーの有無とは独立）。 */
	readonly frame: boolean;
	/** フレームに載せる「バナーを出さないでほしい」印。鳴らしてよいときは undefined。 */
	readonly quiet: ParadisNotifyQuiet | undefined;
	/** APNsプッシュを送るか。 */
	readonly push: boolean;
}

/**
 * これを超える無音が続いたソケットは「生きているように見えるだけ」とみなす。
 * モバイルのフォアグラウンドハートビートは25秒間隔なので、1回ぶんの遅れ（15秒）を足した値。
 * 2回連続で取りこぼす（50秒）と信用を落とすが、それは早い側への誤りなので許容する:
 * 前面のアプリに余計なプッシュが飛んでも、フレーム側は quiet になるので鳴るのは1回だけ。
 * 逆に長くすると、本当に凍っているアプリへの通知がその分だけ遅れる。
 */
export const PARADIS_NOTIFY_TRUST_WINDOW_MS = 40_000;

/**
 * リレーがプッシュペイロードを捨てる閾値（`app/relay/src/deviceDO.ts` の
 * `MAX_PUSH_PAYLOAD_BYTES` と同じ値。APNsの4KB制限に由来する）。
 * 超えると捨てられ、フレーム側は quiet なのでバナーが完全に消えるため、PC側で気づけるようにする。
 */
export const PARADIS_PUSH_PAYLOAD_LIMIT_BYTES = 3800;

export function paradisResolveNotifyDelivery(input: IParadisNotifyDeliveryInput): IParadisNotifyDelivery {
	const wantsBanner = paradisWantsNotifyBanner(input.kind, input.prefs, input.pcFocused);
	const trusted = input.sessionReady
		&& input.msSinceLastInbound !== undefined
		&& input.msSinceLastInbound <= PARADIS_NOTIFY_TRUST_WINDOW_MS;
	const push = wantsBanner && !trusted;
	return {
		frame: input.sessionReady,
		// 鳴らす必要が無いのか（muted）、プッシュで鳴らすから重ねるなというだけなのか（pushed）を
		// 区別して伝える。PCはプッシュが実際に届いたかを知らないので、プッシュを受け取れないと
		// 分かっている端末だけは pushed を無視して自分で鳴らせるようにするため。
		quiet: !wantsBanner ? 'muted' : push ? 'pushed' : undefined,
		push,
	};
}

/**
 * ユーザーの注意を引くべき通知か。設定が未同期・一部欠落のときは各項目を既定値で埋める。
 * `pcFocusQuiet` だけ既定がオン（=抑制する）。PCの前にいる間もスマホが鳴るのが
 * 通知過多の主因だったため、席を外している間だけ鳴る側を既定にしている。
 *
 * PCフォーカス中の抑制は「いまPCで見ているなら知らせる必要が無い」という意図なので、
 * 作業の進捗（完了・質問）にだけ効かせる。エラーや切断は席を外している前提そのものが
 * 崩れる知らせなので抑制しない。
 */
function paradisWantsNotifyBanner(kind: NotifyKind | undefined, prefs: IParadisNotifyPrefs | undefined, pcFocused: boolean): boolean {
	// 種別が読めなかったときは鳴らす側に倒す（黙って落とすより鳴りすぎる方がまし）。
	if (kind === undefined) {
		return true;
	}
	if (kind === 'agent-done' && prefs?.agentDone === false) {
		return false;
	}
	if (kind === 'agent-question' && prefs?.agentQuestion === false) {
		return false;
	}
	const focusSuppressible = kind === 'agent-done' || kind === 'agent-question';
	return !(focusSuppressible && pcFocused && paradisNotifyPcFocusQuiet(prefs));
}

/** 取り置き1件。`id` / `agentToken` は既読になった分を取り消すために持つ。 */
export interface IParadisMissedNotify {
	readonly id: string | undefined;
	readonly agentToken: string | undefined;
	readonly bytes: Uint8Array;
}

/**
 * 届いたか分からない通知のモバイルごとの取り置き。
 *
 * フレームを送っても本当に届いたかは分からない（相手が凍っていてもソケットは生きたままに
 * 見える）ので、常にここへ積み、次にセッションが確立したときへ流し直す。目的はバナーではなく
 * **通知一覧の取りこぼし防止**。バナーはプッシュ側が担当する。
 *
 * 永続化はしない（PCを再起動するほど時間が経った通知は、もう一覧に要らない）。
 */
export class ParadisMissedNotifyQueue {

	private readonly byMobile = new Map<string, IParadisMissedNotify[]>();

	constructor(private readonly limit = 20) { }

	add(mobileId: string, entry: IParadisMissedNotify): void {
		const queued = this.byMobile.get(mobileId) ?? [];
		queued.push(entry);
		// 上限を超えたら古い順に捨てる（一覧の先頭に出るのは新しいものなので）。
		while (queued.length > this.limit) {
			queued.shift();
		}
		this.byMobile.set(mobileId, queued);
	}

	/** 取り置きを取り出して空にする（流し直す直前に呼ぶ）。 */
	take(mobileId: string): readonly IParadisMissedNotify[] {
		const queued = this.byMobile.get(mobileId);
		this.byMobile.delete(mobileId);
		return queued ?? [];
	}

	/** ペアリング解除など、そのモバイルへ二度と送らないときに捨てる。 */
	forget(mobileId: string): void {
		this.byMobile.delete(mobileId);
	}

	/**
	 * 既に処理済みになった通知を全モバイルの取り置きから外す。これをしないと、PCで確認した
	 * 通知があとでスマホを開いたときに未読として蘇る。
	 * `id` は1件、`agentToken` は同じエージェントの分をまとめて取り消す（PC側でペインを
	 * 確認済みにしたときは通知のIDを持っていないため）。
	 */
	drop(match: { readonly id?: string; readonly agentToken?: string }): void {
		if (match.id === undefined && match.agentToken === undefined) {
			return;
		}
		for (const [mobileId, queued] of this.byMobile) {
			const kept = queued.filter(entry => !(
				(match.id !== undefined && entry.id === match.id)
				|| (match.agentToken !== undefined && entry.agentToken === match.agentToken)
			));
			if (kept.length === queued.length) {
				continue;
			}
			if (kept.length === 0) {
				this.byMobile.delete(mobileId);
			} else {
				this.byMobile.set(mobileId, kept);
			}
		}
	}
}
