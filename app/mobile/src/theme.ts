// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * デザイントークン。全画面で共有する。
 *
 * 値は Orca モバイル（`src/theme/mobile-theme.ts`）と作り直しのモック（concept-orca.html）に
 * 合わせている（2026-09-26）。方針:
 *  - 面は bg（#111111）→ panel（#1a1a1a）→ raised（#242424）の3段だけで作る
 *  - 色は状態を表すときだけ使う（要対応=赤、実行中=黄、未確認=緑、待機=灰）
 *  - 流れを先へ進める主ボタンは白地（primary）に黒文字。1画面に1つだけ置く
 *
 * 旧画面が使っている名前（`surface2` など）は残し、値だけを Orca に寄せた。
 * 新しく書く画面は Orca の呼び名（`raised`・`textMuted` など）を使う。
 */
export const colors = {
	/** 画面の地（Orca の bgBase）。ボトムシートの地もこれ。 */
	bg: '#111111',
	/** カード・一覧のまとまり・ヘッダーの帯（Orca の bgPanel）。 */
	panel: '#1a1a1a',
	/** 旧名。panel と同じ。 */
	surface: '#1a1a1a',
	/** 旧名。raised と同じ。 */
	surface2: '#242424',
	/** 押している間の地・キーを押した瞬間の地（モックの `.key:active`）。 */
	surface3: '#2a2a2a',
	/** panel の上に置く一段明るい面（入力欄・アイコンの台・押した行）。Orca の bgRaised。 */
	raised: '#242424',
	/** 境界線（Orca の borderSubtle）。 */
	border: '#2a2a2a',
	/** 選択中の枠など、border より目立たせたい線。 */
	borderStrong: '#3a3a3a',
	/** 本文（Orca の textPrimary）。 */
	text: '#e0e0e0',
	/** 補足・アイコンの既定（Orca の textSecondary）。 */
	textDim: '#a1a1a1',
	/** 注記・時刻・見出し・プレースホルダー（Orca の textMuted）。 */
	textMuted: '#8c8c8c',
	/** 旧名。本文より一段弱い文字。textDim と同じ。 */
	textSoft: '#a1a1a1',
	/** 選択中の印・リンク（Orca の accentBlue）。 */
	accent: '#3b82f6',
	/** 旧名。accent の濃い版（面塗り用）。 */
	accent2: '#2563eb',
	/** accent を薄く敷く地（検索の一致行など）。 */
	accentWash: 'rgba(59,130,246,0.12)',
	/** accent で塗った面の上の文字。 */
	onAccent: '#ffffff',
	/** 接続中・追加（Orca の statusGreen）。 */
	green: '#22c55e',
	/** エージェントの「未確認」（作業を終えてまだ人が見ていない）。Orca の AgentStateDot の done。 */
	emerald: '#10b981',
	/** エージェントの「実行中」の回転する輪。Orca の AgentSpinner の working。 */
	yellow: '#eab308',
	/** 接続中の手前（再接続中など）・注意（Orca の statusAmber）。 */
	amber: '#f59e0b',
	orange: '#d99a6c',
	/** 要対応・破壊的な操作・エラー（Orca の statusRed）。 */
	red: '#ef4444',
	/** 危険な面（赤）の上の文字。 */
	onRed: '#ffffff',
	purple: '#a78bfa',
	/** ソース管理の「変更」。 */
	mod: '#a1a1a1',
	/** 差分の追加行・ソース管理の「追加」（Orca の gitDecorationAdded）。 */
	add: '#81b88b',
	/** 差分の削除行（Orca の gitDecorationDeleted）。 */
	del: '#c74e39',
	addBg: 'rgba(129,184,139,0.1)',
	delBg: 'rgba(199,78,57,0.11)',
	claude: '#d97757',
	glassBg: 'rgba(28,28,32,0.6)',
	glassBorder: 'rgba(255,255,255,0.14)',
	attentionBg: 'rgba(36,20,20,0.92)',
	/** 状態を持たない（待機中など）アイコン。Orca の neutral-500。 */
	idle: '#737373',
	/** 待機中を表す点（idle を 40% に薄めたもの。Orca の AgentStateDot の idle）。 */
	idleDot: '#73737366',
	/** 白文字を載せる濃い赤の面（件数のバッジ・スワイプの削除）。 */
	redStrong: '#ef4444',
	/** ドロワー・サイドバーの地。 */
	sidebar: '#111111',
	/** 塗りの主ボタン（`primary`）の地と、その上の文字（Orca の surfaceBright / bgBase）。 */
	primary: '#f5f5f5',
	onPrimary: '#111111',
	/**
	 * 端末・コード表示。アプリの面とは別の系統として持つ。
	 * `terminalBg` は `src/components/termView.tsx` の `TERM_BG`（WebView の地色）と同じ値でなければ
	 * ならないので、ここだけ変えない（Orca は Tokyonight の #1a1b26。変えるなら両方を一緒に変える）。
	 */
	terminalBg: '#1e1e1e',
	terminalFg: '#d4d4d4',
	/** コード・ファイルのプレビューの地（Orca の editorSurface）。 */
	codeBg: '#1e1e1e',
	/** 画面を暗く覆う幕。 */
	scrim: 'rgba(0,0,0,0.5)',
	/** 浮いている面（シート・トースト）の影。 */
	shadow: '#000000',
} as const;

