/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントhookの「発信元プロセス所有権」分類。
//
// ペイントークン (PARA_CODE_TERMINAL_PANE_ID) はターミナル配下の全子プロセスへ環境変数として
// 継承されるため、ペインのルートエージェント（例: Claude Code）が子プロセスとして別エージェント
// （例: plugin 経由の `codex exec`）を起動すると、子のhookも親と同じトークンで届く。
// これを無検証で受けると、ペインの親セッションが子のtranscriptへ乗っ取られ（モバイルの
// 「親セッションが切り替わりました」）、子の Stop が親ペインの完了通知を誤発火させる。
//
// 対策として notify スクリプト (schema v3) が自身のPIDを併送し、shared process 側が
// プロセス祖先チェーンから「transcriptのエージェント種別と一致する最も近いエージェント
// プロセス (emitter)」を特定して、ペインごとの所有者と照合する:
//   - emitter が現所有者と同一プロセス (PID+開始時刻) → owner（/clear 等のrebindも許可）
//   - 現所有者が emitter の祖先に生存           → nested（子エージェント。状態を汚染させない）
//   - 現所有者が死亡/PID再利用                  → owner を昇格
//   - 現所有者が生存しているのに祖先にいない     → invalid（誤配送。破棄）
//   - 祖先に Claude Code の daemon がいる         → background（`/fork` の分岐先・`claude --bg`。後述）
// PIDが取れない場合（旧スクリプト・プロセス消滅・ps失敗）は fail-closed:
// 既知の所有者と同じtranscriptへのイベントだけを通す。

import { exec } from 'child_process';
import { statSync } from 'fs';
import { promisify } from 'util';
import { ParadisHookIdentityLoss } from '../common/paradisAgentHookDropLog.js';
import { paradisIsWithinCodexHome } from './paradisAgentHome.js';

const execAsync = promisify(exec);

const EXEC_TIMEOUT_MS = 5_000;
/** プロセス表スナップショットの再利用時間。hookのバーストで ps/CIM 実行を連発させない。 */
const SNAPSHOT_TTL_MS = 2_000;
/** 祖先チェーンの探索上限（wrapper シェルの多段起動を考慮しても十分な深さ）。 */
const MAX_ANCESTOR_DEPTH = 15;
/** 所有者レコードの上限（ペイン数を大きく超える値。無制限な成長の防止のみが目的）。 */
const MAX_OWNER_RECORDS = 4_096;

export type ParadisHookAgentKind = 'claude' | 'codex';

export type ParadisHookOrigin = 'owner' | 'nested' | 'invalid' | 'background';

/** プロセス表スナップショットの1行。 */
export interface IParadisHookProcessInfo {
	readonly pid: number;
	readonly ppid: number | undefined;
	/** プロセス開始時刻由来の識別子（PID再利用の検出に使う。取得不能なら undefined）。 */
	readonly startKey: string | undefined;
	readonly command: string;
}

/** プロセス表の取得（テストではfakeへ差し替える）。 */
export interface IParadisHookProcessInspector {
	snapshot(): Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined>;
	/** 直近に使ったプロセス表を取り始めた時刻（診断ログ用。分からなければ undefined）。 */
	lastSnapshotAt?(): number | undefined;
}

interface IOwnerRecord {
	pid: number | undefined;
	startKey: string | undefined;
	agentKind: ParadisHookAgentKind | undefined;
	transcriptPath: string | undefined;
	at: number;
}

/** transcript_path からエージェント種別を判定する（mobileRelay 側の判定と同一規約）。 */
export function paradisHookAgentKindForTranscript(transcriptPath: string): ParadisHookAgentKind {
	// アカウントを切り替えると ~/.codex-2 のような別ホームに書かれるので、その形も Codex とみなす。
	if (/[\\/]\.codex(?:-[\w.]+)?[\\/]/.test(transcriptPath) || /[\\/]rollout-[^\\/]*\.jsonl$/.test(transcriptPath)) {
		return 'codex';
	}
	return paradisIsWithinCodexHome(transcriptPath) ? 'codex' : 'claude';
}

// エージェントかどうかは「そのプロセスが何の実行ファイルか」だけで決める。起動行のどこかに
// `claude` があるだけでは判定しない（例: tmux サーバーの起動行 `tmux new-session -s x claude`。
// サーバーは中の claude の祖先になるので、これをエージェントと見なすと最外側の所有者を奪い、
// 中の claude 自身のhookを nested にしてしまう）。見るのは次の2つ:
//   - argv[0] のベース名（`claude` / `codex` / `claude.exe` / `codex.cmd` など）= 本体の形
//   - 同じプロセスでスクリプトを実行するラッパー（node・bun・deno・env・シェル・cmd・PowerShell）
//     が実行するスクリプトのパスやコマンド = 起動役の形
// tmux・screen・zellij 等はどちらにも当たらないので、特別扱いの一覧は持たない。
// npx・bunx・pnpx・`bun x` のようなパッケージランナーは本体を必ず子プロセスとして起動するので
// 判定しない（子の本体が判定される）。
//
// 起動役の形のプロセス（npm 版 codex の `node …/bin/codex`、Para Code の codex ペイン用ランチャー、
// `exec` しないラッパースクリプト等）は本体を子として起動して自分も親に残る。起動役とその直接の子の
// 同じ種類のエージェントは1体として扱う（findEmitter 参照）。

