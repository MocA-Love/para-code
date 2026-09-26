// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * デザイントークン。全画面で共有する。
 *
 * 方針（2026-09、Orca の STYLEGUIDE を参考にした「静かな配色」）:
 *  - 面は bg → surface → surface2/3 の段だけで作り、色は状態を表すときだけ使う
 *  - accent（水色）は選択中の印・リンクなど「今どこか」を示すものに限る
 *  - 流れを先へ進める主ボタンは白地（primary）に黒文字。1画面に1つだけ置く
 * OS が描くタブバー・ナビバーのガラスは対象外（純正部品の見た目に合わせる）。
 */
export const colors = {
	bg: '#0b0b0c',
	panel: '#151517',
	surface: '#151517',
	surface2: '#1e1e21',
	surface3: '#28282c',
	border: 'rgba(255,255,255,0.08)',
	borderStrong: 'rgba(255,255,255,0.16)',
	text: '#ececef',
	textDim: '#8e8e96',
	// PC版のブランドプライマリカラー（paradisDefaultSettings.contribution.ts の #09AFD9）と統一。
	// accent2 はPC版ライトテーマ用の濃い版 #0598BD をボタン等の面塗りに流用する。
	accent: '#09AFD9',
	accent2: '#0598BD',
	accentWash: 'rgba(9,175,217,0.14)',
	green: '#4fd1a5',
	yellow: '#e0c07d',
	/** 実行中を示す琥珀。 */
	amber: '#e0b04d',
	orange: '#d99a6c',
	red: '#f47272',
	purple: '#c193d9',
	mod: '#e0c07d',
	add: '#4fd1a5',
	del: '#f47272',
	claude: '#d97757',
	glassBg: 'rgba(28,28,32,0.6)',
	glassBorder: 'rgba(255,255,255,0.14)',
	attentionBg: 'rgba(36,20,20,0.92)',
	/** 本文より一段弱い文字（コード本文・補足の本文など）。中間グレーを画面ごとに発明しない。 */
	textSoft: '#b0b0b8',
	/** 状態を持たない（待機中など）点・アイコン。 */
	idle: '#6e7681',
	/** 白文字を載せる濃い赤の面（タブのバッジ・スワイプの削除）。 */
	redStrong: '#c0413f',
	/** ドロワー・サイドバーの地。bg と surface の間。 */
	sidebar: '#101012',
	/** 塗りの主ボタン（`primary`）の地と、その上の文字。 */
	primary: '#f5f5f7',
	onPrimary: '#0b0b0c',
	/** 端末・コード表示。アプリの面とは別の系統として持つ。 */
	terminalBg: '#1e1e1e',
	terminalFg: '#d4d4d4',
	codeBg: '#161b22',
	/** 画面を暗く覆う幕。 */
	scrim: 'rgba(0,0,0,0.5)',
} as const;

export const mono = { ios: 'Menlo', default: 'monospace' } as const;

/**
 * 文字サイズの段。画面ごとに 0.5 刻みの値を発明しない。
 *
 * 行の高さは `lineHeight` を別に持つ（本文 14 なら 20 前後）。固定サイズの枠（アバターの
 * 頭文字など）の中の文字は、この段ではなく枠の大きさから決めてよい。
 */
export const type = {
	/** 件数・状態のバッジなど、高さの決まった小さな枠の中だけで使う。 */
	badge: 10,
	/** 注記・時刻・メタ情報。 */
	caption: 11,
	/** 行の補足・説明・ボタンより小さい操作。 */
	meta: 12,
	/** 本文・行のタイトル・ボタン。 */
	body: 14,
	/** 画面・シートのタイトル。 */
	title: 16,
	/** 数値の見出し（KPI）・ダイアログの大見出し。 */
	large: 20,
	/** ペアリングの確認コードのような、1画面1つの表示用。 */
	display: 44,
} as const;

/** 余白の段。新しく書く部品はこの値を使う。 */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** 指で押す要素の当たり判定の最小値（Apple HIG）。見た目が小さい場合は hitSlop で補う。 */
export const HIT_SIZE = 44;

/**
 * 色に重ねる不透明度の段。`withAlpha(colors.red, alpha.wash)` のように使い、
 * .12/.14/.16 のような近い値を画面ごとに作らない。
 */
