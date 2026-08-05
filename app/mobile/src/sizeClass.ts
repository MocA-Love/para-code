// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 画面の広さの区分（iPadOSのsize classに相当する自前の判定）。
 *
 * - `compact`: iPhone、およびiPadのSplit View/Slide Overで幅が狭いとき。
 *   従来どおり下部タブ＋スライド式ワークスペースドロワーの1カラム構成にする。
 * - `regular`: iPadを広い幅で使っているとき。ワークスペースドロワーを常設サイドバーへ、
 *   下部タブをそのサイドバー下部のセグメントへ移した2カラム構成にする。
 *
 * 判定を純関数として切り出しているのは、レイアウト分岐の条件をUIを起動せずに
 * テストできるようにするため（実機のiPad幅は端末ごとに違い、目視確認しづらい）。
 */
export type SizeClass = 'compact' | 'regular';

/**
 * サイドバー常設へ切り替える幅のしきい値（pt）。
 *
 * iPadの全画面時の短辺は最小でも744pt（iPad mini 6 のportrait）なので、
 * どのiPadでも全画面なら`regular`になる。一方Split Viewの1/2（11インチで507pt）や
 * Slide Over（約320pt）では下回り、iPhoneと同じ1カラムへ自然に落ちる。
 * サイドバー320pt＋本文400pt程度を確保できる下限としてこの値を選んでいる。
 */
export const REGULAR_WIDTH_THRESHOLD = 700;

/**
 * 幅とタブレット判定からsize classを決める。
 *
 * タブレットであることを条件に含めるのは、将来iPhoneの横向きを解禁したときに
 * Pro Maxの横幅（932pt）でサイドバーが出てしまうのを防ぐため。iPhoneはPCの
 * 画面を覗く「手元の窓」であって、2カラムを置く前提の画面サイズではない。
 */
export function sizeClassFor(width: number, tablet: boolean): SizeClass {
	return tablet && width >= REGULAR_WIDTH_THRESHOLD ? 'regular' : 'compact';
}
