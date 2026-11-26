/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントを起動したときの環境変数とフラグの控え（会話ごと）。
//
// Claude Code と Codex は、起動時に付けた環境変数とフラグを hook にも会話の記録にも残さない（2026-11 に実測）。
// 何もしないと、セッション履歴・スマホ・再開の帯からの再開は、それらの無い素の起動になる。そこで、ペインで
// エージェントが起動されたときに、下の許可リストに載っているものだけを会話ごとに控え、再開のコマンドに付け直す。
//
// 控えるのは名前を 1 つずつ挙げた許可リストだけ。鍵・トークン・URL・パスは控えない。値は引用の要らない文字だけを
// 受け、台帳や接続先から来た値は組み立ての直前にもここで確かめ直す。

import { IParadisAgentPaneSession, ParadisAgentSessionStartSource } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisAgentOptionTakesValue, paradisInteractiveAgentCommand, paradisShellWords } from '../../mobileRelay/common/paradisAgentCliCommand.js';

/** 控える対象のエージェント。 */
export type ParadisLaunchAgent = 'claude' | 'codex';

/** 会話ごとの控え。`flags` のキーは正規化した長い名前で、値を取らないフラグは `true`。 */
export interface IParadisAgentLaunchProfile {
	readonly env: Readonly<Record<string, string>>;
	readonly flags: Readonly<Record<string, string | true>>;
}

/** 名前にこれを含む環境変数は、許可リストに載っていても控えない（二重の網）。 */
const SECRET_NAME_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE/;

/** 控える環境変数の値（引用の要らない文字だけ。パスと URL は入らない）。 */
const ENV_VALUE_PATTERN = /^[A-Za-z0-9._:,+-]{1,128}$/;

/**
 * 控えるフラグの値（モデル名・エフォート・プロファイル名）。`[` `]` は `opus[1m]` のため（zsh は glob に読むので、
 * 付け直すときに引用する）。先頭は英数だけ（オプションや Git Bash のパス変換に読ませない）。
 */
const FLAG_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/;

/** 1 つの会話に控える環境変数の数の上限。 */
const MAX_ENV_ENTRIES = 32;

/**
 * 控える Claude Code の環境変数（機能の切り替えとモデル・エフォートの指定）。Claude Code 2.1.332 のバイナリにある
 * `CLAUDE_CODE_*` から、秘密・パス・URL・CLI が自分で付けるもの（`CLAUDE_CODE_SESSION_ID`・`CLAUDE_CODE_ENTRYPOINT`・
 * `CLAUDE_CODE_SSE_PORT` など。付け直すと壊れる）を除いて選んだ。
 */
const CLAUDE_ENV_NAMES: ReadonlySet<string> = new Set([
	'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS',
	'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL',
	'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
	'CLAUDE_CODE_EFFORT_LEVEL',
	'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
	'CLAUDE_CODE_SUBAGENT_MODEL',
	'CLAUDE_CODE_SUBAGENT_EFFORT',
	'CLAUDE_CODE_DISABLE_1M_CONTEXT',
	'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
	'CLAUDE_CODE_DISABLE_THINKING',
	'CLAUDE_CODE_DISABLE_FAST_MODE',
	'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
	'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
	'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
	'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
	'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'CLAUDE_CODE_USE_FOUNDRY',
	'CLAUDE_CODE_NO_FLICKER',
	'CLAUDE_CODE_SIMPLE',
]);

/** この接頭辞の Claude Code の環境変数（実験的な機能の切り替え）は、{@link CLAUDE_ENV_EXCLUDED} 以外を控える。 */
const CLAUDE_ENV_PREFIX = 'CLAUDE_CODE_EXPERIMENTAL_';

/**
 * 接頭辞に当たっても控えないもの。Code Mode は会話の記録から判定して `--settings` で付ける
 * （`PARADIS_CLAUDE_CODE_MODE_RESUME_SETTINGS`）ので、ここでは重ねない。残りは CLI が自分で付ける。
 */
const CLAUDE_ENV_EXCLUDED: ReadonlySet<string> = new Set([
	'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE',
	'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE_RESTART',
	'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE_RESTARTED_FROM',
]);

/**
 * 控える Codex の環境変数。Codex 0.171.0 のバイナリにある `CODEX_*` は、ほとんどが鍵・URL・CLI が自分で付けるもの
 * （`CODEX_THREAD_ID`・`CODEX_SANDBOX` など）で、`CODEX_HOME` は Codex のアカウント切替が別に持つ。
 */
