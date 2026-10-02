// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ブラウザの全画面の出し入れ（案A）。
 *
 * - 全画面のボタンで入る・抜ける
 * - iPhone では、全画面にしていない間に端末を横に倒しても入る（アプリは縦に固定なので、画面は回らず
 *   端末の向きだけが届く）。全画面の間だけ OS の横向きを許すので、入ると画面が横に回る
 * - 横に倒して入ったときは、縦に戻すと抜ける。ボタンで入ったときは縦に戻しても抜けない
 * - 画面を離れたら抜ける（抜けたら縦に戻す）
 *
 * iPad は前から全方向に回るので、端末の向きでは出し入れしない（見出しとタブの列・左の列を隠すだけ）。
 */

export interface BrowserFullscreenState {
	readonly fullscreen: boolean;
	/** どうやって入ったか。抜けているときは `undefined`。 */
	readonly via: 'button' | 'tilt' | undefined;
}

export type BrowserFullscreenEvent =
	| { readonly kind: 'toggle' }
	| { readonly kind: 'exit' }
	/** 端末の向き（全画面かどうかに関係なく OS から届く。表を上・下に向けたものは `other`）。 */
	| { readonly kind: 'device'; readonly orientation: 'portrait' | 'landscape' | 'other'; readonly tablet: boolean };

export const BROWSER_FULLSCREEN_OFF: BrowserFullscreenState = { fullscreen: false, via: undefined };

export function nextBrowserFullscreen(state: BrowserFullscreenState, event: BrowserFullscreenEvent): BrowserFullscreenState {
	switch (event.kind) {
		case 'toggle':
			return state.fullscreen ? BROWSER_FULLSCREEN_OFF : { fullscreen: true, via: 'button' };
		case 'exit':
			return BROWSER_FULLSCREEN_OFF;
		case 'device':
			if (event.tablet || event.orientation === 'other') {
				return state;
			}
			if (event.orientation === 'landscape') {
				return state.fullscreen ? state : { fullscreen: true, via: 'tilt' };
			}
			return state.fullscreen && state.via === 'tilt' ? BROWSER_FULLSCREEN_OFF : state;
	}
}

/** OS の横向きを許すか。iPhone の全画面の間だけ（iPad は OS の設定のまま全方向）。 */
export function landscapeAllowed(state: BrowserFullscreenState, tablet: boolean): boolean {
	return !tablet && state.fullscreen;
}

/**
 * iPad の 2 列で、全画面の出入りに合わせて左の列をどうするか。全画面に入ったら（開いていれば）畳み、
 * 抜けたら自分で畳んだときだけ戻す。どちらも保存しない（全画面中に強制終了しても、次は元のまま）。
 */
export function sidebarForFullscreen(fullscreen: boolean, regular: boolean, collapsed: boolean, collapsedByFullscreen: boolean): { readonly set: boolean | undefined; readonly collapsedByFullscreen: boolean } {
	if (fullscreen && regular && !collapsed) {
		return { set: true, collapsedByFullscreen: true };
	}
	if (!fullscreen && collapsedByFullscreen) {
		return { set: false, collapsedByFullscreen: false };
	}
	return { set: undefined, collapsedByFullscreen };
}

/** 前回の選択のうち、今のスペース（`windowId:sourceId`）のものだけを使う。スペースを持たない画面では印の無いものだけ。 */
export function selectionForScope<T extends { readonly scopeKey?: string }>(selection: T | undefined, scopeKey: string | undefined): T | undefined {
	return selection !== undefined && selection.scopeKey === scopeKey ? selection : undefined;
}