/** ネストしたラッパー（`env` → `sh -c` → …）を辿る深さの上限。 */
const MAX_COMMAND_NESTING = 4;
/** 同じプロセスでスクリプトを実行するランタイム。 */
const SCRIPT_RUNTIME_BASENAMES = new Set(['node', 'nodejs', 'bun', 'deno']);
const SHELL_BASENAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const POWERSHELL_BASENAMES = new Set(['powershell', 'pwsh']);
/** ランタイムの、次のトークンを値に取るオプション。 */
const RUNTIME_OPTIONS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--title', '--env-file', '--preload', '--cwd', '--config']);
/** ランタイムの、スクリプトファイルではなくコード片を実行するオプション。 */
const RUNTIME_INLINE_CODE_OPTIONS = new Set(['-e', '--eval', '-p', '--print']);
/** bun / deno の、同じプロセスでスクリプトを実行するサブコマンド（`bun run x` / `deno run x`）。 */
const RUNTIME_SCRIPT_SUBCOMMANDS = new Set(['run']);
/** bun のパッケージランナーのサブコマンド（`bun x pkg`）。本体は子プロセスになるので判定しない。 */
const RUNTIME_RUNNER_SUBCOMMANDS = new Set(['x', 'exec']);
const ENV_OPTIONS_WITH_VALUE = new Set(['-u', '--unset', '-C', '--chdir', '-P']);
const SHELL_OPTIONS_WITH_VALUE = new Set(['-o', '+o', '-O', '+O']);
const POWERSHELL_OPTIONS_WITH_VALUE = new Set(['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-version', '-v', '-inputformat', '-if', '-outputformat', '-of', '-configurationname', '-workingdirectory', '-wd', '-settingsfile']);
const POWERSHELL_ENCODED_OPTIONS = new Set(['-encodedcommand', '-e', '-ec', '-enc']);
const POWERSHELL_COMMAND_OPTIONS = new Set(['-command', '-c', '-file', '-f']);
/** Para Code の Windows 用 codex ペインランチャー（`resources/paradis/bin/paradisCodexPaneLauncher.cjs`）。 */
const PARADIS_CODEX_PANE_LAUNCHER_BASENAME = 'paradiscodexpanelauncher';
/** npm の Claude Code 本体。Windows の npm・pnpm は bin のシムを経ずに `node …/cli.js` と見える。 */
const CLAUDE_CODE_PACKAGE_ENTRY = /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.m?js$/i;
/** 拡張子まで揃ったスクリプトのパス。これより後ろは空白でつながない。 */
const SCRIPT_FILE_EXTENSION = /\.(?:js|mjs|cjs|ts|mts|cts|sh|py|rb|pl)$/i;
/** 空白入りのパスとしてつなぐトークン数の上限。 */
const MAX_PATH_SPACE_JOINS = 3;

interface ICommandLineToken {
	readonly value: string;
	readonly start: number;
	readonly end: number;
}

/** 起動行から判定したエージェント。 */
interface IAgentCommandMatch {
	readonly kind: ParadisHookAgentKind;
	/** 起動役の形（ラッパーの引数で判定した）なら true。argv[0] で判定した本体の形なら false。 */
	readonly launcher: boolean;
}

/**
 * 起動行を空白で区切る。`"` で囲んだ部分は1トークンにまとめる（Windows の
 * `"C:\Program Files\...\claude.exe"` 用）。バックスラッシュはパス区切りとして残す。
 */
function tokenizeCommandLine(command: string): ICommandLineToken[] {
	const tokens: ICommandLineToken[] = [];
	let index = 0;
	while (index < command.length) {
		while (index < command.length && /\s/.test(command[index])) {
			index++;
		}
		if (index >= command.length) {
			break;
		}
		const start = index;
		let value = '';
		let quoted = false;
		while (index < command.length && (quoted || !/\s/.test(command[index]))) {
			if (command[index] === '"') {
				quoted = !quoted;
			} else {
				value += command[index];
			}
			index++;
		}
		tokens.push({ value: value.replace(/^'+|'+$/g, ''), start, end: index });
	}
	return tokens;
}

/** パスのベース名を小文字にし、Windows のシム・スクリプトの拡張子を除く。 */
function normalizedBasename(token: string): string {
	const basename = token.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
	return basename.toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');
}

function agentKindOfBasename(basename: string): ParadisHookAgentKind | undefined {
	if (basename === 'claude') {
		return 'claude';
	}
	if (basename === 'codex') {
		return 'codex';
	}
	return undefined;
}

function isExistingFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

/** ラッパーが実行するスクリプトのパスからエージェント種別を返す。 */
function agentKindOfScriptPath(scriptPath: string): ParadisHookAgentKind | undefined {
	const basename = normalizedBasename(scriptPath);
	const kind = agentKindOfBasename(basename);
	if (kind !== undefined) {
		return kind;
	}
	if (CLAUDE_CODE_PACKAGE_ENTRY.test(scriptPath)) {
		return 'claude';
	}
	return basename === PARADIS_CODEX_PANE_LAUNCHER_BASENAME ? 'codex' : undefined;
}

