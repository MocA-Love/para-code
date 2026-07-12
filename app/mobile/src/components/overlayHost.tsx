// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment, ReactNode, useEffect, useId, useReducer } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * ルート常駐のオーバーレイ基盤（Portal）。RN標準のModal（fade）はネイティブ側で
 * コンテナ全体のopacityをアニメーションさせるため、Liquid Glass（GlassView）の
 * 「祖先のopacityが変わると効果ごと消える」制約（expo/expo#41024）と両立しない。
 * そこでModalに頼らず、常時マウントされたViewツリー内のOverlayHostへ
 * OverlayPortal経由でコンテンツを描画する。glass対応のメニュー/ダイアログは
 * 今後もこの基盤に載せること（Modal内にGlassSurfaceを置かない）。
 *
 * OverlayHostはAuthGateの内側にマウントすること（再ロック時にオーバーレイが
 * ロック画面より上に残らないように）。
 *
 * 注意: childrenは呼び出し元ではなくOverlayHost側のツリーで描画されるため、
 * 呼び出し元のReact Context（Provider）は継承されない。テーマ等は
 * moduleインポート（theme.ts）やzustandストア経由で参照すること。
 */

const entries = new Map<string, ReactNode>();
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
}

/** ルートレイアウトに1つだけ置く描画先。何も登録されていない間は何も描画しない。 */
export function OverlayHost() {
	const [, force] = useReducer((c: number) => c + 1, 0);
	useEffect(() => {
		listeners.add(force);
		// ホストのマウント前にPortal側が先に登録を済ませていた場合に取りこぼさない
		force();
		return () => { listeners.delete(force); };
	}, []);
	if (entries.size === 0) {
		return null;
	}
	return (
		<View style={StyleSheet.absoluteFill} pointerEvents="box-none">
			{[...entries.entries()].map(([key, node]) => <Fragment key={key}>{node}</Fragment>)}
		</View>
	);
}

/** childrenをその場ではなくOverlayHostへ描画する。マウント中のみ表示される。 */
export function OverlayPortal({ children }: { children: ReactNode }) {
	const key = useId();
	// 毎レンダー後に最新のchildrenへ差し替える（依存配列なしは意図的）
	useEffect(() => {
		entries.set(key, children);
		notify();
	});
	useEffect(() => () => {
		entries.delete(key);
		notify();
	}, [key]);
	return null;
}
