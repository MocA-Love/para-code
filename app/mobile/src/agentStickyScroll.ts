// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェント詳細のチャットを「最下部に追従するか」の判断だけを持つ。
//
// 追従の解除は**読み手が上へ動かしたか**で決める。以前は「指が触れている間、または慣性が走っている
// 間に届いた onScroll」でしか解除できず、応答が流れている最中に上へスクロールしても無視されることが
// あった: 下端まで 80px 未満のドラッグはその間ずっと「最下部にいる」と判定され、指を離したあとに
// 本文が伸びて初めて 80px を超えるが、その onScroll はもうフラグが落ちた状態で届くため解除できない。
// 残った sticky が次の onContentSizeChange で末尾へ引き戻す——これが「指を離すと下へ飛ぶ」の正体。
//
// 位置で見れば、本文が伸びても contentOffset は動かないので、上への移動は操作だけを表す。
// ただし OS が offset を切り詰める場面（本文の縮み、キーボードを閉じてビューポートが伸びたとき、
// iOS のバウンスの戻り）も後退として現れるので、**末尾に貼り付いている間の後退は操作と数えない**。
// また移動量は直前サンプルとの差ではなく「直近で最も下だった位置からの累積」で見る。1サンプルの
// 差だけを見ると、ゆっくり遡る操作（数px/サンプル）がいくら積み重なっても検知できない。

/** 追従中かどうかの判定に使う1サンプル（onScroll のイベントから必要な値だけ取り出したもの）。 */
export interface IAgentScrollSample {
	readonly offsetY: number;
	readonly layoutHeight: number;
	readonly contentHeight: number;
}

/** 下端からこの距離以内なら「最下部にいる」とみなす。 */
const BOTTOM_THRESHOLD_PX = 80;
/**
 * 上への移動とみなす最小の累積量、および「末尾に貼り付いている」とみなす余白。
 * レイアウトの丸めや慣性の減衰で出る 1px 単位の揺れを操作と誤認しないだけの幅。
 */
const SCROLL_EPSILON_PX = 4;

/**
 * 追従状態を持つ小さな状態機械。React に依存しないので、画面を動かさずに挙動を検証できる。
 *
 * 呼び出し側は各メソッドの戻り値だけを見ればよい（`sticky` が変わったかは `handleScroll` の
 * 戻り値、末尾へ寄せるべきかは {@link handleContentSize} の戻り値）。
 */
export class AgentStickyScroll {

	private _sticky = true;
	/** ナビゲーションで「最新へ」と指定されたときだけ立つ。到達するまでは下端に居なくても追いかける。 */
	private _followUntilReached = false;
	private _dragging = false;
	private _momentum = false;
	private _lastSample: IAgentScrollSample | undefined;
	/** 直近で最も下だった位置。上への移動はここからの累積で測る。 */
	private _anchorOffsetY = 0;
	private _lastContentHeight = 0;

	get sticky(): boolean {
		return this._sticky;
	}

	/** 表示対象が変わった。前の対象の高さや位置を引き継がない。 */
	reset(): void {
		this._sticky = true;
		this._followUntilReached = false;
		this._dragging = false;
		this._momentum = false;
		this._lastSample = undefined;
		this._anchorOffsetY = 0;
		this._lastContentHeight = 0;
	}

	/** 「最新へ」ボタンや送信直後など、明示的に追従へ戻す。 */
	followNow(): void {
		this._sticky = true;
		this._followUntilReached = false;
		this._dragging = false;
		this._momentum = false;
		this._lastSample = undefined;
		this._anchorOffsetY = 0;
	}

	/** 通知などから「この発言を見せる」と指定されて開いた。下端へ届くまで追いかける。 */
	followFromNavigation(): void {
		this.followNow();
		this._followUntilReached = true;
		this._lastContentHeight = 0;
	}

	beginDrag(): void {
		this._dragging = true;
		this._momentum = false;
		// 指が触れた時点で、ナビゲーション由来の追いかけはユーザーに明け渡す。
		this._followUntilReached = false;
	}

