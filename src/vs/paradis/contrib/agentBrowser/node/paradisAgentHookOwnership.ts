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
//     ただし、ペインのシェルの子孫の `claude attach <id>` が見ている会話は、その attach を所有者にする
//   - 所有者がいない（未確定・pid 不明・死亡）のに、発信元がペインのシェルの子孫でなく、Claude Code の
//     Codex plugin が起動した codex と判定できる → invalid（plugin が detached で起動した `codex app-server` が、
//     継承したトークンで所有者になるのを防ぐ。素の `codex` の共有 daemon や tmux 等は従来どおり後継になれる）
// PIDが取れない場合（旧スクリプト・プロセス消滅・ps失敗）は fail-closed:
// 既知の所有者と同じtranscriptへのイベントだけを通す。

import { exec } from 'child_process';
import { statSync } from 'fs';
import { open } from 'fs/promises';
import { promisify } from 'util';
import { ParadisHookIdentityLoss } from '../common/paradisAgentHookDropLog.js';
import { paradisClaudeConfigDir, paradisIsWithinCodexHome } from './paradisAgentHome.js';
import { IParadisClaudeJob, paradisCachedClaudeJobsReader, paradisClaudeAttachNameQuery, paradisClaudeJobOwnsSession, paradisSelectClaudeJobByName } from './paradisClaudeJobNames.js';

const execAsync = promisify(exec);

const EXEC_TIMEOUT_MS = 5_000;
/** プロセス表スナップショットの再利用時間。hookのバーストで ps/CIM 実行を連発させない。 */
const SNAPSHOT_TTL_MS = 2_000;
/** 祖先チェーンの探索上限（wrapper シェルの多段起動を考慮しても十分な深さ）。 */
const MAX_ANCESTOR_DEPTH = 15;
/** 所有者レコードの上限（ペイン数を大きく超える値。無制限な成長の防止のみが目的）。 */
const MAX_OWNER_RECORDS = 4_096;
/** ペインのシェルの子孫かを確かめるときに辿る深さの上限（祖先チェーンの上限より深い入れ子も拾う）。 */
const MAX_PANE_DESCENT_DEPTH = 64;
/**
 * rollout の先頭から読む量。session_meta の行は 20KB 前後あるが、`originator` は先頭 1KB 以内にある
 * （Codex 0.157 の rollout で実測。後ろに長い base_instructions が続く）。
 */
const ROLLOUT_HEAD_BYTES = 16 * 1024;
/** rollout の起動元の控えの上限。 */
const MAX_ROLLOUT_ORIGINATOR_CACHE = 256;
const cachedClaudeJobsReader = paradisCachedClaudeJobsReader();
/** `claude attach <名前>` の名前を引き直すときに読む背景セッションの記録（既定の Claude Code の設定ホーム）。 */
function defaultClaudeJobsReader(): Promise<readonly IParadisClaudeJob[]> {
	return cachedClaudeJobsReader(paradisClaudeConfigDir());
}

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

interface IProcessIdentity {
	readonly pid: number;
	readonly startKey: string | undefined;
}