const CODEX_ENV_NAMES: ReadonlySet<string> = new Set([
	'CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS',
]);

interface IFlagSpec {
	/** 控えるときの名前（長い形）。 */
	readonly canonical: string;
	readonly takesValue: boolean;
}

const CLAUDE_FLAGS: ReadonlyMap<string, IFlagSpec> = new Map<string, IFlagSpec>([
	['--dangerously-skip-permissions', { canonical: '--dangerously-skip-permissions', takesValue: false }],
	['--allow-dangerously-skip-permissions', { canonical: '--allow-dangerously-skip-permissions', takesValue: false }],
	['--model', { canonical: '--model', takesValue: true }],
	['--effort', { canonical: '--effort', takesValue: true }],
]);

const CODEX_FLAGS: ReadonlyMap<string, IFlagSpec> = new Map<string, IFlagSpec>([
	['--dangerously-bypass-approvals-and-sandbox', { canonical: '--dangerously-bypass-approvals-and-sandbox', takesValue: false }],
	['--yolo', { canonical: '--dangerously-bypass-approvals-and-sandbox', takesValue: false }],
	['--model', { canonical: '--model', takesValue: true }],
	['-m', { canonical: '--model', takesValue: true }],
	['--profile', { canonical: '--profile', takesValue: true }],
	['-p', { canonical: '--profile', takesValue: true }],
]);

/** 付け直すときの並び（正規化した名前）。権限の確認を省くフラグは、再開のコマンドの権限の指定に写すので入れない。 */
const CLAUDE_RENDERED_FLAGS = ['--allow-dangerously-skip-permissions', '--model', '--effort'] as const;
const CODEX_RENDERED_FLAGS = ['--model', '--profile'] as const;

/** 権限の確認を省くフラグ（正規化した名前）。 */
export const PARADIS_LAUNCH_BYPASS_FLAG: Readonly<Record<ParadisLaunchAgent, string>> = {
	claude: '--dangerously-skip-permissions',
	codex: '--dangerously-bypass-approvals-and-sandbox',
};

/** 権限を広げる控え。会話を始めた起動（新規・分岐）に付いていたときだけ控える（再開の起動からは控えない）。 */
const PERMISSION_WIDENING_FLAGS: ReadonlySet<string> = new Set([
	'--dangerously-skip-permissions',
	'--allow-dangerously-skip-permissions',
	'--dangerously-bypass-approvals-and-sandbox',
]);
const PERMISSION_WIDENING_ENV: ReadonlySet<string> = new Set([
	'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS',
]);

export function paradisIsLaunchAgent(agent: unknown): agent is ParadisLaunchAgent {
	return agent === 'claude' || agent === 'codex';
}

/** 控えてよい環境変数の名前か。 */
export function paradisIsAllowedLaunchEnvName(agent: ParadisLaunchAgent, name: string): boolean {
	if (SECRET_NAME_PATTERN.test(name)) {
		return false;
	}
	if (agent === 'codex') {
		return CODEX_ENV_NAMES.has(name);
	}
	return CLAUDE_ENV_NAMES.has(name) || (name.startsWith(CLAUDE_ENV_PREFIX) && /^[A-Z0-9_]{1,96}$/.test(name) && !CLAUDE_ENV_EXCLUDED.has(name));
}

/** 許可リストの一覧（PR・文書に載せる用。テストが実装と突き合わせる）。 */
export function paradisLaunchAllowList(agent: ParadisLaunchAgent): { readonly env: readonly string[]; readonly envPrefix?: string; readonly flags: readonly string[] } {
	return agent === 'claude'
		? { env: [...CLAUDE_ENV_NAMES], envPrefix: CLAUDE_ENV_PREFIX, flags: [...CLAUDE_FLAGS.keys()] }
		: { env: [...CODEX_ENV_NAMES], flags: [...CODEX_FLAGS.keys()] };
}

const EMPTY_PROFILE: IParadisAgentLaunchProfile = { env: {}, flags: {} };

export function paradisIsEmptyLaunchProfile(profile: IParadisAgentLaunchProfile): boolean {
	return Object.keys(profile.env).length === 0 && Object.keys(profile.flags).length === 0;
}

