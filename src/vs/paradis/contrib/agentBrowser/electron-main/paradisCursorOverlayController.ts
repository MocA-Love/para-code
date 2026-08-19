/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 合成マウスカーソル演出を実際のBrowserViewへ適用するelectron-main側のコントローラ。
//
// 呼び出し元は `ParadisCdpTargetService`（エージェントの入力配送とスクリーンショットの唯一の
// 通り道）。演出はあくまで飾りなので、このクラスは「本来の処理を絶対に壊さない」ことを最優先に
// 設計してある:
//
//  - 例外は全てここで握りつぶす（呼び出し元へ投げ返さない）
//  - 入力配送の途中でページの応答を待たない（移動時間はmain側で決めて投げっぱなしにする）
//  - 待たせる時間は必ず上限で頭打ちにする（超過すると入力キューが恒久的にpoisonされるため）
//  - 一度失敗したビューはしばらく演出を止める（壊れたページで毎回コストを払わない）

import { raceTimeout } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { browserViewIsolatedWorldId } from '../../../../platform/browserView/common/browserView.js';
import {
	PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS,
	ParadisCursorOverlayCommand,
	paradisBuildCursorOverlayScript,
	paradisClampCursorWaitMs,
	paradisCursorGlideMs,
	paradisCursorMoveMaxMs,
} from '../common/paradisCursorOverlay.js';

/**
 * このコントローラが必要とするBrowserViewの最小構造。
 *
 * Electronの具象型ではなく構造的に受けることで、テストから素の偽物を渡せるようにしてある
 * （テストのためにグローバルを差し替えたりany castしたりしない、という規約に沿う）。
 */
export interface IParadisCursorOverlayTarget {
	readonly webContents: {
		isDestroyed(): boolean;
		executeJavaScriptInIsolatedWorld(worldId: number, scripts: readonly { readonly code: string }[]): Promise<unknown>;
	};
	getState(): { readonly visible: boolean };
}

/** 撮影前の退避を待つ上限（ms）。ここだけは撮影を止めないため必ず打ち切る。 */
const HIDE_EVAL_TIMEOUT_MS = 700;

/** 演出を止めておく時間（ms）。 */
const FAILURE_BACKOFF_MS = 30_000;

/**
 * これだけ連続で失敗したら演出を止める。
 *
 * `executeJavaScriptInIsolatedWorld` はページ遷移やフレーム破棄のたびに正常に reject する。
 * エージェント操作中の遷移は日常茶飯事なので、1回の失敗で止めると演出がほとんどの時間
 * 消えてしまう。「本当に壊れているページ」だけを弾くために連続回数で判断する。
 */
const FAILURE_STREAK_LIMIT = 3;

/**
 * 撮影フラッシュの最小間隔（ms）。
 *
 * エージェントは短時間に何度もスクリーンショットを撮るため、毎回全画面を白く光らせると
 * 点滅そのものになってしまう（見づらいだけでなく、光過敏の観点でも避けたい）。
 */
const FLASH_MIN_INTERVAL_MS = 1_200;

/** フォーカス追従を送る最小間隔（ms）。打鍵1回ごとに送らないための間引き。 */
const FOCUS_NUDGE_INTERVAL_MS = 250;

/** カーソルの現在位置（ビューポート座標）と、それを置いた時刻。 */
interface IParadisCursorPosition {
	readonly x: number;
	readonly y: number;
	readonly at: number;
}

export class ParadisCursorOverlayController {

	/** 失敗したビューを演出対象から一時的に外すための期限（ビュー→再開時刻）。 */
	private readonly disabledUntil = new WeakMap<object, number>();
	/** ビューごとの最終フラッシュ時刻（連続撮影で点滅させないため）。 */
	private readonly lastFlashAt = new WeakMap<object, number>();
	/** ページに問い合わせず移動時間を決めるための、カーソルの現在位置。 */
	private readonly position = new WeakMap<object, IParadisCursorPosition>();
	/**
	 * 撮影のために隠している深さ。
	 *
	 * 同じページを複数のペインが共有していると撮影要求が重なりうる。単純なhide/showだと
	 * 先に終わった側のshowで戻ってしまい、後続の撮影にカーソルが写る。0になるまで戻さない。
	 */
	private readonly hideDepth = new WeakMap<object, number>();
	/** 一度でもこのビューへ演出を注入したか（設定OFFへの切り替え時に片付けるため）。 */
	private readonly injected = new WeakSet<object>();
	/**
	 * エージェントがこのページを手放すたびに進む世代。
	 *
	 * 撮影は数百ms掛かるので、その最中に共有解除やユーザーのfocusが起きうる。撮り始めの世代と
	 * 撮り終えた時点の世代が違えば「もう自分のページではない」ので、撮影自体は成立していても
	 * フラッシュは出さない（ユーザーが使い始めたページが理由もなく光るのを防ぐ）。
	 */
	private readonly detachGeneration = new WeakMap<object, number>();
	/** 撮影を始めた時点の `detachGeneration`（重なった撮影では最初の1回ぶんだけ覚える）。 */
	private readonly captureGeneration = new WeakMap<object, number>();
	/** 連続で失敗した回数（成功したら0に戻す）。 */
	private readonly failureStreak = new WeakMap<object, number>();
	/** 最後にフォーカス追従を送った時刻（キー入力のたびに送らないための間引き）。 */
	private readonly lastFocusNudgeAt = new WeakMap<object, number>();

