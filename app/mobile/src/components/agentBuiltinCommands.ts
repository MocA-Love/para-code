// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisClaudeModelAlias } from '../../../../src/vs/paradis/contrib/mobileRelay/common/paradisClaudeModelAliases.js';
import type { AgentSlashCommand } from './agentSlashCommands.js';

/**
 * Claude Code の組み込みコマンドのうち、PC へそのまま送ると困るもの・この端末で済ませるものの扱い
 * （モック mobile-builtin-commands-mock.html の「コマンドの表」）。
 *
 * - `model-sheet` / `effort-sheet`: 引数なしで送ると PC に一覧が開く。送らずに、この端末のモデルのシートを開く
 * - `usage` / `status`: PC に画面が開き、閉じても会話に何も残らない。送らずに、この端末で開く
 * - `shows-result`: 結果がそのまま会話の知らせの行に出る（札だけ付ける）
 * - `opens-panel`: PC に画面が開く。候補に札を付け、手で打って送ったときは送る前に確かめる
 *
 * 表は Claude Code の版ごとに変わるので、札の先出しだけに使う。表に無いコマンドで画面が開いたときは、PC が mod で
 * 確かめて入力欄の上の帯を出す（agent.panel.v1）。
 */
export type AgentBuiltinCommandAction = 'model-sheet' | 'effort-sheet' | 'usage' | 'status' | 'shows-result' | 'opens-panel';

interface BuiltinCommandEntry {
	readonly action: AgentBuiltinCommandAction;
	/** 開く画面の名前（帯と確認の文に出す）。 */
	readonly title: string;
}

const CLAUDE_BUILTIN_COMMANDS: Readonly<Record<string, BuiltinCommandEntry>> = {
	'model': { action: 'model-sheet', title: 'モデルの選択' },
	'effort': { action: 'effort-sheet', title: 'effort の選択' },
	'usage': { action: 'usage', title: '使用量' },
	'status': { action: 'status', title: 'セッションの状態' },
	'context': { action: 'shows-result', title: 'コンテキストの使用量' },
	'btw': { action: 'shows-result', title: 'ひとこと質問' },
	'config': { action: 'opens-panel', title: '設定' },
	'resume': { action: 'opens-panel', title: '会話の再開' },
	'permissions': { action: 'opens-panel', title: '許可の設定' },
	'memory': { action: 'opens-panel', title: 'メモリ' },
	'hooks': { action: 'opens-panel', title: 'hook の設定' },
	'fast': { action: 'opens-panel', title: '高速モード' },
	'theme': { action: 'opens-panel', title: 'テーマ' },
	'tasks': { action: 'opens-panel', title: 'バックグラウンドのタスク' },
	'skills': { action: 'opens-panel', title: 'スキル' },
	'export': { action: 'opens-panel', title: '会話の書き出し' },
	'add-dir': { action: 'opens-panel', title: '作業フォルダの追加' },
	'help': { action: 'opens-panel', title: 'ヘルプ' },
	'plugin': { action: 'opens-panel', title: 'プラグイン' },
};

function builtinEntry(name: string): BuiltinCommandEntry | undefined {
	const key = name.toLocaleLowerCase();
	return Object.prototype.hasOwnProperty.call(CLAUDE_BUILTIN_COMMANDS, key) ? CLAUDE_BUILTIN_COMMANDS[key] : undefined;
}

/** `/effort <段階>` で受け付ける段階（モデルのシートの Effort の段と同じ。`auto` は既定に戻す）。 */
const CLAUDE_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

/**
 * 実際に動くのが組み込みのコマンドなら、その扱い。同じ名前が一覧にあれば上にある方が動くので、先に見つかった方が
 * 組み込みでなければ undefined（自作の `/status` などを横取りしない）。一覧にその名前が無いとき（取得前など）は
 * 組み込みとみなす。
 */
export function claudeBuiltinCommand(name: string, commands: readonly AgentSlashCommand[]): BuiltinCommandEntry | undefined {
	const key = name.toLocaleLowerCase();
	const entry = builtinEntry(key);
	if (entry === undefined) {
		return undefined;
	}
	const effective = commands.find(command => command.name.toLocaleLowerCase() === key);
	return effective === undefined || effective.source === 'built-in' ? entry : undefined;
}