/**
 * 外から来た控え（台帳のファイル・接続先の返事・プロセスの環境）を、許可リストと値の文字種で絞る。
 * 形が違うもの・載っていない名前・引用の要る値は落とす。キーは名前順にそろえる。
 */
export function paradisSanitizeAgentLaunchProfile(agent: ParadisLaunchAgent, raw: unknown): IParadisAgentLaunchProfile {
	if (typeof raw !== 'object' || raw === null) {
		return EMPTY_PROFILE;
	}
	const input = raw as { readonly env?: unknown; readonly flags?: unknown };
	const env: Record<string, string> = {};
	if (typeof input.env === 'object' && input.env !== null) {
		for (const name of Object.keys(input.env).sort()) {
			const value = (input.env as Record<string, unknown>)[name];
			if (typeof value === 'string' && ENV_VALUE_PATTERN.test(value) && paradisIsAllowedLaunchEnvName(agent, name) && Object.keys(env).length < MAX_ENV_ENTRIES) {
				env[name] = value;
			}
		}
	}
	const flags: Record<string, string | true> = {};
	if (typeof input.flags === 'object' && input.flags !== null) {
		const specs = agent === 'claude' ? CLAUDE_FLAGS : CODEX_FLAGS;
		for (const name of Object.keys(input.flags).sort()) {
			const spec = specs.get(name);
			const value = (input.flags as Record<string, unknown>)[name];
			if (spec === undefined || spec.canonical !== name) {
				continue;
			}
			if (spec.takesValue ? typeof value === 'string' && FLAG_VALUE_PATTERN.test(value) : value === true) {
				flags[name] = value as string | true;
			}
		}
	}
	return { env, flags };
}

/** ペインで実行されたコマンド行から読めた起動。 */
export interface IParadisAgentLaunchCommand {
	readonly agent: ParadisLaunchAgent;
	/** 会話を始めた起動（`new`・`fork`）か、ある会話を続ける起動（`resume`）か。 */
	readonly mode: 'new' | 'resume' | 'fork';
	readonly profile: IParadisAgentLaunchProfile;
}

/**
 * ペインで実行されたコマンド行（シェル統合が報告したもの）から、控える環境変数（先頭の `名前=値`）とフラグを読む。
 * 対話の起動でなければ undefined。エイリアスが足したフラグと、`export` した環境変数はここには現れない
 * （後者はプロセスの環境から読む）。フラグは `--` の手前だけを見る（その後ろは依頼文）。
 */
export function paradisAgentLaunchFromCommandLine(commandLine: string): IParadisAgentLaunchCommand | undefined {
	const command = paradisInteractiveAgentCommand(commandLine);
	if (command === undefined || command.mode === 'attach') {
		return undefined;
	}
	const words = paradisShellWords(commandLine);
	const env: Record<string, string> = {};
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) {
		const word = words.shift()!;
		const equals = word.indexOf('=');
		env[word.slice(0, equals)] = word.slice(equals + 1);
	}
	words.shift();
	const specs = command.agent === 'claude' ? CLAUDE_FLAGS : CODEX_FLAGS;
	const flags: Record<string, string | true> = {};
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (word === '--') {
			break;
		}
		if (!word.startsWith('-')) {
			continue;
		}
		const equals = word.startsWith('--') ? word.indexOf('=') : -1;
		const spec = specs.get(equals > 0 ? word.slice(0, equals) : word);
		if (spec === undefined) {
			// 許可リストに無いオプションの値（`--append-system-prompt <文>`）を、フラグとして読まない
			if (equals < 0 && paradisAgentOptionTakesValue(command.agent, word)) { index++; }
			continue;
		}
		if (!spec.takesValue) {
			if (equals < 0) { flags[spec.canonical] = true; }
			continue;
		}
		const value = equals > 0 ? word.slice(equals + 1) : words[++index];
		if (value !== undefined) {
			flags[spec.canonical] = value;
		}
	}
	return { agent: command.agent, mode: command.mode, profile: paradisSanitizeAgentLaunchProfile(command.agent, { env, flags }) };
}

