// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * iPad の2列（左に PC の画面、右にセッション）と右のドックの寸法。実機を起動せずに詰められるよう、
 * 幅の計算だけをここに純関数として切り出している（`ipadLayout.test.ts`）。
 *
 * 寸法は Orca モバイルの iPad（`app/h/_layout.tsx` のサイドバー、`use-mobile-session-panel-route-actions.tsx`
 * のドック）に合わせている。
 */

/** 左の列（PC の画面）の幅の下限・上限・既定（pt）。右の縁をドラッグして変え、離すと保存する。 */
export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 340;

/** 右のドック（ソース管理・ファイル・メモ）の幅の下限・上限・既定（pt）。左の縁をドラッグして変える。 */
export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 560;
export const DOCK_DEFAULT_WIDTH = 340;
/** ドックを置いたとき、会話やターミナルの側に最低限残す幅（pt）。 */
export const DOCK_MIN_MAIN_WIDTH = 360;
/** 詳細の列がこの幅以上ならドックを置ける（ドックの下限 ＋ 本体の下限 = 640pt。Orca の canDockSessionPanel）。 */
export const DOCK_THRESHOLD = DOCK_MIN_WIDTH + DOCK_MIN_MAIN_WIDTH;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** 左の列の幅を許される範囲に丸める（保存済みの壊れた値・古い値からの復帰にも使う）。 */
export function clampSidebarWidth(width: number): number {
	return Number.isFinite(width) ? Math.round(clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)) : SIDEBAR_DEFAULT_WIDTH;
}

/** 左の列を広げても、詳細の列に最低限残す幅（pt）。 */
export const DETAIL_MIN_WIDTH = 320;

/**
 * いま使う左の列の幅。保存した幅を 280〜560 に収めたうえで、器（2列全体）が狭いときは詳細の列に 320pt
 * 残るよう頭を押さえる（縦向きで 560 に広げたままでも、右の列が潰れないように）。下限の 280 は割らない。
 * 器の幅がまだ測れていない（0）ときは保存した幅のまま。
 */
export function sidebarWidthFor(saved: number, containerWidth: number): number {
	const base = clampSidebarWidth(saved);
	if (containerWidth <= 0) {
		return base;
	}
	return Math.max(SIDEBAR_MIN_WIDTH, Math.min(base, Math.round(containerWidth - DETAIL_MIN_WIDTH)));
}

/**
 * ソース管理・ファイル・メモをセッションの右にドックできるか。
 * 2列の表示（`regular`）で、詳細の列（セッション画面の幅）が 640pt 以上のときだけ。
 * 足りなければ詳細の列の中で押し進める。
 */
export function canDockPanel(regular: boolean, detailWidth: number): boolean {
	return regular && detailWidth >= DOCK_THRESHOLD;
}

/**
 * ドックの幅。保存した幅を 280〜560 に丸めたうえで、本体に 360pt 残るよう詳細の列の幅で頭を押さえる。
 * 詳細の列が狭くて下限すら入らないときは下限を返す（そもそもドックしない。`canDockPanel` で判定する）。
 */
export function dockWidthFor(saved: number, detailWidth: number): number {
	const base = Number.isFinite(saved) ? clamp(saved, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH) : DOCK_DEFAULT_WIDTH;
	const roomy = Math.max(DOCK_MIN_WIDTH, detailWidth - DOCK_MIN_MAIN_WIDTH);
	return Math.round(Math.min(base, roomy));
}

/**
 * 本文（チャット・記事的なコンテンツ）の最大読み幅。広いiPadで1行が長くなりすぎると
 * 目線の戻りが大きく読みづらいため、中央寄せで列幅を制限する。
 * ターミナルやdiffなど「広いほど良い」ものには適用しない。
 */
export const CONTENT_MAX_WIDTH = 760;

/**
 * 一覧を何列で並べるか。行の情報量が多い（タイトル＋スペース＋ブランチ＋状態）ため、
 * 1列あたり最低でもこの幅を確保できるときだけ2列にする。
 */
const MIN_COLUMN_WIDTH = 420;

export function listColumnsFor(contentWidth: number): 1 | 2 {
	return contentWidth >= MIN_COLUMN_WIDTH * 2 ? 2 : 1;
}

/** 使用量の画面で Claude と Codex を左右に並べるときの、列と列の間。 */
export const USAGE_PROVIDER_COLUMN_GAP = 16;

/** 使用量の画面で Claude と Codex を左右に並べるときの、1列の最小の幅（メーター2つとリセットの1行が収まる幅）。 */
const USAGE_PROVIDER_MIN_COLUMN_WIDTH = 300;

/**
 * 使用量の画面の Claude と Codex を何列で並べるか。2列の表示（`regular`）で、本文の実際の幅（onLayout。
 * ウィンドウ幅ではない）に2列が収まるときだけ左右に並べる。幅をまだ測っていない（0）ときは1列。
 */
export function usageProviderColumnsFor(regular: boolean, contentWidth: number): 1 | 2 {
	return regular && contentWidth >= USAGE_PROVIDER_MIN_COLUMN_WIDTH * 2 + USAGE_PROVIDER_COLUMN_GAP ? 2 : 1;
}

/**
 * 質問のカードの中身がこの幅以上なら、選択肢と preview を左右に並べる（左に選択肢、右に preview）。
 * 選択肢の列 2 : preview の列 3 で、preview の枠に等幅 30 字ほどが入る幅。
 */
export const QUESTION_PREVIEW_SPLIT_MIN_WIDTH = 520;

/**
 * 質問のカードで選択肢と preview を左右に並べるか。2列の表示（`regular`）で、カードの実際の幅（onLayout。ウィンドウ幅ではない）が
 * 足りるときだけ。幅をまだ測っていない（0）ときは並べない。
 */
export function questionPreviewSplit(regular: boolean, cardWidth: number): boolean {
	return regular && cardWidth >= QUESTION_PREVIEW_SPLIT_MIN_WIDTH;
}
