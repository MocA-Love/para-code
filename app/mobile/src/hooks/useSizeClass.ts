// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useSyncExternalStore } from 'react';
import { Dimensions, Platform } from 'react-native';
import { sizeClassFor, sizeClassForWithHysteresis, type SizeClass } from '../sizeClass.js';

/**
 * このデバイスがタブレットか（iPadのみ対象。Androidタブレットは未検証のため含めない）。
 * 端末固有の値なので毎回同じ結果になり、フックの外で1度だけ解決してよい。
 */
const tablet = Platform.OS === 'ios' && Platform.isPad === true;

/**
 * 現在の判定（幅とsize class）。**モジュール単位の単一ソース**にする。
 *
 * Split View の分割線ドラッグは700pt前後を往復する。ここを跨ぐたびに
 * `regular ? <Tabs> : <NativeTabs>` のナビゲータ型が入れ替わると、(tabs) 配下が
 * 丸ごと再マウントされて TermView の WebView が破壊され、スクロール位置や入力途中の
 * 文字が消える。そこで `sizeClassForWithHysteresis` によるラッチを**この1箇所だけ**で
 * 持つ——呼び出しごとに独立した ref ラッチを持つと、境界幅で画面ごとに判定が割れて
 * 「サイドバー=regular / タブバー=compact」の不整合が起きるため。
 *
 * 更新は `useWindowDimensions` の購読経路ではなく `Dimensions` イベントで行う。
 * 各コンポーネントの再レンダーは `useSyncExternalStore` の同値比較で駆動する
 * （size class が実際に変わったときだけ全購読者が更新される）。
 */
let current: SizeClass = (() => {
	const initial = Dimensions.get('window');
	return sizeClassFor(initial.width, tablet);
})();

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

function applyWidth(width: number): void {
	const next = sizeClassForWithHysteresis(current, width, tablet);
	if (next === current) {
		return;
	}
	current = next;
	for (const listener of [...listeners]) {
		listener();
	}
}

// 幅変更の一元的な受け口。Split View 分割線ドラッグ中は高頻度で発火するが、
// 中身は「閾値を跨いだか」の比較だけなので安い。
Dimensions.addEventListener('change', event => {
	applyWidth(event.window.width);
});

/** 現在のsize class。Split View/Slide Overの幅変更や回転にも追従し、**ヒステリシス付き**
 * （700pt前後の往復ドラッグでは regular を維持する。sizeClass.ts の解除閾値参照）。 */
export function useSizeClass(): SizeClass {
	return useSyncExternalStore(subscribe, () => current);
}

/** サイドバー常設の2カラム表示中かどうか（`useSizeClass() === 'regular'` の読みやすい別名）。 */
export function useIsRegularWidth(): boolean {
	return useSizeClass() === 'regular';
}