/** 会話 ID の形（Claude Code も Codex も UUID）。コマンド行の `--resume <値>` が、検索の語でなく会話 ID かを見分ける。 */
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 分岐の起動のコマンド行が名指しした元の会話の ID（`codex fork <id>`、`claude --resume <id> --fork-session`）。無ければ undefined。 */
function forkSourceId(commandLine: string, command: { readonly agent: ParadisLaunchAgent; readonly forkedFromId?: string }): string | undefined {
	if (command.agent === 'codex') {
		return command.forkedFromId !== undefined && CONVERSATION_ID_PATTERN.test(command.forkedFromId) ? command.forkedFromId : undefined;
	}
	const words = paradisShellWords(commandLine);
	for (let index = 0; index < words.length && words[index] !== '--'; index++) {
		const word = words[index];
		const value = word.startsWith('--resume=') ? word.slice('--resume='.length) : word === '--resume' || word === '-r' ? words[index + 1] : undefined;
		if (value !== undefined && CONVERSATION_ID_PATTERN.test(value)) {
			return value;
		}
	}
	return undefined;
}

/**
 * その起動を、会話 `sessionId` にどう控えるか。コマンド行は「ペインで動いているプロセスがどう起動されたか」で、
 * hook が報告した会話がその起動で作られたとは限らない（`claude` の中の `/resume` で前からある会話へ移る、分岐の
 * 直後に元の会話の ID が届く）。起動が作った会話と示せるときだけ `new` を返す:
 *
 * - 新規の起動: その会話の最初の SessionStart の `source` が `startup`・`clear` のとき。`resume` や、SessionStart を
 *   見ていない会話は `resume`（前からある会話として扱い、権限を広げるものを控えない）
 * - 分岐の起動: コマンド行が元の会話の ID を名指ししていて、届いた ID がそれと違うとき。元の ID で届いたものと、
 *   元の会話を名指ししない分岐（`--continue --fork-session`・`codex fork --last`。届いた ID が元か分岐先か分からない）は
 *   控えない（undefined）
 * - 再開の起動: `resume`
 */
export function paradisAgentLaunchRecordMode(commandLine: string, sessionId: string, startSource: ParadisAgentSessionStartSource | undefined): 'new' | 'resume' | undefined {
	const command = paradisInteractiveAgentCommand(commandLine);
	if (command === undefined || command.mode === 'attach') {
		return undefined;
	}
	if (command.mode === 'resume') {
		return 'resume';
	}
	if (command.mode === 'fork') {
		const source = forkSourceId(commandLine, command);
		return source !== undefined && source.toLowerCase() !== sessionId.toLowerCase() && !commandLine.includes(sessionId) ? 'new' : undefined;
	}
	return startSource === 'startup' || startSource === 'clear' ? 'new' : 'resume';
}

/**
 * 起動を台帳に入れるときの控え。控えのある会話では、控えを変えない: 会話 ID はその会話を作った起動でしか新しく
 * 現れないので、控えがあるなら、それが会話を始めたときのもの（窓の再読み込みで同じ起動をもう一度知らせたときに、
 * 環境を読めなかった回で消さない。再開は素のコマンドになることがあり、その起動でも消さない）。控えの無い会話は:
 * - その起動が作った会話（`new`。{@link paradisAgentLaunchRecordMode}）は、読めたものをそのまま控える
 * - 前からある会話（`resume`。この機能より前に始めた会話など）は、権限を広げるもの（確認を省くフラグと環境変数）
 *   以外を控える。「権限確認なしで再開」を一度選んだり、確認なしで起動した CLI の中でその会話へ移ったりしただけで、
 *   その後の普通の再開まで確認なしにしないため
 */
export function paradisMergeAgentLaunchProfile(existing: IParadisAgentLaunchProfile | undefined, captured: IParadisAgentLaunchProfile, mode: 'new' | 'resume'): IParadisAgentLaunchProfile {
	if (existing !== undefined && !paradisIsEmptyLaunchProfile(existing)) {
		return existing;
	}
	if (mode === 'new') {
		return captured;
	}
	return paradisLaunchProfileWithoutPermissionWidening(captured);
}

/**
 * 控えから、権限を広げるもの（確認を省くフラグ、`--allow-dangerously-skip-permissions`、
 * `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`）を外したもの。モデルなどの指定は残す。
 */
export function paradisLaunchProfileWithoutPermissionWidening(profile: IParadisAgentLaunchProfile): IParadisAgentLaunchProfile {
	return {
		env: Object.fromEntries(Object.entries(profile.env).filter(([name]) => !PERMISSION_WIDENING_ENV.has(name))),
		flags: Object.fromEntries(Object.entries(profile.flags).filter(([name]) => !PERMISSION_WIDENING_FLAGS.has(name))),
	};
}

