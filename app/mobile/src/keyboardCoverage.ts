// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ソフトウェアキーボードが画面下端をどれだけ覆っているかの判定。
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

/** 画面下端が覆われている高さ（pt）。覆っていない場合は0。 */
export function keyboardCoverage(frame: KeyboardFrame, windowHeight: number): number {
	// iOSのアクセシビリティ「クロスフェードトランジションを優先」が有効だと、キーボードの
	// 位置が実際のY座標ではなく0で報告される（RN本体も KeyboardAvoidingView で
	// `screenY === 0` を異常として特別扱いしている）。素直に `windowHeight - screenY` を
	// 使うと「画面全体を覆っている」ことになってしまうので、フレームの高さ自体を被覆量とみなす。
	// この場合は下端の接地判定も当てにできないため飛ばす。
	if (frame.screenY === 0) {
		return frame.height > KEYBOARD_MIN_COVER ? frame.height : 0;
	}
	// 下端に接していなければ、その下のUIは隠れない（iPadのフローティングキーボード）。
	if (frame.screenY + frame.height < windowHeight - EDGE_TOLERANCE) {
		return 0;
	}
	const covered = windowHeight - frame.screenY;
	return covered > KEYBOARD_MIN_COVER ? covered : 0;
}
