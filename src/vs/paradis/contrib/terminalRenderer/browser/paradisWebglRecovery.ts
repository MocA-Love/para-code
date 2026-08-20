/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルのGPUレンダラ(WebGL)が外れたあとの扱いを決める。
//
// upstream は「1つの端末がWebGLを取れなかった」ときに、そのウィンドウのGPUレンダラを
// まとめて諦める(`XtermTerminal._suggestedRendererType = 'dom'`)。端末が数本しか開かない
// 前提なら、取れない理由は「この環境がWebGLに対応していない」しか無いので、それで正しい。
//
// Para Code はその前提から外れている。2Dグリッドは端末を並べた数だけ、エージェントの
// ライブ表示はタイルの数だけ画面を持つ。ブラウザが1つのレンダラプロセスに許すWebGLの
// コンテキストは十数個で、超えると古い順に取り上げられる(コンテキストロスト)。つまり
// ここでの失敗は「対応していない」ではなく「枠の取り合いに負けた」であることの方が多い。
// それを環境の非対応と読むと、以後そのウィンドウで作る端末が全部DOMレンダラに落ち、
// しかも設定を触るまで戻らない。取り上げられた側も、upstreamは捨てるだけで取り直さない。
//
// ここが持つのは、その2つを分けるための最小限の判断だけ。
//
// - 一度でもWebGLが立ち上がっていれば、この環境は対応している。以後の失敗で
//   ウィンドウ全体を諦めない (`ParadisWebglSupport`)
// - 取り上げられた端末は、ユーザーがそれを見ている(フォーカスした)ときに限り取り直す
//   (`ParadisWebglRecovery`)。背面のタイルまで取りに行くと、限られた枠を奪い合って
//   全員が点滅するだけになる

/** 取り直しを諦めるまでの回数。奪い合いが続く状況で無限に往復させないための上限。 */
export const PARADIS_WEBGL_MAX_RETRIES = 3;

/** 取り直しを試みる最短間隔(ミリ秒)。フォーカスが行き来するだけで再取得が走らないようにする。 */
export const PARADIS_WEBGL_RETRY_COOLDOWN = 5000;

/** {@link paradisShouldRetryWebgl} が見る状態。 */
export interface IParadisWebglRetryState {
	/** GPUレンダラが外れたままか。 */
	readonly lost: boolean;
	/** 外れてから取り直しを試みた回数。 */
	readonly attempts: number;
	/** 最後に試みた時刻。一度も試みていなければ 0。 */
	readonly lastAttemptAt: number;
}

/**
 * いま取り直してよいか。呼び出し側が「見られている」と判断した時点でだけ呼ばれる前提なので、
 * ここでは回数と間隔だけを見る。
 */
export function paradisShouldRetryWebgl(state: IParadisWebglRetryState, now: number): boolean {
	if (!state.lost || state.attempts >= PARADIS_WEBGL_MAX_RETRIES) {
		return false;
	}
	// 外れてから一度も試していないなら待たせない。見ている端末をDOMレンダラのまま置いておく
	// 理由が間隔しか無いのは本末転倒なので、時計の起点に関わらずここは回数で判断する。
	if (state.attempts === 0) {
		return true;
	}
	return now - state.lastAttemptAt >= PARADIS_WEBGL_RETRY_COOLDOWN;
}

/**
 * このレンダラプロセスでWebGLが立ち上がったことがあるか。
 *
 * ウィンドウ全体で1つの事実なので状態も1つにする(`paradisWebglSupport`)。テストは自前の
 * インスタンスを作れるよう、クラスとして公開する。
 */
export class ParadisWebglSupport {
	private everSucceeded = false;

	/** GPUレンダラが立ち上がった。 */
	noteSucceeded(): void {
		this.everSucceeded = true;
	}

	/**
	 * 取得に失敗したとき、ウィンドウ全体のGPUレンダラを諦めてよいか。
	 *
	 * 一度も立ち上がっていない状態での失敗だけを「この環境は対応していない」と読む。最初の
	 * 端末が枠の取り合いに負けることはない(コンテキストは端末からしか生まれないため、1本目の
	 * 時点で枠は空いている)ので、この読み方で取り違えない。
	 */
	shouldDisableGlobally(): boolean {
		return !this.everSucceeded;
	}
}

/** ウィンドウ(レンダラプロセス)で共有する実体。 */
export const paradisWebglSupport = new ParadisWebglSupport();

/**
 * 端末1本ぶんの取り直し状態。
 *
 * `now` を差し替えられるようにしてあるのは、時計を止めずに間隔の判断を確かめるため。
 */
export class ParadisWebglRecovery {
	private lost = false;
	private attempts = 0;
	private lastAttemptAt = 0;

	constructor(private readonly now: () => number = Date.now) { }

	/** GPUレンダラが立ち上がった。取り直しの記録は捨てる。 */
	noteEnabled(): void {
		this.lost = false;
		this.attempts = 0;
		this.lastAttemptAt = 0;
	}

	/** コンテキストを取り上げられた、または取得に失敗した。 */
	noteLost(): void {
		this.lost = true;
	}

	/**
	 * いま取り直すなら true。true を返した時点で1回ぶん数えるので、呼んだら必ず取りに行くこと
	 * (数えずに返すと、失敗し続けたときに上限が効かない)。
	 */
	shouldRetryNow(): boolean {
		const now = this.now();
		if (!paradisShouldRetryWebgl({ lost: this.lost, attempts: this.attempts, lastAttemptAt: this.lastAttemptAt }, now)) {
			return false;
		}
		this.attempts++;
		this.lastAttemptAt = now;
		return true;
	}
}