/** 控えを付け直す先のシェル。 */
export interface IParadisAgentLaunchShell {
	/** ターミナルのシェルの種類（`TerminalShellType`）。分からなければ undefined。 */
	readonly shellType: string | undefined;
	/** シェルが Windows で動いている。 */
	readonly windows: boolean;
}

/** 再開のコマンドに付け直す控え。 */
export interface IParadisAgentLaunchResume extends IParadisAgentLaunchShell {
	readonly profile: IParadisAgentLaunchProfile;
}

/** コマンドの前に `名前=値` を書けるシェルか（その 1 回の起動にだけ効く）。 */
function shellTakesEnvPrefix(shell: IParadisAgentLaunchShell): boolean {
	switch (shell.shellType) {
		case 'bash':
		case 'zsh':
		case 'sh':
		case 'ksh':
		case 'fish':
		case 'gitbash':
		case 'wsl':
			return true;
		case undefined:
			// tmux や `exec zsh` などのラッパー経由。Windows では PowerShell か cmd かが分からない
			return !shell.windows;
		default:
			// csh・PowerShell・cmd・nushell などには、その 1 回だけに効く同じ書き方が無い
			return false;
	}
}

/** フラグの値を、シェルが展開しない 1 つの引数にする。できなければ undefined（そのフラグは付けない）。 */
function quoteFlagValue(value: string, shell: IParadisAgentLaunchShell): string | undefined {
	if (!FLAG_VALUE_PATTERN.test(value)) {
		return undefined;
	}
	if (!/[\[\]]/.test(value)) {
		return value;
	}
	switch (shell.shellType) {
		case 'bash':
		case 'zsh':
		case 'sh':
		case 'ksh':
		case 'csh':
		case 'fish':
		case 'gitbash':
		case 'wsl':
		case 'pwsh':
			return `'${value}'`;
		case 'cmd':
			// cmd は `'` を引用符として扱わない。`[` `]` は cmd では特別な文字ではない
			return value;
		case undefined:
			return shell.windows ? value : `'${value}'`;
		default:
			return undefined;
	}
}

/**
 * 再開のコマンドの前に置く環境変数（`名前=値 名前=値 `。末尾に空白）。付けられない・無いときは空文字。
 * Code Mode の `--settings` が決める名前は許可リストに無いので、同じコマンドの中で重ならない。
 */
export function paradisAgentLaunchEnvPrefix(agent: ParadisLaunchAgent, launch: IParadisAgentLaunchResume | undefined): string {
	if (launch === undefined || !shellTakesEnvPrefix(launch)) {
		return '';
	}
	const env = paradisSanitizeAgentLaunchProfile(agent, launch.profile).env;
	return Object.entries(env).map(([name, value]) => `${name}=${value} `).join('');
}

/** 再開のコマンドに足すフラグ（` --model opus`。先頭に空白）。無ければ空文字。権限の確認を省くフラグは含めない。 */
export function paradisAgentLaunchFlagArguments(agent: ParadisLaunchAgent, launch: IParadisAgentLaunchResume | undefined): string {
	if (launch === undefined) {
		return '';
	}
	const flags = paradisSanitizeAgentLaunchProfile(agent, launch.profile).flags;
	let result = '';
	for (const name of agent === 'claude' ? CLAUDE_RENDERED_FLAGS : CODEX_RENDERED_FLAGS) {
		const value = flags[name];
		if (value === true) {
			result += ` ${name}`;
		} else if (value !== undefined) {
			const quoted = quoteFlagValue(value, launch);
			if (quoted !== undefined) { result += ` ${name} ${quoted}`; }
		}
	}
	return result;
}

/** 会話を始めた起動に、権限の確認を省くフラグが付いていたか。 */
export function paradisAgentLaunchBypassedPermissions(agent: ParadisLaunchAgent, launch: IParadisAgentLaunchResume | undefined): boolean {
	return launch !== undefined && paradisSanitizeAgentLaunchProfile(agent, launch.profile).flags[PARADIS_LAUNCH_BYPASS_FLAG[agent]] === true;
}