/**
 * `tokens[index]` から始まるスクリプトのパスを判定する。POSIX の `ps` は argv を引用符なしの
 * 空白区切りで出すので、`/Applications/Para Code.app/…/codex` や `/Users/John Smith/…/claude`
 * のような空白入りのパスは複数のトークンに割れる。1トークンで判定できなければ、`-`・`/` で
 * 始まらない後続のトークンを空白でつないで判定し直す（`/` を含む断片をつないだ時点で試す）。
 * 最初のトークンが実在するファイル（`/usr/local/bin/tsx scripts/claude` の tsx 等）なら、それで
 * パスは完結しているのでつながない。`./`・`../` で始まる相対パスの引数もつながない。
 * 残る誤判定は、実在しないパスに `x/claude` のような引数が続く形だけで、その場合も
 * 最外側の所有者が外へずれて状態が出ない側に倒れる（乗っ取り側には倒れない）。
 */
function agentKindOfScriptOperand(tokens: readonly ICommandLineToken[], index: number): ParadisHookAgentKind | undefined {
	const firstFragment = tokens[index].value;
	let scriptPath = firstFragment;
	const direct = agentKindOfScriptPath(scriptPath);
	if (direct !== undefined || !scriptPath.startsWith('/')) {
		return direct;
	}
	for (let next = index + 1; next < tokens.length && next <= index + MAX_PATH_SPACE_JOINS; next++) {
		const fragment = tokens[next].value;
		if (SCRIPT_FILE_EXTENSION.test(scriptPath) || /^(?:[-/]|\.\.?\/)/.test(fragment)) {
			return undefined;
		}
		scriptPath += ' ' + fragment;
		if (fragment.includes('/')) {
			const kind = agentKindOfScriptPath(scriptPath);
			if (kind !== undefined) {
				// ファイルの存在確認は、つないだ結果がエージェントに当たったときだけ行う。
				return isExistingFile(firstFragment) ? undefined : kind;
			}
		}
	}
	return undefined;
}

function launcherMatch(kind: ParadisHookAgentKind | undefined): IAgentCommandMatch | undefined {
	return kind !== undefined ? { kind, launcher: true } : undefined;
}

/**
 * ランタイム（node・bun・deno）が実行するスクリプトの判定。Claude Code はそのプロセスで動く本体
 * （Windows の npm 版は `node …\cli.js` のまま見え、macOS / Linux でも `process.title` を反映しない
 * ランタイムでは同じ）なので本体の形にする。起動役の形にすると、本体がシェル経由や直接起動した
 * 子の Claude Code が所有者と1体に合わさり、子のhookが所有者として通ってしまう。
 * 親に残って vendor の本体を子として起動する codex の `bin/codex.js` と、Para Code の
 * ランチャーだけが起動役の形になる。
 */
function runtimeScriptMatch(kind: ParadisHookAgentKind | undefined): IAgentCommandMatch | undefined {
	return kind === 'claude' ? { kind, launcher: false } : launcherMatch(kind);
}

/** `command` の先頭のプログラムを解釈してエージェントを判定する。 */
function agentMatchOfCommand(command: string, depth: number): IAgentCommandMatch | undefined {
	if (depth > MAX_COMMAND_NESTING) {
		return undefined;
	}
	const tokens = tokenizeCommandLine(command);
	if (tokens.length === 0) {
		return undefined;
	}
	const match = agentMatchOfTokens(command, tokens, depth);
	if (match !== undefined || !/\s/.test(tokens[0].value)) {
		return match;
	}
	// 先頭が `"claude --resume"` のように引用符で囲まれたコマンド文字列だった場合（`sh -c` や
	// `cmd /c` の中身）は、区切り直して解釈する。
	return agentMatchOfCommand(tokens[0].value + command.slice(tokens[0].end), depth + 1);
}

/** ラッパーの中のコマンドを判定する。ラッパー自身は親に残りうるので起動役の形にする。 */
function nestedCommandMatch(command: string, depth: number): IAgentCommandMatch | undefined {
	return launcherMatch(agentMatchOfCommand(command, depth + 1)?.kind);
}

