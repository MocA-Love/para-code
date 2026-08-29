/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office ビューア4面(Word/Excel の単体・差分)が共有する「表示の見張りと観測」。
//
// 見張りの時計・いま見ている段階・文書の大きさ・開いた回数・失敗の記録は、どれも
// **4面で完全に同じ寿命**を持つ。これを各エディタに書き写すと、写し忘れが必ず出る
// (実際、最初の実装では段階を一度も更新しない面、バイト数を入力またぎで持ち越す面、
// 解き忘れる経路がそれぞれ別の面に生まれた)。まとめてここに置き、エディタ側には
// 「状態機械へどう流すか」だけを残す。

import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	ParadisOfficeFailureLatch,
	countParadisOfficeOpen,
	type IParadisOfficeFailureObservation,
	type ParadisOfficeDiagnosticEngine,
	type ParadisOfficeDiagnosticStage,
	type ParadisOfficeDiagnosticSurface,
} from './paradisOfficeDiagnostics.js';
import { ParadisOfficeRenderWatchdog, type IParadisOfficeRenderTimeoutEvent } from './paradisOfficeWatchdog.js';

export class ParadisOfficeViewerProbe extends Disposable {

	private readonly watchdog: ParadisOfficeRenderWatchdog;
	private readonly latch: ParadisOfficeFailureLatch;
	private stage: ParadisOfficeDiagnosticStage = 'source';
	private bytes = 0;
	private engine: ParadisOfficeDiagnosticEngine = 'legacy';
	private openIdentity: string | undefined;
	/** 直近に鳴った時計の経過。受理されたときだけ観測へ移す。 */
	private timedOutElapsed: number | undefined;

	/**
	 * @param onTimeout 予算内に描き終わりが来なかったときに呼ばれる。**呼ばれた側は
	 * `renderTimedOut` を状態機械へ流すだけでよい**。送信はここでは起きない(終端まで溜める)。
	 */
	constructor(
		private readonly surface: ParadisOfficeDiagnosticSurface,
		onTimeout: (generation: number) => void,
		schedule?: (handler: () => void, delay: number) => number,
		cancel?: (handle: number) => void,
		now?: () => number,
	) {
		super();
		this.latch = new ParadisOfficeFailureLatch(surface);
		this.watchdog = this._register(new ParadisOfficeRenderWatchdog(
			(event: IParadisOfficeRenderTimeoutEvent) => {
				// **ここでは記録しない。** 鳴った時計が必ず本物とは限らず(状態機械が世代違いで
				// 無視する、既に畳んだ表示の取り残し等)、無条件に記録すると次の表示の原因欄に
				// 幽霊の `timeout` が焼き付く。記録するかは受理された側が決める。
				this.timedOutElapsed = event.elapsedMilliseconds;
				onTimeout(event.generation);
			},
			schedule, cancel, now,
		));
	}

	/**
	 * 新しい表示を始める。
	 *
	 * `identity` は「利用者から見て同じものを開いているか」を表す文字列(単体ならリソース、
	 * 比較なら左右の組)。**同じ identity では母数を増やさない**: `EditorPane.setInput` は
	 * タブを行き来するたびに呼ばれるので、素朴に数えると分母だけ膨らんで失敗率が実際より
	 * 低く見える。
	 */
	beginOpen(identity: string, engine: ParadisOfficeDiagnosticEngine): void {
		// **`endOpen` と対称にすること。** 前の入力の見張りが残ったまま新しい記録を始めると、
		// 前の時計が鳴ったときに新しい表示の原因欄へ他人の観測が入る。
		this.disarm();
		this.timedOutElapsed = undefined;
		this.engine = engine;
		this.bytes = 0;
		this.stage = 'source';
		this.latch.reset();
		if (this.openIdentity !== identity) {
			this.openIdentity = identity;
			countParadisOfficeOpen(this.surface);
		}
	}

	/** 入力を離れた。次に同じものを開いたら、それは新しい1回として数える。 */
	endOpen(): void {
		this.disarm();
		this.timedOutElapsed = undefined;
		this.openIdentity = undefined;
		this.bytes = 0;
		this.latch.reset();
	}

	/**
	 * 利用者が「再試行」を押した。**同じ表示の続きなので母数は増やさない**が、記録は畳む。
	 * 畳まないと、一度送った後の再失敗が「送信済み」として無言で捨てられる。
	 */
	beginRetry(): void {
		this.timedOutElapsed = undefined;
		this.latch.reset();
	}

	/** 読み出したバイト数が判明したら渡す。予算の計算と、失敗イベントの大きさ段階に効く。 */
	setBytes(totalBytes: number): void {
		this.bytes = Math.max(0, totalBytes);
	}

	/** 読み出し・解析が返ってくるのを待ち始める。 */
	armSource(generation: number): void {
		this.stage = 'source';
		this.watchdog.armSource(generation);
	}

	/** 描き終わりの報告を待ち始める。 */
	armRender(generation: number): void {
		this.stage = 'render';
		this.watchdog.armRender(generation, this.bytes);
	}

	disarm(): void {
		this.watchdog.disarm();
	}

	/**
	 * **いま待っている世代の応答だけが見張りを解ける。**
	 * 読み直しをまたいで届いた古い応答で解くと、新しい世代が無防備になる。
	 */
	disarmFor(generation: number): void {
		if (this.watchdog.pendingGeneration === generation) {
			this.watchdog.disarm();
		}
	}

	/** 観測を記録する。送信はしない（終端まで溜める）。 */
	note(observation: IParadisOfficeFailureObservation): void {
		this.latch.note(observation);
	}

	/**
	 * 表示が確定した。**同じ入力の中でも記録を畳む。**
	 *
	 * 畳まないと、1回開いている間に「時間切れ → 作り直して成功 → 保存を拾って読み直し → 解析失敗」
	 * と進んだとき、最初の `timeout` が原因として残り続け、実際に効いた解析失敗の理由（と
	 * `safe_error_code`）が永久に出てこない。
	 */
	noteSuccess(): void {
		this.timedOutElapsed = undefined;
		this.latch.reset();
	}

	/**
	 * 状態機械が受理した時間切れを観測として記録する。**受理されたものだけ**を通すこと
	 * （無視された時計まで記録すると、原因欄が本当の理由ではなく `timeout` で埋まる）。
	 */
	noteAcceptedTimeout(): void {
		this.latch.note({
			cause: 'timeout',
			stage: this.stage,
			...(this.timedOutElapsed !== undefined ? { elapsedMilliseconds: this.timedOutElapsed } : {}),
		});
	}

	/**
	 * 溜めた観測を1件だけ送る。**利用者が失敗を目にする場所でだけ呼ぶこと。**
	 * 記録が何も無ければ何も送らない。
	 */
	reportFailure(): void {
		this.latch.report(this.engine, this.bytes);
	}

	/**
	 * 失敗を1つ記録して、その場で送る。読み出しに失敗して即座に理由を画面へ出す経路のように、
	 * 梯子を通らずに利用者が失敗を目にするところで使う。
	 */
	noteAndReport(observation: IParadisOfficeFailureObservation): void {
		this.latch.note(observation);
		this.latch.report(this.engine, this.bytes);
	}

	override dispose(): void {
		this.disarm();
		super.dispose();
	}
}