/** 台帳の 1 件。 */
export interface IParadisAgentLaunchLedgerEntry extends IParadisAgentLaunchProfile {
	/** 最後に控えた時刻 (epoch ms)。 */
	readonly at: number;
}

/** 台帳のキー（`claude:<会話 ID>`）。 */
export function paradisAgentLaunchLedgerKey(agent: ParadisLaunchAgent, sessionId: string): string {
	return `${agent}:${sessionId}`;
}

/** これより古い控えは捨てる（Claude Code は既定で 30 日より古い記録を消す。余裕を見て 90 日）。 */
export const PARADIS_AGENT_LAUNCH_LEDGER_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** 台帳に残す件数の上限（新しいものを残す）。 */
export const PARADIS_AGENT_LAUNCH_LEDGER_MAX_ENTRIES = 2000;

/** 古い控えと、上限を超えた分（古い順）を捨てる。 */
export function paradisPruneAgentLaunchLedger(entries: Readonly<Record<string, IParadisAgentLaunchLedgerEntry>>, now: number): Record<string, IParadisAgentLaunchLedgerEntry> {
	const kept = Object.entries(entries)
		.filter(([, entry]) => now - entry.at <= PARADIS_AGENT_LAUNCH_LEDGER_MAX_AGE_MS)
		.sort(([, a], [, b]) => b.at - a.at)
		.slice(0, PARADIS_AGENT_LAUNCH_LEDGER_MAX_ENTRIES);
	return Object.fromEntries(kept);
}

/** 控えを知らせるのに要る、ターミナルの今の状態。 */
export interface IParadisAgentLaunchCaptureTerminal {
	/** シェル統合が報告した実行中のコマンド行。 */
	readonly commandLine: string | undefined;
	/**
	 * 実行中のコマンドを見分ける ID（シェル統合がコマンドごとに振るもの）。会話が、今のコマンドが始まる前からそのペインに
	 * 見えていたかの判定に使う。分からなければ undefined。
	 */
	readonly commandId?: string;
	/** シェルの pid（ターミナルのあるマシンの上のもの）。 */
	readonly shellPid: number | undefined;
	/** 接続先（SSH 先など）のターミナル。 */
	readonly remote: boolean;
}

/** 知らせる起動（`remote` は送り先の選び分け用で、送る中身には入れない）。 */
export interface IParadisAgentLaunchToRecord {
	readonly agent: ParadisLaunchAgent;
	readonly sessionId: string;
	readonly commandLine: string;
	readonly shellPid?: number;
	/** その会話の最初の SessionStart の `source`（{@link IParadisAgentPaneSession.startSource}）。 */
	readonly startSource?: ParadisAgentSessionStartSource;
	readonly remote: boolean;
}

/**
 * ペインの会話を初めて見たときの様子（{@link paradisAgentLaunchesToRecord} が持ち回る）。
 *
 * 会話は、コマンドの実行より後にそのペインへ現れたものだけが「その起動が作った会話」。Codex の hook には SessionEnd が無く
 * （Claude Code も異常終了では届かない）、CLI を終えた後もペインに前の会話が残る。そのまま同じペインで
 * `codex --yolo` を打つと、新しい会話の SessionStart が届くまでの間、「前の会話」と「確認を省く起動のコマンド行」が並ぶ。
 * これを組にして控えると、確認ありで始めた会話に確認の省略が付く。時計は比べない（hook を受けるマシンとウィンドウで
 * 別のことがある）。ウィンドウの中での順序だけで決める。
 */
export interface IParadisAgentLaunchCaptureOrigins {
	/** 最初のスナップショットを見終えたか。その時点で既にあった会話は、どのコマンドの間に現れたか分からない。 */
	primed: boolean;
	/**
	 * `ペイントークン\n会話 ID` → 初めて見たときに実行中だったコマンドの ID（実行中のコマンドが無い・分からなければ undefined）と、
	 * 最初から居たか。スナップショットは数秒おきなので、前の起動が数秒で終わり、その会話を初めて見たのが次の起動の実行中だった
	 * ときは取り違える（【要確認】そこまでは塞いでいない）。
	 */
	readonly sessions: Map<string, { readonly commandId: string | undefined; readonly preexisting: boolean; /** ターミナルの様子が分かって、`commandId` を決めたか。 */ readonly decided: boolean }>;
}

export function paradisCreateAgentLaunchCaptureOrigins(): IParadisAgentLaunchCaptureOrigins {
	return { primed: false, sessions: new Map() };
}