function agentMatchOfTokens(command: string, tokens: readonly ICommandLineToken[], depth: number): IAgentCommandMatch | undefined {
	const program = normalizedBasename(tokens[0].value);
	const programKind = agentKindOfBasename(program);
	if (programKind !== undefined) {
		return { kind: programKind, launcher: false };
	}
	const rest = (index: number) => index < tokens.length ? command.slice(tokens[index].start) : '';
	if (program === 'env') {
		// `env [-i] [-u NAME] [NAME=VALUE ...] program ...`
		for (let i = 1; i < tokens.length; i++) {
			const value = tokens[i].value;
			if (ENV_OPTIONS_WITH_VALUE.has(value)) {
				i++;
			} else if (!value.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
				return nestedCommandMatch(rest(i), depth);
			}
		}
		return undefined;
	}
	if (SCRIPT_RUNTIME_BASENAMES.has(program)) {
		let subcommandAllowed = program === 'bun' || program === 'deno';
		for (let i = 1; i < tokens.length; i++) {
			const value = tokens[i].value;
			if (value === '--') {
				return i + 1 < tokens.length ? runtimeScriptMatch(agentKindOfScriptOperand(tokens, i + 1)) : undefined;
			}
			if (RUNTIME_INLINE_CODE_OPTIONS.has(value)) {
				return undefined;
			}
			if (RUNTIME_OPTIONS_WITH_VALUE.has(value)) {
				i++;
				continue;
			}
			if (value.startsWith('-')) {
				continue;
			}
			if (subcommandAllowed && RUNTIME_RUNNER_SUBCOMMANDS.has(value)) {
				return undefined;
			}
			if (subcommandAllowed && RUNTIME_SCRIPT_SUBCOMMANDS.has(value)) {
				subcommandAllowed = false;
				continue;
			}
			return runtimeScriptMatch(agentKindOfScriptOperand(tokens, i));
		}
		return undefined;
	}
	if (SHELL_BASENAMES.has(program)) {
		// `sh -c 'claude ...'` はコマンド文字列の先頭、`sh /path/to/claude` はスクリプトのパスを見る。
		let commandMode = false;
		for (let i = 1; i < tokens.length; i++) {
			const value = tokens[i].value;
			if (SHELL_OPTIONS_WITH_VALUE.has(value)) {
				i++;
				continue;
			}
			if (value === '--' || value === '-') {
				continue;
			}
			if (/^[-+]/.test(value)) {
				commandMode ||= /^-[A-Za-z]*c[A-Za-z]*$/.test(value);
				continue;
			}
			return commandMode ? nestedCommandMatch(rest(i), depth) : launcherMatch(agentKindOfScriptOperand(tokens, i));
		}
		return undefined;
	}
	if (program === 'cmd') {
		// `cmd.exe /d /s /c ""C:\...\codex.cmd" exec"`: /c 以降がコマンド。/s の外側の引用符を外す。
		const commandIndex = tokens.findIndex((token, i) => i > 0 && /^\/[ck]$/i.test(token.value));
		if (commandIndex < 0) {
			return undefined;
		}
		let text = command.slice(tokens[commandIndex].end).trim();
		if (text.startsWith('""') && text.endsWith('"')) {
			text = text.slice(1, -1);
		}
		return nestedCommandMatch(text, depth);
	}
	if (POWERSHELL_BASENAMES.has(program)) {
		for (let i = 1; i < tokens.length; i++) {
			const value = tokens[i].value.toLowerCase();
			if (POWERSHELL_ENCODED_OPTIONS.has(value)) {
				return undefined;
			}
			if (POWERSHELL_COMMAND_OPTIONS.has(value)) {
				return nestedCommandMatch(rest(i + 1), depth);
			}
			if (POWERSHELL_OPTIONS_WITH_VALUE.has(value)) {
				i++;
				continue;
			}
			if (value.startsWith('-')) {
				continue;
			}
			return nestedCommandMatch(rest(i), depth);
		}
		return undefined;
	}
	// node.exe が無い Windows では、ランチャーを Para Code 本体（ELECTRON_RUN_AS_NODE）で実行する。
	if (tokens.length > 1 && normalizedBasename(tokens[1].value) === PARADIS_CODEX_PANE_LAUNCHER_BASENAME) {
		return { kind: 'codex', launcher: true };
	}
	return undefined;
}

/**
 * プロセスの起動行からエージェント種別を推定する。
 * argv[0] のベース名と、ラッパー（node・bun・deno・env・シェル・cmd・PowerShell）が実行する
 * スクリプトのパスだけを見る。ほかのプログラムの引数（`tmux new-session -s x claude` 等）や、
 * `codex-companion.mjs`・`.claude/...` のようなパス断片には一致しない。
 */
export function paradisHookAgentKindFromCommandLine(command: string): ParadisHookAgentKind | undefined {
	return agentMatchOfCommand(command, 0)?.kind;
}

// Claude Code の daemon の形（2.1.289 で実測）。`/fork` の分岐先と `claude --bg` の会話は、元のペインの
// claude ではなく次の連なりの末端が動かす:
//   claude（daemon を最初に起こしたペインの claude）→ `claude daemon run …` → `claude bg-pty-host --bg-pty-host … -- <本体> --bg-spare …`
//   → `claude bg-spare --bg-spare …`（会話の本体。hook はここから出る）
// daemon は最初に起こしたペインの環境（PARA_CODE_TERMINAL_PANE_ID）を持ち続けるので、その配下の会話の hook は
// 無関係なペインの token で届く。そのペインの claude が生きている間は祖先にいるので nested に、終わった後は
// daemon が後継の所有者になってペインの会話を奪う。どちらも誤りなので、祖先に daemon がいる hook は別扱いにする。
const CLAUDE_BACKGROUND_HOST_ARGUMENTS = new Set(['--bg-spare', '--bg-pty-host', 'bg-spare', 'bg-pty-host']);
/** Linux などで本体の argv[0] が版のディレクトリのパス（`…/claude/versions/2.1.289`）に見える形。 */
const CLAUDE_VERSIONED_BINARY = /[\\/]claude[\\/]versions[\\/][^\\/]+$/i;