/** 候補に添える札（黄は PC で画面が開く、青はこの端末で開く）。札の無いコマンドは undefined。 */
export function agentBuiltinCommandBadge(agent: string | undefined, command: AgentSlashCommand, commands: readonly AgentSlashCommand[]): { readonly label: string; readonly tone: 'pc' | 'local' | 'result' } | undefined {
	if (agent !== 'claude' || command.source !== 'built-in') {
		return undefined;
	}
	switch (claudeBuiltinCommand(command.name, commands)?.action) {
		case 'model-sheet':
		case 'effort-sheet': return { label: 'シートで選ぶ', tone: 'local' };
		case 'usage':
		case 'status': return { label: 'この端末で開く', tone: 'local' };
		case 'shows-result': return { label: '結果を表示', tone: 'result' };
		case 'opens-panel': return { label: 'PC で画面が開きます', tone: 'pc' };
		default: return undefined;
	}
}

/**
 * 送る前に入力欄が引き受ける操作（送らない・送り方を変える・確かめる）。undefined はそのまま送る。
 * - `model-sheet` / `effort-sheet`: 引数の無い `/model`・`/effort`。シートを開く
 * - `model-switch`: `/model <別名>`。確認を出さない経路（ピルと同じ）でモデルを変える
 * - `model-not-alias`: `/model <別名でない値>`。送らずに案内する（`/config` は別名しか受け付けず、`/model <値>` は確認の画面を出す）
 * - `effort-switch`: `/effort <段階>`。ピルと同じ経路で effort を変える
 * - `usage` / `status`: この端末で開く
 * - `confirm-panel`: PC で画面が開くコマンド。送る前に確かめる（候補から選んだものは確かめない）
 * - `codex-model`: Codex の `/model …`。この端末からは変えられないので、送らずに案内する（「文章として送る」で送れる）
 */
export type AgentComposerIntercept =
	| { readonly kind: 'model-sheet' }
	| { readonly kind: 'effort-sheet' }
	| { readonly kind: 'model-switch'; readonly alias: string }
	| { readonly kind: 'model-not-alias'; readonly value: string }
	| { readonly kind: 'effort-switch'; readonly level: string }
	| { readonly kind: 'usage' }
	| { readonly kind: 'status' }
	| { readonly kind: 'confirm-panel'; readonly command: string; readonly title: string }
	| { readonly kind: 'codex-model' };

/** 送る文の先頭のスラッシュコマンド（PC の paradisParseSlashCommand と同じ形）。 */
function parseSlash(text: string): { readonly name: string; readonly args: string } | undefined {
	const trimmed = text.trimStart();
	const match = /^\/([A-Za-z0-9_][A-Za-z0-9_.:-]{0,127})(?=\s|$)/.exec(trimmed);
	return match !== null ? { name: match[1]!, args: trimmed.slice(match[0].length).trim() } : undefined;
}

/**
 * 送る文を入力欄が引き受けるか決める。`pickedCommand` は候補から選んだコマンドの名前（札を見て選んだので確かめない）。
 * 添付のある文は引き受けない（画像を付けて送ったものはそのまま送る）。
 */
export function agentComposerIntercept(text: string, agent: string | undefined, commands: readonly AgentSlashCommand[], pickedCommand?: string): AgentComposerIntercept | undefined {
	const slash = parseSlash(text);
	if (slash === undefined) {
		return undefined;
	}
	const name = slash.name.toLocaleLowerCase();
	if (agent === 'codex') {
		return name === 'model' ? { kind: 'codex-model' } : undefined;
	}
	if (agent !== 'claude') {
		return undefined;
	}
	const entry = claudeBuiltinCommand(name, commands);
	switch (entry?.action) {
		case 'model-sheet': {
			if (slash.args.length === 0) {
				return { kind: 'model-sheet' };
			}
			const alias = paradisClaudeModelAlias(slash.args);
			return alias !== undefined ? { kind: 'model-switch', alias } : { kind: 'model-not-alias', value: slash.args.slice(0, 100) };
		}
		case 'effort-sheet': {
			if (slash.args.length === 0) {
				return { kind: 'effort-sheet' };
			}
			const level = slash.args.toLocaleLowerCase();
			return CLAUDE_EFFORT_LEVELS.includes(level) ? { kind: 'effort-switch', level } : undefined;
		}
		case 'usage': return { kind: 'usage' };
		case 'status': return { kind: 'status' };
		case 'opens-panel': return pickedCommand?.toLocaleLowerCase() === name ? undefined : { kind: 'confirm-panel', command: name, title: entry.title };
		default: return undefined;
	}
}

/** PC で開いている画面の帯に出す名前（`/config（設定）`。どのコマンドか分からなければ undefined）。 */
export function agentPanelLabel(command: string | undefined): string | undefined {
	if (command === undefined) {
		return undefined;
	}
	const title = builtinEntry(command)?.title;
	return title !== undefined ? `/${command}（${title}）` : `/${command}`;
}