/**
 * ペインの会話のうち、まだ知らせていないものを選ぶ（純粋な判定。テストから直接呼ぶ）。
 * 知らせるのは、実行中のコマンド行がその種類のエージェントの対話の起動のときだけ。コマンド行がまだ届いていない
 * ペインは次のスナップショットで見直すので、`sent` に入れない。`sent` からは、消えたペインの分を外す。
 *
 * `origins` を渡すと、会話を初めて見たときのコマンドと今のコマンドを比べる（{@link IParadisAgentLaunchCaptureOrigins}）:
 * - 別のコマンドの間に現れた会話（前の起動の会話がペインに残っているだけ）は、知らせない。今の起動の会話が届けば、それを知らせる。
 *   今のコマンド行がその会話の ID を名指ししているとき（残っていた会話そのものの再開）は、前からある会話として知らせる
 * - 最初のスナップショットに既にあった会話と、ターミナルの様子が初めて分かったときに実行中のコマンドが無かった会話は、
 *   今の起動が作ったと示せない。`startSource` を外して知らせる（前からある会話として扱われ、権限を広げるものは控えられない）
 * - ターミナルの様子がまだ分からない会話（表示していないスペースで起動したペイン）は、分かるまで決めずに持ち越す
 */
export function paradisAgentLaunchesToRecord(
	sessions: readonly IParadisAgentPaneSession[],
	sent: Set<string>,
	terminalFor: (token: string) => IParadisAgentLaunchCaptureTerminal | undefined,
	origins?: IParadisAgentLaunchCaptureOrigins,
): IParadisAgentLaunchToRecord[] {
	const live = new Set<string>();
	const result: IParadisAgentLaunchToRecord[] = [];
	for (const session of sessions) {
		const agent = session.agent;
		if (!paradisIsLaunchAgent(agent)) {
			continue;
		}
		const key = `${session.token}\n${session.sessionId}`;
		live.add(key);
		if (sent.has(key)) {
			continue;
		}
		const terminal = terminalFor(session.token);
		let origin = origins?.sessions.get(key);
		if (origins !== undefined) {
			origin ??= { commandId: undefined, preexisting: !origins.primed, decided: false };
			if (!origin.decided && terminal?.commandId !== undefined) {
				// ターミナルの様子が分かった最初のスナップショットで決める（表示していないスペースで起動したペインは、開くまで
				// シェル統合の様子が分からない。その間は決めずに持ち越す）。
				// コマンドが実行中でないとき（プロンプトで待っている）に見た会話は、どのコマンドの間に現れたか分からない
				// （シェル統合の「今のコマンド」は、次に打つコマンドと同じもの。前の起動の会話を、次の起動のものと取り違える）
				origin = { commandId: terminal.commandLine !== undefined ? terminal.commandId : undefined, preexisting: origin.preexisting, decided: true };
			}
			origins.sessions.set(key, origin);
		}
		if (terminal?.commandLine === undefined || paradisAgentLaunchFromCommandLine(terminal.commandLine)?.agent !== agent) {
			continue;
		}
		const fromEarlierCommand = origin !== undefined && origin.commandId !== undefined && terminal.commandId !== undefined && origin.commandId !== terminal.commandId;
		if (fromEarlierCommand && !terminal.commandLine.includes(session.sessionId)) {
			// 前のコマンドの間に現れた会話。今のコマンド行はこの会話の起動ではない（会話 ID を名指しした再開だけは、
			// 前からある会話の再開として下で知らせる）
			continue;
		}
		const createdByThisCommand = origin === undefined || (!fromEarlierCommand && !origin.preexisting && origin.commandId !== undefined);
		sent.add(key);
		result.push({ agent, sessionId: session.sessionId, commandLine: terminal.commandLine, ...(terminal.shellPid !== undefined ? { shellPid: terminal.shellPid } : {}), ...(session.startSource !== undefined && createdByThisCommand ? { startSource: session.startSource } : {}), remote: terminal.remote });
	}
	for (const key of sent) {
		if (!live.has(key)) { sent.delete(key); }
	}
	if (origins !== undefined) {
		for (const key of origins.sessions.keys()) {
			if (!live.has(key)) { origins.sessions.delete(key); }
		}
		origins.primed = true;
	}
	return result;
}