/**
 * 起動行のうち、claude 本体（本体の形か、ランタイムが実行する claude のスクリプト）の次の語の位置。
 * {@link agentMatchOfTokens} と同じ読み方で、`env`・node・bun・deno を経た起動も辿る。claude でなければ undefined。
 */
function claudeArgumentsStart(tokens: readonly ICommandLineToken[]): number | undefined {
	let index = 0;
	if (normalizedBasename(tokens[0]?.value ?? '') === 'env') {
		// `env [-i] [-u NAME] [NAME=VALUE ...] program ...`
		for (index = 1; index < tokens.length; index++) {
			const value = tokens[index].value;
			if (ENV_OPTIONS_WITH_VALUE.has(value)) {
				index++;
			} else if (!value.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
				break;
			}
		}
	}
	if (index >= tokens.length) {
		return undefined;
	}
	const programToken = tokens[index].value;
	const program = normalizedBasename(programToken);
	if (agentKindOfBasename(program) === 'claude' || CLAUDE_VERSIONED_BINARY.test(programToken)) {
		return index + 1;
	}
	if (!SCRIPT_RUNTIME_BASENAMES.has(program)) {
		return undefined;
	}
	let subcommandAllowed = program === 'bun' || program === 'deno';
	for (let i = index + 1; i < tokens.length; i++) {
		const value = tokens[i].value;
		if (value === '--') {
			return i + 1 < tokens.length && agentKindOfScriptPath(tokens[i + 1].value) === 'claude' ? i + 2 : undefined;
		}
		if (RUNTIME_INLINE_CODE_OPTIONS.has(value)) {
			return undefined;
		}
		if (RUNTIME_OPTIONS_WITH_VALUE.has(value)) {
			i++;
			continue;
		}
		if (value.startsWith('-')) {
			continue;
		}
		if (subcommandAllowed && RUNTIME_RUNNER_SUBCOMMANDS.has(value)) {
			return undefined;
		}
		if (subcommandAllowed && RUNTIME_SCRIPT_SUBCOMMANDS.has(value)) {
			subcommandAllowed = false;
			continue;
		}
		return agentKindOfScriptPath(value) === 'claude' ? i + 1 : undefined;
	}
	return undefined;
}

/**
 * Claude Code の daemon（`claude daemon run`）か、その配下で会話を動かすプロセス（`bg-pty-host`・`bg-spare`）か。
 * 見るのは claude 本体の次の語だけ（`claude bg-spare …`・`node …/claude bg-spare …`・`node …/cli.js daemon run`・
 * argv[0] が版のディレクトリのパスの `…/versions/2.1.289 --bg-spare …`）。`claude "--bg-spare について"` のように、
 * プロンプトや後ろの引数に同じ綴りが出るだけのものは当てない。
 */
export function paradisIsClaudeBackgroundHostCommand(command: string): boolean {
	const tokens = tokenizeCommandLine(command);
	if (tokens.length < 2) {
		return false;
	}
	const start = claudeArgumentsStart(tokens);
	if (start === undefined || start >= tokens.length) {
		return false;
	}
	const next = tokens[start].value;
	return CLAUDE_BACKGROUND_HOST_ARGUMENTS.has(next) || (next === 'daemon' && tokens[start + 1]?.value === 'run');
}

/** POSIX: `ps ax` 1回でプロセス表を取得する（LC_ALL=C で lstart を5トークン固定にする）。 */
async function posixProcessSnapshot(): Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined> {
	try {
		const { stdout } = await execAsync('ps ax -o pid=,ppid=,lstart=,command= 2>/dev/null || true', {
			timeout: EXEC_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, LC_ALL: 'C' },
		});
		const result = new Map<number, IParadisHookProcessInfo>();
		for (const line of stdout.split('\n')) {
			// 形式: <pid> <ppid> <曜日 月 日 時刻 年 (5トークン)> <command...>
			const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
			if (!match) {
				continue;
			}
			const pid = Number(match[1]);
			result.set(pid, { pid, ppid: Number(match[2]), startKey: match[3], command: match[4] });
		}
		return result.size > 0 ? result : undefined;
	} catch {
		return undefined;
	}
}

