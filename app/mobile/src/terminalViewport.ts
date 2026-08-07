// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 「読める文字サイズ」から端末のグリッド（桁×行）を逆算する。
 *
 * 従来はPC側の桁数をそのまま作り、画面に収まるまでフォントを縮めていた（termView.tsx の
 * `fit()`）。150桁の端末をiPhoneに載せると下限の4ptに張り付いて読めないため、順序を逆にして
 * 「文字サイズを先に決め、そこから何桁入るかを決める」ようにしたのがこの計算。
 * 求めた寸法はPCへ申告し、PTY自体をその寸法へ寄せてもらう（`viewCols`/`viewRows`）。
 *
 * 文字の実寸はフォント・OS・端末で変わるためWebView内で実測し（100px時の1文字送りと行送り）、
 * その値をここへ渡す。計算だけを純関数に切り出しているのは、WebViewを起動せずに
 * 境界（極端に狭い幅、巨大なフォント指定）の挙動をテストできるようにするため。
 */

/** 設定で選べる文字サイズの範囲（pt）。 */
export const TERMINAL_FONT_SIZE_MIN = 6;
export const TERMINAL_FONT_SIZE_MAX = 20;
/**
 * 既定の文字サイズ。iPhoneの本文幅（約359pt）でおよそ59桁になる。
 * 同じ用途のアプリ（Termius）の実測値が約10pt / 66桁で、そこに合わせてある。
 */
export const TERMINAL_FONT_SIZE_DEFAULT = 10;

/**
 * PCへ申告できる寸法の範囲。PC側の受け入れ範囲
 * （`paradisMobileTerminalViewport.ts` の `PARADIS_TERM_VIEWPORT_*`）と一致させること。
 * ここを外れた値を送るとPC側に無効として捨てられ、寸法合わせが黙って効かなくなる。
 */
export const TERMINAL_VIEWPORT_MIN_COLS = 20;
export const TERMINAL_VIEWPORT_MIN_ROWS = 5;
export const TERMINAL_VIEWPORT_MAX_COLS = 500;
export const TERMINAL_VIEWPORT_MAX_ROWS = 300;

/** 画面を実測して求めたグリッド。 */
export interface TerminalGrid {
	readonly cols: number;
	readonly rows: number;
}

/**
 * PCへ申告する寸法。`rows` を載せないと行数はPC側のまま（設定「行数も合わせる」がオフのとき）。
 * PC側の受け取り（`paradisMobileTerminalViewport.ts`）と形を合わせてある。
 */
export interface TerminalViewport {
	readonly cols: number;
	readonly rows?: number;
}

/** WebView内で実測した文字の寸法（フォントサイズ100px時のpx値）。 */
export interface TerminalFontMetrics {
	/** 1文字ぶんの送り幅。 */
	readonly charWidth100: number;
	/** 1行ぶんの送り高さ。 */
	readonly lineHeight100: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** 設定値を許容範囲の整数へ丸める（保存済みの壊れた値・古い値からの復帰用）。 */
export function clampTerminalFontSize(value: number): number {
	return Number.isFinite(value)
		? clamp(Math.round(value), TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX)
		: TERMINAL_FONT_SIZE_DEFAULT;
}

/**
 * 与えられた表示領域と文字サイズに収まるグリッドを求める。
 *
 * 端数は切り捨てる（切り上げると最後の1桁・1行が画面外に出る）。極端に狭い領域では
 * 下限で止める。下限に張り付いた場合は画面からはみ出すが、桁数を下限より小さくすると
 * シェルやTUIの表示が壊れるため、はみ出す方を選ぶ。
 */
export function terminalGridFor(
	availWidth: number,
	availHeight: number,
	fontSize: number,
	metrics: TerminalFontMetrics,
): TerminalGrid | undefined {
	const { charWidth100, lineHeight100 } = metrics;
	if (!(charWidth100 > 0) || !(lineHeight100 > 0) || !(availWidth > 0) || !(availHeight > 0)) {
		return undefined;
	}
	const size = clampTerminalFontSize(fontSize);
	const cols = Math.floor(availWidth / (charWidth100 / 100 * size));
	const rows = Math.floor(availHeight / (lineHeight100 / 100 * size));
	if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
		return undefined;
	}
	return {
		cols: clamp(cols, TERMINAL_VIEWPORT_MIN_COLS, TERMINAL_VIEWPORT_MAX_COLS),
		rows: clamp(rows, TERMINAL_VIEWPORT_MIN_ROWS, TERMINAL_VIEWPORT_MAX_ROWS),
	};
}

/** 申告済みの寸法と同じか（再送を抑えるための比較）。 */
export function terminalViewportEquals(a: TerminalViewport | undefined, b: TerminalViewport | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.cols === b.cols && a.rows === b.rows);
}

/**
 * 実測グリッドと設定から、PCへ申告する寸法を組み立てる。
 * 幅合わせがオフなら申告しない（`undefined`）＝PC側は従来どおりの寸法のまま。
 */
export function terminalViewportForPrefs(grid: TerminalGrid | undefined, prefs: TerminalPrefs): TerminalViewport | undefined {
	if (!prefs.matchPcWidth || grid === undefined) {
		return undefined;
	}
	return { cols: grid.cols, ...(prefs.matchPcRows ? { rows: grid.rows } : {}) };
}

/** 設定 →「ターミナル」で選べる値。この端末の中だけの設定で、PCへは送らない。 */
export interface TerminalPrefs {
	/** 文字サイズ（pt）。 */
	readonly fontSize: number;
	/**
	 * PC側のターミナルをこの画面の幅に合わせるか。
	 *
	 * まだベータのため既定はオフ。オフの間はPCへ寸法を一切申告しないので、
	 * PC側の挙動は従来と完全に同じになる（この機能が入る前と1バイトも変わらない）。
	 */
	readonly matchPcWidth: boolean;
	/**
	 * 行数も合わせるか。オフだと桁だけを合わせ、行数はPC側のまま使う。
	 *
	 * オンだとスマホの画面をぴったり使える代わりに、PC側のターミナルが表示領域より
	 * 縦に長くなって下が切れる（`forceExactSize` はUIをはみ出しても指定寸法を通すため）。
	 * 「スマホで見ている間はPCを見ない」前提なのでオンを既定にしている。
	 */
	readonly matchPcRows: boolean;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
	fontSize: TERMINAL_FONT_SIZE_DEFAULT,
	matchPcWidth: false,
	matchPcRows: true,
};

/** 保存済みの設定を読み戻す（欠けている・壊れている項目は既定へ倒す）。 */
export function normalizeTerminalPrefs(stored: unknown): TerminalPrefs {
	if (typeof stored !== 'object' || stored === null) {
		return DEFAULT_TERMINAL_PREFS;
	}
	const raw = stored as Partial<Record<keyof TerminalPrefs, unknown>>;
	return {
		fontSize: typeof raw.fontSize === 'number' ? clampTerminalFontSize(raw.fontSize) : DEFAULT_TERMINAL_PREFS.fontSize,
		matchPcWidth: raw.matchPcWidth === true,
		// 既定オンの項目は「明示的にオフにした人だけオフ」にする。この項目が無い時代の
		// 保存値を読み戻したときに、新しい既定が効かなくなるのを防ぐ。
		matchPcRows: raw.matchPcRows !== false,
	};
}
