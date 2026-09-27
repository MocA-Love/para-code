// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { useIsFocused, useNavigation, useRoute } from 'expo-router';
import { usePcRouteId } from '../../../src/features/pc/pcRouteContext.js';
import { PcScreen } from '../../../src/features/pc/pcScreen.js';
import { useIsRegularWidth } from '../../../src/hooks/useSizeClass.js';
import { DetailPlaceholder } from '../../../src/ipad/detailPlaceholder.js';
import { useDetailColumn, useDetailColumnKey } from '../../../src/ipad/detailColumn.js';

/**
 * 詳細の列の根（`/pc/[pcId]`）。
 *
 *  - 1列（iPhone、狭い iPad）: PC の画面（スペースとエージェントの一覧）を全面に出す。行を押すとセッションへ押し進む
 *  - iPad の2列: PC の画面は左の列（`_layout.tsx`）にあるので、ここは「エージェントが開かれていません」
 *
 * 2列の間は、詳細の列を根まで戻す手段と「何か開いているか」を `detailColumn.ts` に置く（左の列の行を押したとき
 * に開いていたものを閉じて入れ替える、左の列を隠すボタンを出す、に使う）。PC の画面が2枚積まれても混ざらない
 * よう、器（`_layout.tsx`）から受け取った印ごとに置く。
 */
export default function PcIndexRoute() {
	const regular = useIsRegularWidth();
	const navigation = useNavigation();
	const focused = useIsFocused();
	const pcId = usePcRouteId();
	const columnKey = useDetailColumnKey();
	// 置き直し（＝前面への並べ替え）を navigation の差し替えで起こさないよう、最新のものを参照で持つ。
	const navigationRef = useRef(navigation);
	navigationRef.current = navigation;
	const routeKey = useRoute().key;
	// 詳細の列を置くのは、列の Stack の一番下にある根だけ。万一この画面が上にもう1枚積まれても（PC の画面への
	// 行き先を push したなど）、同じ印で上書きして、閉じるときに列の様子ごと消すことが無いようにする。
	const isColumnBase = (): boolean => navigationRef.current.getState()?.routes[0]?.key === routeKey;

	useEffect(() => {
		if (!regular || pcId === undefined || columnKey === undefined || !isColumnBase()) {
			return;
		}
		return useDetailColumn.getState().attach(columnKey, pcId, () => {
			// この画面の navigation は詳細の列の Stack のもの。根だけのときに POP_TO_TOP を送ると、処理できずに
			// 親（ルートの Stack）へ伝わって PC の画面ごと閉じてしまうので、積んであるときだけ送る。
			const current = navigationRef.current;
			const stacked = current.getState()?.routes;
			if (stacked !== undefined && stacked.length > 1) {
				current.dispatch({ type: 'POP_TO_TOP' });
			}
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- isColumnBase は ref とルートの key だけを読む
	}, [regular, pcId, columnKey]);

	useEffect(() => {
		if (columnKey !== undefined && isColumnBase()) {
			useDetailColumn.getState().setOpen(columnKey, !focused);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- isColumnBase は ref とルートの key だけを読む
	}, [columnKey, focused, regular]);

	return regular ? <DetailPlaceholder /> : <PcScreen placement="page" />;
}