/** Windows: Win32_Process を1回で取得する。CreationDate はPID再利用検出用の不透明文字列。 */
async function windowsProcessSnapshot(): Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined> {
	try {
		const command = 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ConvertTo-Json -Compress"';
		const { stdout } = await execAsync(command, { timeout: EXEC_TIMEOUT_MS * 2, maxBuffer: 32 * 1024 * 1024 });
		const parsed: unknown = JSON.parse(stdout);
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const result = new Map<number, IParadisHookProcessInfo>();
		for (const entry of entries) {
			if (typeof entry !== 'object' || entry === null) {
				continue;
			}
			const row = entry as Record<string, unknown>;
			const pid = typeof row.ProcessId === 'number' ? row.ProcessId : undefined;
			if (pid === undefined) {
				continue;
			}
			const ppid = typeof row.ParentProcessId === 'number' ? row.ParentProcessId : undefined;
			const creation = row.CreationDate;
			const commandLine = typeof row.CommandLine === 'string' && row.CommandLine.length > 0
				? row.CommandLine
				: typeof row.Name === 'string' ? row.Name : '';
			result.set(pid, {
				pid, ppid,
				startKey: typeof creation === 'string' ? creation : typeof creation === 'object' && creation !== null ? JSON.stringify(creation) : undefined,
				command: commandLine,
			});
		}
		return result.size > 0 ? result : undefined;
	} catch {
		return undefined;
	}
}

/** 既定のプロセス表取得（TTL付きキャッシュ。失敗キャッシュはしない）。 */
export class ParadisDefaultHookProcessInspector implements IParadisHookProcessInspector {
	private cached: { at: number; value: Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined> } | undefined;

	snapshot(): Promise<ReadonlyMap<number, IParadisHookProcessInfo> | undefined> {
		const now = Date.now();
		if (this.cached !== undefined && now - this.cached.at < SNAPSHOT_TTL_MS) {
			return this.cached.value;
		}
		const value = (process.platform === 'win32' ? windowsProcessSnapshot() : posixProcessSnapshot())
			.then(snapshot => {
				if (snapshot === undefined && this.cached?.value === value) {
					this.cached = undefined;
				}
				return snapshot;
			});
		this.cached = { at: now, value };
		return value;
	}

	lastSnapshotAt(): number | undefined {
		return this.cached?.at;
	}
}

export interface IParadisHookClassification {
	readonly origin: ParadisHookOrigin;
	/** nested の場合の子エージェント種別（活動ツリーへの投影に使う）。 */
	readonly agentKind: ParadisHookAgentKind | undefined;
	/**
	 * owner を、発信元のプロセスを辿らずに transcript だけで決めた（pid が無い・プロセス表が取れない・発信元の
	 * プロセスが見つからない）。このときは daemon の会話の hook を見分けられないので、受け手が transcript の
	 * 中身（`sessionKind`）でも確かめる。
	 */
	readonly unverified?: true;
	/** invalid にしたときの診断情報（ログ専用。判定には使わない）。 */
	readonly rejection?: IParadisHookRejectionDetail;
}

/** invalid にした分岐の診断情報。 */
export interface IParadisHookRejectionDetail {
	/** pid を使わない判定に落ちたわけ。pid で辿って invalid にしたときは undefined。 */
	readonly identityLoss: ParadisHookIdentityLoss | undefined;
	/** 所有者が pid で決まっているか、transcript だけで決まっているか。 */
	readonly ownerPinnedBy: 'pid' | 'transcript';
	readonly ownerTranscriptPath: string | undefined;
	/** 所有者の記録を最後に更新した時刻。 */
	readonly ownerAt: number;
	/** 使ったプロセス表の控えの古さ（取っていなければ undefined）。 */
	readonly snapshotAgeMs: number | undefined;
}

/**
 * ペイントークンごとのhook発信元所有権レジストリ。
 * `/agent-hook` ingress が全副作用（hookバス発火・ペイン状態更新）より前に参照する。
 */
export class ParadisAgentHookOwnership {

	private readonly owners = new Map<string, IOwnerRecord>();

	/**
	 * @param selfPid Para Code 自身のプロセス。これとその祖先はペインの外なので、hook の祖先チェーンから外す
	 * （Para Code をエージェントの中から起動すると、その外側のエージェントが全ペインの所有者になり、
	 * ペインの中のエージェントの hook がすべて nested 扱いになるため）。
	 */
	constructor(
		private readonly inspector: IParadisHookProcessInspector = new ParadisDefaultHookProcessInspector(),
		private readonly selfPid: number = process.pid,
	) { }

	/** ペイン終了時に所有権を破棄する。 */
	clear(token: string): void {
		this.owners.delete(token);
	}

	async classify(input: { readonly token: string; readonly hookPid: number | undefined; readonly transcriptPath: string | undefined; readonly at: number }): Promise<IParadisHookClassification> {
		try {
			return await this.doClassify(input);
		} catch {
			// 分類の失敗でhookを失わない: 所有権が不明なら fail-closed ポリシーへ。
			return this.classifyWithoutIdentity(input.token, input.transcriptPath, input.at, undefined, 'error', undefined);
		}
	}