	constructor(
		/** 設定 `paradis.agentBrowser.showCursorOverlay` の現在値を返す。 */
		private readonly isEnabled: () => boolean = () => true,
		private readonly now: () => number = Date.now,
	) { }

	/**
	 * マウス入力の配送直前に呼ぶ。実際の配送まで待つべき時間（ms）を返す。
	 *
	 * `mouseMoved` はカーソルを目標座標へ滑らせ、その所要時間を返す（実際のCDP配送を
	 * その分だけ遅らせることで、ホバーが「カーソルが着いた瞬間」に効くように見える）。
	 * 移動時間はmain側で距離から決めるので、ページの応答は待たない。
	 * `mousePressed` は波紋を出すだけで待たない。`mouseReleased` と `mouseWheel` は何もしない。
	 */
	async onMouseEvent(view: IParadisCursorOverlayTarget, params: Readonly<Record<string, unknown>>): Promise<number> {
		const type = params.type;
		if (type !== 'mouseMoved' && type !== 'mousePressed') {
			return 0;
		}
		if (!this.isActive(view)) {
			// 表示中に設定をOFFにされたら、既に置いてあるカーソルはここで片付ける
			// （`idleMs` に任せると「設定が効かない」と見える）。
			this.removeIfDisabled(view);
			return 0;
		}
		const { x, y } = params;
		if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
			return 0;
		}
		if (type === 'mousePressed') {
			// 波紋は配送を待たせる価値がないので投げっぱなしにする。
			this.position.set(view, { x, y, at: this.now() });
			this.run(view, { kind: 'press', x, y, label: cursorLabel() });
			return 0;
		}
		const at = this.now();
		const next = { x, y, at };
		const glideMs = paradisCursorGlideMs(this.position.get(view), next, paradisCursorMoveMaxMs(params));
		this.position.set(view, next);
		// 実行の完了は待たない。待つのはカーソルが滑り終わるぶんだけで、その間に注入は済む。
		this.run(view, { kind: 'move', x, y, label: cursorLabel(), durationMs: glideMs });
		return paradisClampCursorWaitMs(glideMs, PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS);
	}

	/**
	 * キーボード入力の配送時に呼ぶ。フォーカスされている要素へカーソルを寄せる。
	 *
	 * キー入力は座標を持たないので、どこへ寄せるかはページ側が
	 * `document.activeElement` から決める。打鍵のたびに送っても意味がないので間引く。
	 * （`fill` のようにCDPの入力すら出さない操作は、ページ側の focusin 監視が拾う。）
	 */
	onKeyEvent(view: IParadisCursorOverlayTarget): void {
		if (!this.isActive(view)) {
			this.removeIfDisabled(view);
			return;
		}
		const at = this.now();
		const previous = this.lastFocusNudgeAt.get(view);
		if (previous !== undefined && at - previous < FOCUS_NUDGE_INTERVAL_MS) {
			return;
		}
		this.lastFocusNudgeAt.set(view, at);
		this.run(view, { kind: 'focus', label: cursorLabel() });
	}

	/**
	 * スクリーンショット撮影の直前に呼ぶ。カーソル演出を撮影に写さないため即座に隠す。
	 *
	 * 可視判定を通さないのは、撮影経路が非表示ビューを一時的に可視化してから撮るため
	 * （隠しそびれると、ユーザーが見ていない間に付いたカーソルが画像へ写り込む）。
	 * 演出が存在しなければページ側で何も起きない。
	 */
	async hideForCapture(view: IParadisCursorOverlayTarget): Promise<void> {
		// 加算は無条件に行う。`afterCapture` は無条件に減算するので、ここだけ条件付きにすると
		// 撮影が重なっている最中にバックオフが立ったときに台帳がずれ、まだ撮っている最中に
		// 復帰させてしまう。抑制するのは実行だけでよい。
		const depth = (this.hideDepth.get(view) ?? 0) + 1;
		this.hideDepth.set(view, depth);
		if (depth === 1) {
			this.captureGeneration.set(view, this.detachGeneration.get(view) ?? 0);
		}
		if (!this.isUsable(view)) {
			return;
		}
		await this.runAndWait(view, { kind: 'hide' }, HIDE_EVAL_TIMEOUT_MS);
	}

	/**
	 * スクリーンショット撮影の直後に呼ぶ。隠していたカーソルを戻す。
	 *
	 * フラッシュを出すのは実際に撮れたときだけ。所有権を失ったページや撮影に失敗したときまで
	 * 光らせると、いま自分で操作しているページが理由もなく光ることになる。
	 * 復帰は撮影の成否に関わらず必ず行う（隠したままにしない）。
	 */
	afterCapture(view: IParadisCursorOverlayTarget, captured: boolean): boolean {
		const depth = Math.max(0, (this.hideDepth.get(view) ?? 0) - 1);
		this.hideDepth.set(view, depth);
		// 復帰は「描く」ではなく「片付ける」側の操作なので、失敗バックオフでは止めない。
		// 止めると、隠したまま戻せないページが残る（ページ側は隠蔽フラグを尊重するため、
		// 以降の移動でも自己回復しない）。非表示ビューの撮影では hide の解決がタイムアウトして
		// バックオフが立つことが実際にあり、そこが一番踏みやすい。
		if (!this.isAlive(view)) {
			return false;
		}
		if (depth > 0) {
			// まだ別の撮影が走っている。ここで戻すとその1枚にカーソルが写る。
			return false;
		}
		// 撮り始めてから手放していないときだけ光らせる。
		const stillOurs = (this.captureGeneration.get(view) ?? 0) === (this.detachGeneration.get(view) ?? 0);
		if (captured && stillOurs && this.enabled() && this.shouldFlash(view)) {
			this.run(view, { kind: 'captured', toast: captureToastLabel() });
			return true;
		}
		this.run(view, { kind: 'show' });
		return false;
	}

	/**
	 * 演出そのものが有効か（設定 `paradis.agentBrowser.showCursorOverlay`）。
	 *
	 * ブラウザ一覧はページの演出を縮小映像の上へ描き直すが、その判断も同じ設定に従わせる。
	 * 設定を切った人の一覧にだけカーソルが出続ける、という食い違いを作らないため。
	 */
	isOverlayEnabled(): boolean {
		return this.enabled();
	}

	/**
	 * ページがエージェントの手を離れたときに呼ぶ。残っているカーソルを即座に取り除く。
	 *
	 * カーソルは操作が途切れてもしばらく留まる（`idleMs`）ので、共有解除やユーザーの手動操作の
	 * 開始をそれに任せると、もう誰も操作していないページにカーソルが残り続けて見える。
	 * 設定・可視性・失敗バックオフのいずれも見ないのは、これが「描く」のではなく
	 * 「片付ける」操作であり、条件付きで飛ばすと片付け忘れがそのまま画面に残るため。
	 * 唯一「そもそも置いていない」ときだけは何もしない（消すものが無いため）。
	 */
	removeOverlay(view: IParadisCursorOverlayTarget): void {
		// 世代は「消すものがあるか」に関わらず進める。進行中の撮影に対して
		// 「もうこのページはエージェントのものではない」と伝えるのがこの台帳の役目なので、
		// カーソルを置いていなかったケースでも同じように打ち切る必要がある。
		this.detachGeneration.set(view, (this.detachGeneration.get(view) ?? 0) + 1);
		if (!this.injected.has(view)) {
			// 一度も置いていないページに送っても消すものが無い。入力の試行ごとに呼ばれる
			// 経路（ユーザーがfocusを持っている間のリトライ）があるので、空打ちを避ける。
			return;
		}
		this.injected.delete(view);
		this.position.delete(view);
		// `hideDepth` は「いま何枚撮っている最中か」であってカーソルの有無とは別の台帳なので、
		// ここで消してはいけない。消すと進行中の撮影が残っていても次の `afterCapture` が
		// 0まで落ちたと判断し、まだ撮っている最中に復帰やフラッシュを出してしまう。
		if (!this.isAlive(view)) {
			return;
		}
		this.run(view, { kind: 'remove' });
	}

	/** 設定がOFFに変わったとき、既に置いたカーソルを1度だけ片付ける。 */
	private removeIfDisabled(view: IParadisCursorOverlayTarget): void {
		if (this.enabled()) {
			return;
		}
		// 1度きりにする責任は removeOverlay 側が持つ。
		this.removeOverlay(view);
	}

	/** 撮影後の知らせと復帰は待たないので、まとめて投げっぱなしにする。 */
	private shouldFlash(view: IParadisCursorOverlayTarget): boolean {
		const previous = this.lastFlashAt.get(view);
		const at = this.now();
		if (previous !== undefined && at - previous < FLASH_MIN_INTERVAL_MS) {
			return false;
		}
		this.lastFlashAt.set(view, at);
		return true;
	}

	/**
	 * 設定値の読み取り。演出はあくまで飾りなので、設定サービスが何を投げてきても
	 * 呼び出し元（入力配送・スクリーンショット）には絶対に波及させない。
	 */
	private enabled(): boolean {
		try {
			return this.isEnabled();
		} catch {
			return false;
		}
	}

	/** 設定・可視性・破棄状態・失敗バックオフを全て満たすときだけ演出する。 */
	private isActive(view: IParadisCursorOverlayTarget): boolean {
		if (!this.enabled() || !this.isUsable(view)) {
			return false;
		}
		try {
			// ユーザーが見ていないタブに描いても意味がないので、注入自体を行わない。
			return view.getState().visible === true;
		} catch {
			return false;
		}
	}

	/** 破棄済み・失敗バックオフ中でないこと（可視性は問わない）。演出を「描く」側の判定。 */
	private isUsable(view: IParadisCursorOverlayTarget): boolean {
		const until = this.disabledUntil.get(view);
		if (until !== undefined && this.now() < until) {
			return false;
		}
		return this.isAlive(view);
	}

	/**
	 * ビューがまだ生きていること。
	 *
	 * 復帰・片付けはこちらだけを見る。失敗バックオフは「壊れたページで演出のコストを
	 * 払い続けない」ための仕組みなので、既に置いた／隠したものを元に戻す操作まで
	 * 止めてしまうと、そのページに中途半端な状態が残る。
	 */
	private isAlive(view: IParadisCursorOverlayTarget): boolean {
		try {
			return !view.webContents.isDestroyed();
		} catch {
			return false;
		}
	}

	/**
	 * ページ側スクリプトを投げっぱなしで実行する。
	 *
	 * 演出はどれも「届けば嬉しい」だけのものなので、完了を待たない。待たなければ
	 * タイムアウト用のタイマーも要らず、入力配送1回ごとの費用は送信だけになる。
	 */
	private run(view: IParadisCursorOverlayTarget, command: ParadisCursorOverlayCommand): void {
		void this.execute(view, command);
	}

	/** 撮影前の退避だけは結果を待つ。ページが黙っていても撮影は止めない。 */
	private async runAndWait(view: IParadisCursorOverlayTarget, command: ParadisCursorOverlayCommand, timeoutMs: number): Promise<void> {
		// タイムアウトは失敗として数えない。遅いだけのページで演出を丸ごと止める理由はなく、
		// 本当に壊れているなら reject 側が連続して立つ。
		await raceTimeout(this.execute(view, command), timeoutMs);
	}

	/** 実行本体。例外は全てここで吸収し、呼び出し元へは絶対に投げない。 */
	private async execute(view: IParadisCursorOverlayTarget, command: ParadisCursorOverlayCommand): Promise<void> {
		try {
			const code = paradisBuildCursorOverlayScript(command);
			if (command.kind === 'move' || command.kind === 'press' || command.kind === 'focus') {
				this.injected.add(view);
			}
			await view.webContents.executeJavaScriptInIsolatedWorld(browserViewIsolatedWorldId, [{ code }]);
			this.failureStreak.delete(view);
		} catch {
			this.markFailed(view);
		}
	}

	/**
	 * 実行の失敗を記録する。連続で続いたときだけ演出を止める。
	 *
	 * ページ遷移やフレーム破棄による reject は正常な出来事なので、1回で止めると
	 * エージェント操作中はほとんどの時間バックオフに入ってしまう。
	 */
	private markFailed(view: IParadisCursorOverlayTarget): void {
		const streak = (this.failureStreak.get(view) ?? 0) + 1;
		this.failureStreak.set(view, streak);
		if (streak >= FAILURE_STREAK_LIMIT) {
			this.failureStreak.delete(view);
			this.disabledUntil.set(view, this.now() + FAILURE_BACKOFF_MS);
		}
	}
}

/** 撮影完了の知らせに出す文言。 */
function captureToastLabel(): string {
	try {
		return localize('paradis.agentBrowser.captureToast', "キャプチャ完了");
	} catch {
		return 'Screenshot captured';
	}
}

/**
 * ページ上のカーソルへ添えるラベル。ワークベンチの表示言語に従う。
 *
 * 呼び出しは入力配送の同期パス上にあるため、翻訳の解決に失敗しても配送を巻き込まないよう
 * 素の文字列へ落とす。
 */
function cursorLabel(): string {
	try {
		return localize('paradis.agentBrowser.cursorLabel', "エージェント");
	} catch {
		return 'Agent';
	}
}