export const alpha = {
	/** 面の上にうっすら敷く（押せる領域の地など）。 */
	faint: 0.06,
	/** 選択中・状態の色被せ。 */
	wash: 0.14,
	/** 色付きの枠線。 */
	line: 0.3,
	/** 強い色被せ（開いている状態の枠など）。 */
	strong: 0.5,
} as const;

/**
 * 角丸のランプ。役割ごとに1つの値を決めておき、画面ごとに数字を発明しない。
 *
 * 入れ子にするときは同心円則（外側の半径 − 余白 ＝ 内側の半径）で内側を決める。
 * 例: card(14) の中に padding 4 で入るチップなら 10（= control）。
 */
export const radius = {
	/** 丸ピル（チップ・バッジ・丸ボタン）。 */
	pill: 999,
	/** キー・タグ・行内の小さな枠。 */
	key: 6,
	/** 小さな操作要素（入力欄・セグメント・コード枠）。 */
	control: 10,
	/** 一覧の行・カード。 */
	card: 14,
	/** カードを束ねる面・ポップオーバー。 */
	panel: 20,
	/** コンポーザー（入力バー）。 */
	composer: 26,
	/** ボトムシートの上端。 */
	sheet: 28,
} as const;

/**
 * iOSの連続曲率（squircle）。iOS 26のガラス面とシステム部品は全てこれで描かれるため、
 * 角丸を指定するスタイルには必ず併せて当てる（単純な円弧だと曲がり始めが食い違い、
 * 純正部品と並べたときに「別のOSの部品」に見える）。
 */
export const squircle = { borderCurve: 'continuous' } as const;

/**
 * 色に不透明度を足して `#RRGGBBAA` にする。
 *
 * 呼び出し側で `color + '33'` のように桁を連結すると、二重に足されたときに
 * `#RRGGBBAAAA` という無効色になる（RNの正規化は null を返し、警告も出ないまま
 * `StyleSheet.flatten` の後勝ちで下地ごと消える）。不透明度は必ずこの関数を通すこと。
 *
 * hex以外（`rgba()`・色名など）に不透明度は足しようがないので `undefined` を返す。
 * ワークスペース色はPCから任意の文字列で届くため、ここで不透明のまま通すと
 * 意図せず全面がその色に染まる。
 */
export function withAlpha(color: string, opacity: number): string | undefined {
	if (opacity >= 1) {
		return color;
	}
	const expanded = /^#[0-9a-fA-F]{3}$/.test(color)
		? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
		: color;
	if (!/^#[0-9a-fA-F]{6}$/.test(expanded)) {
		return undefined;
	}
	const value = Math.round(Math.max(0, opacity) * 255);
	return expanded + value.toString(16).padStart(2, '0');
}

export type ThemeColor = (typeof colors)[keyof typeof colors];

/**
 * テーマの色（`colors.*` の hex）に不透明度を足す。`withAlpha` と違い必ず文字列を返すので、
 * `string` を要求するprops（アイコンの color 等）にもそのまま渡せる。
 *
 * PCから届くワークスペース色のような任意の文字列には使わない（`withAlpha` を使い、
 * undefined を受け止めること）。型でテーマの値だけに絞っている。
 */
export function tint(color: ThemeColor, opacity: number): string {
	return withAlpha(color, opacity) ?? color;
}

/**
 * エージェントの状態と、その色・呼び名の対応。状態の表現はここだけで決め、
 * 画面ごとに色や文言を割り当てない（判定は `src/agentStatus.ts`）。
 *
 * 色は「人が何かすべきか」の順に強くする: 要対応（赤）→ 実行中（琥珀）→ 完了・未確認（緑）→ 待機（灰）。
 * エラーも赤だが、要対応とはアイコン・文言で区別する。
 */
export const status = {
	/** 許可待ち・質問など、人の操作を待っている。 */
	attention: { color: colors.red, label: '要対応' },
	running: { color: colors.amber, label: '実行中' },
	/** 作業を終えて、まだ人が確認していない。 */
	review: { color: colors.green, label: '未確認' },
	idle: { color: colors.idle, label: '待機' },
	error: { color: colors.red, label: 'エラー' },
} as const;

export type StatusKey = keyof typeof status;