	private async doClassify(input: { readonly token: string; readonly hookPid: number | undefined; readonly transcriptPath: string | undefined; readonly at: number }): Promise<IParadisHookClassification> {
		const { token, hookPid, transcriptPath, at } = input;
		const eventKind = transcriptPath !== undefined ? paradisHookAgentKindForTranscript(transcriptPath) : undefined;
		if (hookPid === undefined) {
			return this.classifyWithoutIdentity(token, transcriptPath, at, eventKind, 'no-pid', undefined);
		}
		const snapshot = await this.inspector.snapshot();
		const snapshotAgeMs = this.snapshotAgeMs();
		if (snapshot === undefined) {
			return this.classifyWithoutIdentity(token, transcriptPath, at, eventKind, 'no-snapshot', snapshotAgeMs);
		}
		const chain = this.chainInsidePanes(snapshot, hookPid);
		// daemon の配下の会話は、このペインの所有者にも子エージェントにもしない（所有者の記録も触らない）。
		if (chain.some(entry => paradisIsClaudeBackgroundHostCommand(entry.command))) {
			return { origin: 'background', agentKind: eventKind ?? 'claude' };
		}
		const emitter = this.findEmitter(chain, eventKind);
		if (emitter === undefined) {
			const identityLoss = chain.length > 0 ? 'no-emitter' : snapshot.has(hookPid) ? 'pid-outside-panes' : 'pid-not-in-snapshot';
			return this.classifyWithoutIdentity(token, transcriptPath, at, eventKind, identityLoss, snapshotAgeMs);
		}
		const emitterKind = paradisHookAgentKindFromCommandLine(emitter.command);
		let owner = this.owners.get(token);
		const ownerProcess = owner?.pid !== undefined ? snapshot.get(owner.pid) : undefined;
		const ownerAlive = owner?.pid !== undefined && ownerProcess !== undefined && this.startKeyMatches(owner.startKey, ownerProcess.startKey);
		if (owner === undefined || owner.pid === undefined || !ownerAlive) {
			// 所有者が未確定（初回・旧スクリプト由来のtranscriptのみのレコード）または死亡
			// （PID再利用含む）→ このチェーンで「ペインのシェルに最も近い（最外側の）エージェント
			// プロセス」を所有者にする。emitter 自身を無条件に所有者へすると、所有者の最初の
			// hookより先にネストした子のhookが届いた場合（shared process 再起動直後など）に
			// 子が所有者として bootstrap されてしまう。
			// 既知の制限: tmux サーバーは最初に起こしたペインのトークンを環境に持ち続けるので、
			// 別のペインから同じサーバーに作ったセッションのエージェントも、このペインのトークンで
			// hookを送ってくる。所有者が終わった後はそれが後継になり、状態がこのペインに出る
			// （NOTES.md の「hook 所有者判定の既知の制限」参照）。後継をペインのシェルの配下に絞ると、
			// 同じペインで tmux のエージェントを起動し直したときに状態が出なくなるので絞らない。
			const outermost = this.findOutermostAgent(chain) ?? emitter;
			owner = {
				pid: outermost.pid, startKey: outermost.startKey,
				agentKind: paradisHookAgentKindFromCommandLine(outermost.command),
				transcriptPath: outermost.pid === emitter.pid ? transcriptPath : undefined, at,
			};
			this.setOwner(token, owner);
		}
		if (owner.pid === emitter.pid && this.startKeyMatches(owner.startKey, emitter.startKey)) {
			// 所有者自身からのイベント。/clear 等でtranscriptが変わるrebindも許可する。
			this.setOwner(token, { ...owner, startKey: owner.startKey ?? emitter.startKey, transcriptPath: transcriptPath ?? owner.transcriptPath, at });
			return { origin: 'owner', agentKind: emitterKind };
		}
		const emitterIndex = chain.findIndex(entry => entry.pid === emitter.pid);
		const ownerPid = owner.pid;
		const ownerIsAncestor = emitterIndex >= 0 && chain.slice(emitterIndex + 1).some(entry => entry.pid === ownerPid);
		if (ownerIsAncestor) {
			// 生存中の所有者の配下で動く別エージェントプロセス = ネストした子エージェント。
			return { origin: 'nested', agentKind: emitterKind };
		}
		// 所有者が生存しているのに祖先関係が無い = 兄弟や誤配送。ペイン状態を触らせない。
		return {
			origin: 'invalid', agentKind: emitterKind,
			rejection: { identityLoss: undefined, ownerPinnedBy: 'pid', ownerTranscriptPath: owner.transcriptPath, ownerAt: owner.at, snapshotAgeMs },
		};
	}

	/** チェーン内で最も祖先側（ペインのシェルに最も近い）のエージェントプロセスを返す。 */
	private findOutermostAgent(chain: readonly IParadisHookProcessInfo[]): IParadisHookProcessInfo | undefined {
		for (let i = chain.length - 1; i >= 0; i--) {
			if (paradisHookAgentKindFromCommandLine(chain[i].command) !== undefined) {
				return chain[i];
			}
		}
		return undefined;
	}

