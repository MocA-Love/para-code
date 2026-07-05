// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** モックアップ (app/design/mobile.html) のデザイントークン。全画面で共有する。 */
export const colors = {
	bg: '#0d1117',
	panel: '#161b22',
	surface: '#252526',
	surface2: '#2d2d30',
	border: '#3c3c3c',
	text: '#cccccc',
	textDim: '#8b8b8b',
	accent: '#4fc3f7',
	accent2: '#007acc',
	green: '#4ec9b0',
	yellow: '#dcdcaa',
	orange: '#ce9178',
	red: '#f48771',
	purple: '#c586c0',
	mod: '#e2c08d',
	add: '#81c995',
	del: '#f28b82',
	claude: '#d97757',
} as const;

export const mono = { ios: 'Menlo', default: 'monospace' } as const;