	endDrag(): void {
		this._dragging = false;
	}

	beginMomentum(): void {
		this._momentum = true;
	}

	endMomentum(): void {
		this._momentum = false;
	}

	/** スクロール位置が届いた。`sticky` が変わったら true を返す（呼び出し側の再描画用）。 */
	handleScroll(sample: IAgentScrollSample): boolean {
		const previous = this._lastSample;
		this._lastSample = sample;
		const nearBottom = sample.offsetY + sample.layoutHeight >= sample.contentHeight - BOTTOM_THRESHOLD_PX;
		if (nearBottom) {
			this._followUntilReached = false;
		}
		// 末尾に貼り付いている間の後退は、OS が offset を切り詰めただけ（本文の縮み、キーボードを
		// 閉じてビューポートが伸びたとき、iOS のバウンスの戻り）で、読み手の操作ではない。
		const maxOffsetY = Math.max(0, sample.contentHeight - sample.layoutHeight);
		const pinnedAtEnd = sample.offsetY >= maxOffsetY - SCROLL_EPSILON_PX;
		const movedDown = previous !== undefined && sample.offsetY - previous.offsetY >= SCROLL_EPSILON_PX;
		// 下へ向き直したら、そこを新しい起点にする。ここで更新しないと、遡ったあと下端へ戻る途中も
		// ずっと「起点より上にいる」と見なされ、戻り切るまで追従が再開しない。
		if (previous === undefined || pinnedAtEnd || movedDown || sample.offsetY > this._anchorOffsetY) {
			this._anchorOffsetY = Math.min(sample.offsetY, maxOffsetY);
		}
		if (previous === undefined) {
			return false;
		}
		// 末尾に貼り付いている間は起点も一緒に切り詰まるので、クランプぶんは累積に乗らない。
		const movedUp = this._anchorOffsetY - sample.offsetY >= SCROLL_EPSILON_PX;
		const before = this._sticky;
		if (movedUp && !this._followUntilReached) {
			// 上へ動いた＝遡って読み始めた。下端まで 80px 以内でも解除する（応答が伸びればすぐ
			// 80px を超えるので、ここで残すと「少し上げただけなのに引き戻される」になる）。
			this._sticky = false;
		} else if (pinnedAtEnd || (nearBottom && movedDown)) {
			// 末尾に着いたか、下端へ**戻ってきた**ときだけ追従を再開する。位置が動いていないのに
			// 「下端付近だから」で再開すると、上げた直後の（動きの無い）サンプルで解除が取り消される。
			this._sticky = true;
		}
		return this._sticky !== before;
	}

	/**
	 * 内容の高さが変わった。末尾へ寄せるべきなら true を返す。
	 *
	 * ここで true を返すのは、呼び出し側が末尾へ動かす（＝位置が下がる）ときだけにすること。
	 * 追従していないときにリストを動かすと、その移動が {@link handleScroll} から見て
	 * 「読み手が下へ戻った」に見え、追従が誤って再開する。
	 */
	handleContentSize(height: number): boolean {
		const previousHeight = this._lastContentHeight;
		this._lastContentHeight = height;
		// 指が触れている間（慣性を含む）は引き戻さない。
		if (this._dragging || this._momentum) {
			return false;
		}
		// 縮んだ方向へは追従しない。ライブ表示のフッターはツールの開始/終了ごとに伸縮するので、
		// 縮小時にも末尾へ寄せると本文が上下に往復して震える。位置合わせは OS のクランプに任せる。
		if (height < previousHeight) {
			return false;
		}
		// 追いかけ中（_followUntilReached）は handleScroll が sticky を落とさないので、ここは
		// sticky だけ見れば足りる。
		return this._sticky;
	}

	/** 表示領域が縮んだ（キーボードが出た等）。末尾へ寄せ直すべきなら true。 */
	shouldPinOnViewportShrink(): boolean {
		return this._sticky;
	}
}