	/**
	 * 発信元プロセスを特定できないhook（旧v2スクリプト・ps失敗・プロセス消滅）の fail-closed 判定:
	 * 所有者が既知なら、同じtranscriptへのイベントとtranscript無しイベント（状態のみのGET
	 * フォールバック等）だけを通し、別transcriptへのrebindは拒否する。
	 */
	private classifyWithoutIdentity(token: string, transcriptPath: string | undefined, at: number, eventKind: ParadisHookAgentKind | undefined, identityLoss: ParadisHookIdentityLoss, snapshotAgeMs: number | undefined): IParadisHookClassification {
		const owner = this.owners.get(token);
		if (owner === undefined) {
			this.setOwner(token, { pid: undefined, startKey: undefined, agentKind: eventKind, transcriptPath, at });
			return { origin: 'owner', agentKind: eventKind, unverified: true };
		}
		if (transcriptPath === undefined || owner.transcriptPath === undefined || owner.transcriptPath === transcriptPath) {
			if (owner.pid === undefined) {
				this.setOwner(token, { ...owner, transcriptPath: owner.transcriptPath ?? transcriptPath, agentKind: owner.agentKind ?? eventKind, at });
			}
			return { origin: 'owner', agentKind: eventKind ?? owner.agentKind, unverified: true };
		}
		return {
			origin: 'invalid', agentKind: eventKind,
			rejection: { identityLoss, ownerPinnedBy: owner.pid !== undefined ? 'pid' : 'transcript', ownerTranscriptPath: owner.transcriptPath, ownerAt: owner.at, snapshotAgeMs },
		};
	}

	/** 直近に使ったプロセス表の控えの古さ（診断ログ用）。 */
	private snapshotAgeMs(): number | undefined {
		try {
			const takenAt = this.inspector.lastSnapshotAt?.();
			return takenAt === undefined ? undefined : Math.max(0, Date.now() - takenAt);
		} catch {
			// 診断のための値なので、取れなくても判定には影響させない。
			return undefined;
		}
	}

	/** {@link ancestorChain} のうち、Para Code 自身（とその祖先）に届く手前まで。 */
	private chainInsidePanes(snapshot: ReadonlyMap<number, IParadisHookProcessInfo>, hookPid: number): IParadisHookProcessInfo[] {
		const outside = new Set(this.ancestorChain(snapshot, this.selfPid).map(entry => entry.pid));
		const chain = this.ancestorChain(snapshot, hookPid);
		const cut = chain.findIndex(entry => outside.has(entry.pid));
		return cut >= 0 ? chain.slice(0, cut) : chain;
	}

	/** hookPid 自身を先頭に、親方向の祖先チェーンを返す（循環・深さ上限つき）。 */
	private ancestorChain(snapshot: ReadonlyMap<number, IParadisHookProcessInfo>, hookPid: number): IParadisHookProcessInfo[] {
		const chain: IParadisHookProcessInfo[] = [];
		const seen = new Set<number>();
		let current = snapshot.get(hookPid);
		while (current !== undefined && chain.length < MAX_ANCESTOR_DEPTH && !seen.has(current.pid)) {
			seen.add(current.pid);
			chain.push(current);
			current = current.ppid !== undefined && current.ppid > 0 ? snapshot.get(current.ppid) : undefined;
		}
		return chain;
	}

	/**
	 * チェーン内で「イベントのtranscript種別と一致する最も近いエージェントプロセス」を返す。
	 * 種別不明イベント（transcript無し）は最も近い任意のエージェントプロセスを採用する。
	 * 注意: 単なる「祖先に所有者PIDがいるか」では判定しない。親エージェントは子エージェントの
	 * 祖先にも必ず現れるため、それでは子のhookを所有者由来として誤許可してしまう。
	 *
	 * 見つけたプロセスの直接の親が同じ種類の「起動役の形」（npm 版 codex の `node …/bin/codex`、
	 * Para Code のランチャー、`exec` しないラッパースクリプト等）なら、本体を子として起動して親に
	 * 残っているだけなので1体とみなし、発信元を親へずらす。親が本体の形（argv[0] が `claude` /
	 * `codex`）なら止める。本体が直接起動した子のエージェントは、これまでどおり別の発信元になる。
	 */
	private findEmitter(chain: readonly IParadisHookProcessInfo[], eventKind: ParadisHookAgentKind | undefined): IParadisHookProcessInfo | undefined {
		for (let i = 0; i < chain.length; i++) {
			const kind = paradisHookAgentKindFromCommandLine(chain[i].command);
			if (kind === undefined || (eventKind !== undefined && kind !== eventKind)) {
				continue;
			}
			let emitterIndex = i;
			while (emitterIndex + 1 < chain.length) {
				const parent = agentMatchOfCommand(chain[emitterIndex + 1].command, 0);
				if (parent === undefined || !parent.launcher || parent.kind !== kind) {
					break;
				}
				emitterIndex++;
			}
			return chain[emitterIndex];
		}
		return undefined;
	}

	private startKeyMatches(recorded: string | undefined, observed: string | undefined): boolean {
		if (recorded === undefined || observed === undefined) {
			return true;
		}
		return recorded === observed;
	}

	private setOwner(token: string, record: IOwnerRecord): void {
		this.owners.delete(token);
		if (this.owners.size >= MAX_OWNER_RECORDS) {
			let oldestToken: string | undefined;
			let oldestAt = Number.POSITIVE_INFINITY;
			for (const [candidate, value] of this.owners) {
				if (value.at < oldestAt) {
					oldestAt = value.at;
					oldestToken = candidate;
				}
			}
			if (oldestToken !== undefined) {
				this.owners.delete(oldestToken);
			}
		}
		this.owners.set(token, record);
	}
}
