// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** モックアップ (mock-2.html、案A「Aftermath」) のデザイントークン。全画面で共有する。 */
export const colors = {
	bg: '#050506',
	panel: '#131316',
	surface: '#131316',
	surface2: '#1c1c20',
	surface3: '#232328',
	border: 'rgba(255,255,255,0.08)',
	borderStrong: 'rgba(255,255,255,0.16)',
	text: '#f0f0f2',
	textDim: '#8a8a92',
	// PC版のブランドプライマリカラー（paradisDefaultSettings.contribution.ts の #09AFD9）と統一。
	// accent2 はPC版ライトテーマ用の濃い版 #0598BD をボタン等の面塗りに流用する。
	accent: '#09AFD9',
	accent2: '#0598BD',
	accentWash: 'rgba(9,175,217,0.14)',
	green: '#4fd1a5',
	yellow: '#e0c07d',
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
} as const;

export const mono = { ios: 'Menlo', default: 'monospace' } as const;
