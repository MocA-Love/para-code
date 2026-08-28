// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { PresetDef } from './store.js';

/**
 * コマンドプリセット（PC版のターミナルタブバー右のボタンと同じもの）を、スマホの一覧に
 * 載せるための決め事。定義そのものはPCが持ち、この端末が決めるのは「どれを出すか」と
 * 「実行してよいと一度でも言ったか」だけ。
 */

/**
 * 承認の記録に使う鍵。
 *
 * 中身から自前で作らず、**PCが出した署名をそのまま使う**。ここに届く tasks は表示のために
 * 切り詰められている（タスク数・コマンド数・1コマンドの長さ）ので、この形から署名を作ると
 * 「シートに出ていない部分の書き換え」を見抜けず、一度承認したプリセットが別物のまま
 * 走ってしまう。PC側は完全な定義（作業ディレクトリも含む）から署名を作り、実行の直前に
 * 作り直して突き合わせる。
 *
 * key を混ぜるのは、PCの署名が内容だけから作られるため。同じコマンドの別プリセットを
 * 承認したときに、名前の違うもう一方まで承認済みになるのを避ける。
 */
export function presetApprovalKey(preset: PresetDef): string {
	return `${preset.key}\n${preset.signature}`;
}

/**
 * PCから届いた1件が、表示と実行に必要な形をしているか。
 * 通信相手は自分のPCだが、壊れた1件で一覧全体が落ちる（tasks.map で例外）のは避ける。
 */
export function isValidPresetDef(value: unknown): value is PresetDef {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<PresetDef>;
	return typeof candidate.key === 'string' && candidate.key.length > 0
		&& typeof candidate.name === 'string'
		&& typeof candidate.signature === 'string' && candidate.signature.length > 0
		&& (candidate.source === 'user' || candidate.source === 'workspace')
		&& (candidate.layout === 'tabs' || candidate.layout === 'split' || candidate.layout === 'current' || candidate.layout === 'smart')
		&& Array.isArray(candidate.tasks)
		&& candidate.tasks.every(task => typeof task === 'object' && task !== null
			&& Array.isArray(task.commands) && task.commands.every(command => typeof command === 'string'));
}

/** この端末で非表示にしたものを除いた一覧（順序はPC側の定義順のまま）。 */
export function visiblePresets(presets: readonly PresetDef[], hidden: ReadonlySet<string>): PresetDef[] {
	return presets.filter(preset => !hidden.has(preset.key));
}

/** 一覧・確認ダイアログに出す1行のコマンド要約。 */
export function presetCommandSummary(preset: PresetDef): string {
	return preset.tasks.flatMap(task => task.commands).join(' ／ ');
}

/**
 * そのプリセットがPC側でいくつのターミナルを作るか。current は既存の端末へ送る指定なので1つ。
 * smart もPC側では既存端末が空いていればそこへ送るが、モバイルからの実行は常に
 * forceNewTerminal: true（新規1本）なので、こちらも1つ扱いでよい。
 */
export function presetTerminalCount(preset: PresetDef): number {
	return (preset.layout === 'current' || preset.layout === 'smart') ? 1 : Math.max(preset.tasks.length, 1);
}

/**
 * PC側の codicon 名を、見た目が近い Ionicons へ寄せる。対応表に無いものは雷（既定のプリセット）。
 * 完全一致を狙わない: プリセットの見分けは名前が担っていて、アイコンは並びの中で目印になれば足りる。
 */
const ICON_MAP: Record<string, string> = {
	rocket: 'rocket-outline',
	play: 'play',
	'play-circle': 'play-circle-outline',
	'debug-start': 'play-circle-outline',
	run: 'play',
	'run-all': 'play-forward-outline',
	terminal: 'terminal-outline',
	'terminal-bash': 'terminal-outline',
	'server-process': 'server-outline',
	server: 'server-outline',
	database: 'server-outline',
	beaker: 'flask-outline',
	bug: 'bug-outline',
	package: 'cube-outline',
	archive: 'cube-outline',
	cloud: 'cloud-outline',
	'cloud-upload': 'cloud-upload-outline',
	'cloud-download': 'cloud-download-outline',
	sync: 'sync-outline',
	refresh: 'refresh-outline',
	trash: 'trash-outline',
	'clear-all': 'trash-outline',
	tools: 'construct-outline',
	gear: 'settings-outline',
	settings: 'settings-outline',
	flame: 'flame-outline',
	zap: 'flash-outline',
	globe: 'globe-outline',
	book: 'book-outline',
	'file-code': 'document-text-outline',
	'source-control': 'git-branch-outline',
	'git-branch': 'git-branch-outline',
	check: 'checkmark-circle-outline',
	search: 'search-outline',
	eye: 'eye-outline',
	watch: 'timer-outline',
	dashboard: 'speedometer-outline',
};

export function presetIonicon(icon: string | undefined): string {
	if (icon === undefined) {
		return 'flash-outline';
	}
	// 設定には `$(rocket)` の書き方で入っていることがある（PC側のラベル記法）。
	const name = icon.replace(/^\$\(/, '').replace(/\)$/, '').trim();
	return ICON_MAP[name] ?? 'flash-outline';
}
