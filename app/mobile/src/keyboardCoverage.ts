// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * キーボードが画面（または指定UI）をどれだけ覆っているかの判定。
 *
 * 入力バーの余白詰めやボトムシートの持ち上げは「下端から何pt隠れるか」で決まる。
 * iPadのキーボードは画面下端に接していないことがあり（小さく畳んで任意の位置へ動かせる
 * フローティングキーボード）、`window.height - screenY` をそのまま被覆量にすると
 * 数百pt覆っている扱いになってボトムシートが画面外へ飛ぶ。
 *
 * 逆に「幅が画面いっぱいでないものを除外する」判定は入れていない。日本語入力の
 * 片手用キーボードのように、**幅は狭いが下端に接していて実際に下を覆う**ものを
 * 取りこぼすほうが害が大きいため（入力欄がキーボードに隠れる）。下端に接している
 * かどうかだけで判定する。
 */

/** `KeyboardEvent['endCoordinates']` のうち判定に使う部分。 */
export interface KeyboardFrame {
	/** キーボード上端の画面座標。 */
	readonly screenY: number;
	readonly height: number;
}

/**
 * この高さ以下は「覆っていない」とみなす。ハードウェアキーボード接続時に出る
 * ショートカットバー（iPadで約55pt、iPhoneのアクセサリバーも同程度）を弾くための値。
 */
export const KEYBOARD_MIN_COVER = 80;

/** 端数・小数の丸め誤差を吸収する許容量（pt）。 */
const EDGE_TOLERANCE = 2;

/**
 * キーボードが画面下端から覆う高さ（pt）。覆っていない場合は0。
 *
 * `elementTop`（覆われる側のUI — 画面下端に置かれる入力バーなど — の画面座標上端）を
 * 渡すと、下端に**接地していなくても**そのUIへ食い込んでいるぶんを被覆とみなす。
 * フローティングキーボードを下端付近へ浮かべると入力バーが覆われるのに、接地判定だけでは
 * 何も起こらなかったため。戻り値自体は「下端からの隠れ量」（= UI全体をキーボードより上へ
 * 持ち上げるのに必要な量）で、frame だけで決まるので呼び出し側のレイアウトと干渉しない。
 */
export function keyboardCoverage(frame: KeyboardFrame, windowHeight: number, elementTop?: number): number {
	// iOSのアクセシビリティ「クロスフェードトランジションを優先」が有効だと、キーボードの
	// 位置が実際のY座標ではなく0で報告される（RN本体も KeyboardAvoidingView で
	// `screenY === 0` を異常として特別扱いしている）。素直に `windowHeight - screenY` を
	// 使うと「画面全体を覆っている」ことになってしまうので、フレームの高さ自体を被覆量とみなす。
	// この場合は下端の接地判定も当てにできないため飛ばす。
	if (frame.screenY === 0) {
		return frame.height > KEYBOARD_MIN_COVER ? frame.height : 0;
	}
	const keyboardBottom = frame.screenY + frame.height;
	// 下端に接していなければ基本は0。ただし elementTop が分かる場合は、キーボードの下端が
	// そのUIの上端より下まで届いている（＝食い込んでいる）なら被覆ありとする。
	const reachesBottom = keyboardBottom >= windowHeight - EDGE_TOLERANCE;
	const overlapsElement = elementTop !== undefined && keyboardBottom > elementTop;
	if (!reachesBottom && !overlapsElement) {
		return 0;
	}
	const covered = windowHeight - frame.screenY;
	return covered > KEYBOARD_MIN_COVER ? covered : 0;
}