export const mono = { ios: 'Menlo', default: 'monospace' } as const;

/**
 * 文字サイズの段（Orca の 11 / 12 / 14 / 18 を軸にした段）。画面ごとに値を発明しない。
 *
 * 行の高さは `lineHeight` を別に持つ（本文 14 なら 20 前後）。固定サイズの枠（アバターの
 * 頭文字など）の中の文字は、この段ではなく枠の大きさから決めてよい。
 */
export const type = {
	/** 件数・状態のバッジなど、高さの決まった小さな枠の中だけで使う。 */
	badge: 10,
	/** 見出し（SectionHeader）・注記・時刻。 */
	caption: 11,
	/** 行の補足・説明・メタ情報。 */
	meta: 12,
	/** シートの小見出し・トースト・タブの名前。 */
	label: 13,
	/** 本文・行のタイトル・ボタン。 */
	body: 14,
	/** 入力欄・大きいボタン・PC の名前。 */
	input: 15,
	/** 空の状態の見出し・ダイアログの見出し。 */
	heading: 16,
	/** 会話の本文。 */
	chat: 17,
	/** 画面のタイトル。 */
	title: 18,
	/** 設定まわりの画面タイトル。 */
	large: 20,
	/** ホームの大見出し。 */
	hero: 24,
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
 * 角丸のランプ（Orca の radii: 行・ボタン・入力 6、カード 14、シートの上端 16）。
 * 役割ごとに1つの値を決めておき、画面ごとに数字を発明しない。
 *
 * 入れ子にするときは同心円則（外側の半径 − 余白 ＝ 内側の半径）で内側を決める。
 */
export const radius = {
	/** 丸ピル（チップ・バッジ・丸ボタン）。 */
	pill: 999,
	/** 一覧の行・押した行の地。 */
	row: 6,
	/** ボタン。 */
	button: 6,
	/** 入力欄。 */
	input: 6,
	/** 旧名。キー・タグ・行内の小さな枠。 */
	key: 6,
	/** 旧名。小さな操作要素（入力欄・セグメント・コード枠）。 */
	control: 6,
	/** 統計の小さなタイル。 */
	tile: 10,
	/** 行を束ねる面（設定の inset grouped・シートの選択肢の束）。 */
	group: 12,
	/** カード。 */
	card: 14,
	/** 旧名。カードを束ねる面・ポップオーバー。 */
	panel: 12,
	/** コンポーザー（入力バー）。 */
	composer: 14,
	/** ボトムシートの上端。 */
	sheet: 16,
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
 * 色は Orca の AgentSpinner / AgentStateDot と同じ: 要対応（赤）→ 実行中（黄、回転する輪）→
 * 未確認（緑）→ 待機（灰）。エラーも赤だが、要対応とはアイコン・文言で区別する。
 * 待機の「点」は `colors.idleDot`（40% に薄めた灰）で描く（`src/ui/statusColors.ts`）。
 */
export const status = {
	/** 許可待ち・質問など、人の操作を待っている。 */
	attention: { color: colors.red, label: '要対応' },
	running: { color: colors.yellow, label: '実行中' },
	/** 作業を終えて、まだ人が確認していない。 */
	review: { color: colors.emerald, label: '未確認' },
	idle: { color: colors.idle, label: '待機' },
	error: { color: colors.red, label: 'エラー' },
} as const;

export type StatusKey = keyof typeof status;