interface IOwnerRecord {
	pid: number | undefined;
	startKey: string | undefined;
	agentKind: ParadisHookAgentKind | undefined;
	transcriptPath: string | undefined;
	at: number;
	/**
	 * 所有者が `claude attach <id>` のとき、見ている会話を動かす daemon の配下のプロセス（`claude bg-spare`）。
	 * 同じプロセスからの hook は、/clear で会話 id が変わっても所有者のものとして通す。
	 */
	attachedHost?: IProcessIdentity;
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

/**
 * `claude attach <id>` の `<id>` として受け付ける形（`claude agents` が出す 8 桁の短い id から完全な会話 id まで）。
 * mobileRelay の `paradisIsClaudeSessionIdPrefix` と同じ規約。8 桁より短い id は無関係な会話に前方一致しやすい。
 */
const CLAUDE_ATTACH_ID_PATTERN = /^[0-9A-Fa-f]{8}[0-9A-Fa-f-]{0,28}$/;

/**
 * `claude attach <id>`（2.1.289 で実測。ps では `claude attach d527839f`）なら `<id>` を小文字で返す。
 * 会話の本体は daemon の配下（`claude bg-spare`）で動き、このプロセスは表示役だけを持つ。
 */
export function paradisClaudeAttachTargetFromCommandLine(command: string): string | undefined {
	const tokens = tokenizeCommandLine(command);
	const start = claudeArgumentsStart(tokens);
	if (start === undefined || tokens[start]?.value !== 'attach') {
		return undefined;
	}
	const target = tokens[start + 1]?.value;
	return target !== undefined && CLAUDE_ATTACH_ID_PATTERN.test(target) ? target.toLowerCase() : undefined;
}

/**
 * `claude attach <名前>`（2.1.290 から）なら、名前の照合に使う形（前後の空白を除いて小文字）を返す。id の形の引数は
 * paradisClaudeAttachTargetFromCommandLine が読むので、ここでは undefined。
 *
 * プロセス表の起動行は引数を空白でつないだもので、引用符は残らない（POSIX の ps）。CLI は名前を 1 つの引数としてしか
 * 受け付けないので、`attach` より後ろを全部（空白を含めて）名前とみなす。Windows の CommandLine には打った引用符が
 * 残るので、全体を囲む引用符だけを外す。
 */
export function paradisClaudeAttachNameFromCommandLine(command: string, platform: NodeJS.Platform = process.platform): string | undefined {
	const tokens = tokenizeCommandLine(command);
	const start = claudeArgumentsStart(tokens);
	if (start === undefined || tokens[start]?.value !== 'attach' || tokens.length <= start + 1) {
		return undefined;
	}
	if (paradisClaudeAttachTargetFromCommandLine(command) !== undefined) {
		return undefined;
	}
	let argument = command.slice(tokens[start + 1].start).trim();
	if (platform === 'win32' && argument.length >= 2 && argument.startsWith('"') && argument.endsWith('"')) {
		argument = argument.slice(1, -1);
	}
	return paradisClaudeAttachNameQuery(argument);
}

/** ペインの `claude attach` が名指しする会話。id の先頭か、背景セッションの名前。 */
type ClaudeAttachTarget = { readonly kind: 'id'; readonly idPrefix: string } | { readonly kind: 'name'; readonly query: string };

function sessionIdOfHook(sessionId: string | undefined, transcriptPath: string | undefined): readonly string[] {
	const fromTranscript = transcriptPath !== undefined ? /(?<sessionId>[^\\/]+)\.jsonl$/i.exec(transcriptPath)?.groups?.sessionId : undefined;
	return [sessionId, fromTranscript].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
}

/**
 * サーバーがペインのシェルの外（launchd・init の子）に住む端末多重化ソフト。中のエージェントの祖先はペインの
 * シェルを通らないので、所有者の後継をペインのシェルの子孫に絞る判定から外す（NOTES.md「hook 所有者判定の
 * 既知の制限」）。Linux の tmux サーバーは `tmux: server (…)` と見えるので末尾の `:` も許す。
 */
/**
 * Claude Code の Codex plugin（`openai-codex` marketplace の `codex`）が detached で起動するスクリプト。
 * `app-server-broker.mjs serve …` は `codex app-server` の親に残り、`codex-companion.mjs task-worker …` は
 * バックグラウンドの作業を動かす（plugin 1.0.6 で実測。どちらも親は PID 1 で、ペインのトークンを env に持つ）。
 * Windows でも Win32_Process の CommandLine に同じパスが出る（自分のユーザーのプロセスなら取れる）。
 */
const CODEX_PLUGIN_SCRIPT = /(?:^|[\\/\s"'])(?:app-server-broker|codex-companion)\.mjs(?:$|[\s"'])/i;
/** plugin のキャッシュ・marketplace のパス（`…/plugins/cache/openai-codex/…`・`…/plugins/marketplaces/openai-codex/…`）。 */
const CODEX_PLUGIN_PATH = /[\\/]plugins[\\/](?:cache|marketplaces)[\\/]openai-codex[\\/]/i;

/** Claude Code の Codex plugin が起動したプロセス（broker・companion）の起動行か。 */
export function paradisIsCodexPluginCommand(command: string): boolean {
	return CODEX_PLUGIN_SCRIPT.test(command) || CODEX_PLUGIN_PATH.test(command);
}

/**
 * rollout の session_meta の起動元（`originator`）。Codex plugin が app-server へ名乗る値は "Claude Code"。
 * 手で起動した codex は `codex-tui`・`codex_exec` なので当たらない（2026-10-06 に手元の rollout で実測）。
 */
const ROLLOUT_ORIGINATOR = /"originator"\s*:\s*"(?<originator>[^"]*)"/;
const CLAUDE_CODE_ORIGINATOR = 'Claude Code';

/** rollout の先頭（最初の行の session_meta）を読む。読めなければ undefined。 */
async function readRolloutHead(transcriptPath: string): Promise<string | undefined> {
	let handle;
	try {
		handle = await open(transcriptPath, 'r');
		const buffer = Buffer.alloc(ROLLOUT_HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, ROLLOUT_HEAD_BYTES, 0);
		return buffer.toString('utf8', 0, bytesRead);
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

const TERMINAL_MULTIPLEXER_BASENAMES = /^(?:tmux|zellij|screen|dtach|abduco)(?::)?$/;

function isTerminalMultiplexerCommand(command: string): boolean {
	const first = tokenizeCommandLine(command)[0]?.value;
	return first !== undefined && TERMINAL_MULTIPLEXER_BASENAMES.test(normalizedBasename(first));
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
	/** 所有者のいないペインへ、ペインのシェルの子孫でないエージェントが送った hook だった。 */
	readonly outsidePane?: true;
}

/** {@link ParadisAgentHookOwnership.classify} の入力。 */
export interface IParadisHookClassifyInput {
	readonly token: string;
	readonly hookPid: number | undefined;
	readonly transcriptPath: string | undefined;
	readonly at: number;
	/** hook の会話 id（`claude attach <id>` の会話との照合に使う）。 */
	readonly sessionId?: string;
	/**
	 * ペインのシェルの pid（手元のペインで分かるときだけ）。分からないとき（SSH・WSL などの接続先、再起動直後で
	 * ペインがまだ同期していない）・プロセス表に無いときは、ペインのシェルを使う判定をすべて飛ばして従来どおりに動く。
	 */
	readonly paneShellPid?: number;
}

/**
 * ペイントークンごとのhook発信元所有権レジストリ。
 * `/agent-hook` ingress が全副作用（hookバス発火・ペイン状態更新）より前に参照する。
 */
export class ParadisAgentHookOwnership {

	private readonly owners = new Map<string, IOwnerRecord>();
	/** rollout ごとの「Claude Code が起動元か」（session_meta は書き換わらないので一度読めば足りる）。 */
	private readonly rolloutFromClaudeCode = new Map<string, boolean>();

	/**
	 * @param selfPid Para Code 自身のプロセス。これとその祖先はペインの外なので、hook の祖先チェーンから外す
	 * （Para Code をエージェントの中から起動すると、その外側のエージェントが全ペインの所有者になり、
	 * ペインの中のエージェントの hook がすべて nested 扱いになるため）。
	 * @param readTranscriptHead rollout の先頭を読む（テストでは fake へ差し替える）。
	 */
	constructor(
		private readonly inspector: IParadisHookProcessInspector = new ParadisDefaultHookProcessInspector(),
		private readonly selfPid: number = process.pid,
		private readonly readTranscriptHead: (transcriptPath: string) => Promise<string | undefined> = readRolloutHead,
		private readonly readClaudeJobs: () => Promise<readonly IParadisClaudeJob[]> = defaultClaudeJobsReader,
	) { }

	/**
	 * ペインの `claude attach <名前>` のうち、hook の会話（会話 id か transcript のファイル名）を名指すものの pid。
	 * 名前は背景セッションの記録から引き直す（一致する job が 1 つに決まらなければ当てない）。所有者の記録を
	 * 読む前に済ませ、読んでから書くまでの間に await を挟まない（同じペインの hook の分類が並ぶため）。
	 */
	private async attachesNamingSession(attaches: readonly { readonly pid: number; readonly target: ClaudeAttachTarget }[], sessionId: string | undefined, transcriptPath: string | undefined): Promise<ReadonlySet<number>> {
		const named = attaches.filter(attach => attach.target.kind === 'name');
		const candidates = sessionIdOfHook(sessionId, transcriptPath);
		const result = new Set<number>();
		if (named.length === 0 || candidates.length === 0) {
			return result;
		}
		const jobs = await this.readClaudeJobs().catch(() => []);
		for (const attach of named) {
			const job = attach.target.kind === 'name' ? paradisSelectClaudeJobByName(jobs, attach.target.query) : undefined;
			if (job !== undefined && candidates.some(candidate => paradisClaudeJobOwnsSession(job, candidate))) {
				result.add(attach.pid);
			}
		}
		return result;
	}

	/** ペイン終了時に所有権を破棄する。 */
	clear(token: string): void {
		this.owners.delete(token);
	}

	async classify(input: IParadisHookClassifyInput): Promise<IParadisHookClassification> {
		try {
			return await this.doClassify(input);
		} catch {
			// 分類の失敗でhookを失わない: 所有権が不明なら fail-closed ポリシーへ。
			return this.classifyWithoutIdentity(input.token, input.transcriptPath, input.at, undefined, 'error', undefined);
		}
	}

	private async doClassify(input: IParadisHookClassifyInput): Promise<IParadisHookClassification> {
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
		const paneShellPid = input.paneShellPid !== undefined && snapshot.has(input.paneShellPid) ? input.paneShellPid : undefined;
		// daemon の配下の会話は、このペインの所有者にも子エージェントにもしない（所有者の記録も触らない）。
		// 例外は、このペインの `claude attach <id>` が見ている会話（とその配下の子エージェント）だけ。
		const hostIndex = chain.findIndex(entry => paradisIsClaudeBackgroundHostCommand(entry.command));
		if (hostIndex >= 0) {
			return this.classifyDaemonHosted(token, snapshot, chain, hostIndex, eventKind, input, paneShellPid);
		}
		const emitter = this.findEmitter(chain, eventKind);
		if (emitter === undefined) {
			const identityLoss = chain.length > 0 ? 'no-emitter' : snapshot.has(hookPid) ? 'pid-outside-panes' : 'pid-not-in-snapshot';
			return this.classifyWithoutIdentity(token, transcriptPath, at, eventKind, identityLoss, snapshotAgeMs);
		}
		const emitterKind = paradisHookAgentKindFromCommandLine(emitter.command);
		let owner = this.owners.get(token);
		if (owner === undefined || owner.pid === undefined || !this.isOwnerAlive(owner, snapshot)) {
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
			// Claude Code の Codex plugin が detached で起動した `codex app-server`（親は PID 1 の broker）は、
			// ペインの外で動くのにトークンだけを継承している。所有者のいない隙（`claude attach` の会話・pid の無い
			// 所有者・Para Code の再起動直後）にペインの会話を奪わないよう、ペインのシェルの子孫でない発信元のうち
			// plugin 由来と判定できるものは後継にしない。素の `codex` の共有 daemon（TUI の起動し直しの後は親を
			// 辿ってもペインのシェルに届かない）は従来どおり後継になれる。tmux 等のサーバー配下も上の既知の制限のとおり絞らない。
			if (paneShellPid !== undefined && !chain.some(entry => isTerminalMultiplexerCommand(entry.command)) && !this.isDescendantOf(snapshot, emitter.pid, paneShellPid)
				&& await this.isCodexPluginOrigin(chain, emitter, eventKind, transcriptPath)) {
				return {
					origin: 'invalid', agentKind: emitterKind,
					rejection: {
						identityLoss: undefined, ownerPinnedBy: owner?.pid !== undefined ? 'pid' : 'transcript',
						ownerTranscriptPath: owner?.transcriptPath, ownerAt: owner?.at ?? at, snapshotAgeMs, outsidePane: true,
					},
				};
			}
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

	/**
	 * 祖先に Claude Code の daemon（`chain[hostIndex]`、hook に最も近い `bg-spare` 等）がいる hook の判定。
	 *
	 * ペインのシェルの子孫に `claude attach <id|名前>` がいて、hook が daemon の会話そのもの（daemon のプロセスとの間に
	 * 別のエージェントがいない）で、会話 id が `<id>` に前方一致する（名前なら、名前で 1 つに決まる背景セッションの
	 * 会話である）なら、その attach を所有者にする。以後、同じ
	 * daemon のプロセスからの hook は /clear で会話 id が変わっても所有者のものとして通す。attach が終われば
	 * 所有者は死んだ扱いになり、daemon の会話はまた background に戻る。
	 * 所有者の attach が見ている会話の配下の別エージェントは nested。それ以外は従来どおり background。
	 */
	private async classifyDaemonHosted(
		token: string,
		snapshot: ReadonlyMap<number, IParadisHookProcessInfo>,
		chain: readonly IParadisHookProcessInfo[],
		hostIndex: number,
		eventKind: ParadisHookAgentKind | undefined,
		input: IParadisHookClassifyInput,
		paneShellPid: number | undefined,
	): Promise<IParadisHookClassification> {
		const host = chain[hostIndex];
		const inner = this.findEmitter(chain.slice(0, hostIndex), eventKind);
		const attaches = inner === undefined && paneShellPid !== undefined && (eventKind === undefined || eventKind === 'claude')
			? this.paneAttaches(snapshot, paneShellPid) : [];
		const namingAttaches = await this.attachesNamingSession(attaches, input.sessionId, input.transcriptPath);
		const hookSessionIds = sessionIdOfHook(input.sessionId, input.transcriptPath);
		const owner = this.owners.get(token);
		const ownerAlive = this.isOwnerAlive(owner, snapshot);
		if (attaches.length > 0) {
			for (const attach of attaches) {
				const ownerIsAttach = owner?.pid === attach.pid && this.startKeyMatches(owner.startKey, attach.startKey);
				const sameHost = ownerIsAttach && owner?.attachedHost !== undefined
					&& owner.attachedHost.pid === host.pid && this.startKeyMatches(owner.attachedHost.startKey, host.startKey);
				const target = attach.target;
				const namesSession = target.kind === 'id'
					? hookSessionIds.some(candidate => candidate.toLowerCase().startsWith(target.idPrefix))
					: namingAttaches.has(attach.pid);
				if (!sameHost && !namesSession) {
					continue;
				}
				if (ownerAlive && !ownerIsAttach) {
					// 生きている別の所有者（attach の外側の claude 等）の席は奪わない。
					break;
				}
				this.setOwner(token, {
					pid: attach.pid, startKey: attach.startKey, agentKind: 'claude',
					transcriptPath: input.transcriptPath ?? (ownerIsAttach ? owner?.transcriptPath : undefined), at: input.at,
					attachedHost: { pid: host.pid, startKey: host.startKey },
				});
				return { origin: 'owner', agentKind: 'claude' };
			}
		}
		const attachedHost = owner?.attachedHost;
		if (inner !== undefined && ownerAlive && attachedHost !== undefined && host.pid === attachedHost.pid && this.startKeyMatches(attachedHost.startKey, host.startKey)) {
			// 所有者の attach が見ている会話の配下で動く別エージェント = 子エージェント。
			return { origin: 'nested', agentKind: paradisHookAgentKindFromCommandLine(inner.command) };
		}
		return { origin: 'background', agentKind: eventKind ?? 'claude' };
	}

	/**
	 * 発信元が Claude Code の Codex plugin の起動した codex か。祖先（発信元を含む）に plugin の broker・companion が
	 * いるか、rollout の session_meta の `originator` が "Claude Code" なら true。起動行が取れない（Windows で
	 * CommandLine が空になり Name だけが見える等）ときも rollout で判定できる。rollout がまだ無い（Codex は最初の
	 * ターンで rollout を作る）ときは判定できないので false（後継にする側）に倒す。
	 */
	private async isCodexPluginOrigin(chain: readonly IParadisHookProcessInfo[], emitter: IParadisHookProcessInfo, eventKind: ParadisHookAgentKind | undefined, transcriptPath: string | undefined): Promise<boolean> {
		const emitterIndex = chain.findIndex(entry => entry.pid === emitter.pid);
		if (chain.slice(Math.max(0, emitterIndex)).some(entry => paradisIsCodexPluginCommand(entry.command))) {
			return true;
		}
		if (transcriptPath === undefined || eventKind !== 'codex') {
			return false;
		}
		const cached = this.rolloutFromClaudeCode.get(transcriptPath);
		if (cached !== undefined) {
			return cached;
		}
		const head = await this.readTranscriptHead(transcriptPath);
		if (head === undefined || head.length === 0) {
			// rollout がまだ無い・読めない。次の hook で読み直す。
			return false;
		}
		const newline = head.indexOf('\n');
		const firstLine = newline >= 0 ? head.slice(0, newline) : head;
		if (!firstLine.includes('"session_meta"')) {
			// 先頭の行が書きかけ。次の hook で読み直す。
			return false;
		}
		const originator = ROLLOUT_ORIGINATOR.exec(firstLine)?.groups?.originator;
		if (originator === undefined) {
			// session_meta の行が `originator` の手前までしか書かれていない。覚えずに次の hook で読み直す。
			return false;
		}
		const fromClaudeCode = originator === CLAUDE_CODE_ORIGINATOR;
		if (this.rolloutFromClaudeCode.size >= MAX_ROLLOUT_ORIGINATOR_CACHE) {
			this.rolloutFromClaudeCode.clear();
		}
		this.rolloutFromClaudeCode.set(transcriptPath, fromClaudeCode);
		return fromClaudeCode;
	}

	/** ペインのシェルの子孫にいる `claude attach <id|名前>` の一覧。 */
	private paneAttaches(snapshot: ReadonlyMap<number, IParadisHookProcessInfo>, paneShellPid: number): { readonly pid: number; readonly startKey: string | undefined; readonly target: ClaudeAttachTarget }[] {
		const result: { readonly pid: number; readonly startKey: string | undefined; readonly target: ClaudeAttachTarget }[] = [];
		for (const entry of snapshot.values()) {
			// daemon の配下の hook ごとにプロセス表を全部なめるので、字句解析の前に安く絞る。
			if (!entry.command.includes('attach')) {
				continue;
			}
			const idPrefix = paradisClaudeAttachTargetFromCommandLine(entry.command);
			const query = idPrefix === undefined ? paradisClaudeAttachNameFromCommandLine(entry.command) : undefined;
			const target: ClaudeAttachTarget | undefined = idPrefix !== undefined ? { kind: 'id', idPrefix } : query !== undefined ? { kind: 'name', query } : undefined;
			if (target !== undefined && this.isDescendantOf(snapshot, entry.pid, paneShellPid)) {
				result.push({ pid: entry.pid, startKey: entry.startKey, target });
			}
		}
		return result;
	}

	/**
	 * `pid` が `ancestorPid` 自身かその子孫か（循環・深さ上限つき）。自分自身も含めるのは、ペインのシェルが
	 * `exec claude` で置き換わったときや、ペインの最初のプロセスがエージェント（またはそのランチャー）のときに、
	 * ペインのプロセスそのものが発信元になるため。
	 */
	private isDescendantOf(snapshot: ReadonlyMap<number, IParadisHookProcessInfo>, pid: number, ancestorPid: number): boolean {
		if (pid === ancestorPid) {
			return true;
		}
		const seen = new Set<number>();
		let current = snapshot.get(pid);
		for (let depth = 0; current !== undefined && depth < MAX_PANE_DESCENT_DEPTH && !seen.has(current.pid); depth++) {
			seen.add(current.pid);
			const parent = current.ppid;
			if (parent === undefined || parent <= 0) {
				return false;
			}
			if (parent === ancestorPid) {
				return true;
			}
			current = snapshot.get(parent);
		}
		return false;
	}

	private isOwnerAlive(owner: IOwnerRecord | undefined, snapshot: ReadonlyMap<number, IParadisHookProcessInfo>): boolean {
		const ownerProcess = owner?.pid !== undefined ? snapshot.get(owner.pid) : undefined;
		return ownerProcess !== undefined && this.startKeyMatches(owner?.startKey, ownerProcess.startKey);
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
