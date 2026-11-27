/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 見回り（読むだけ）の起動のたびに、制限に要るものを用意する（shared process）。
// - 見回りの cwd: 起動ごとに作る空のフォルダ（Bot のデータのフォルダの下。0700）。Bot の専用フォルダは会話の Bot が
//   書けるので cwd にしない（そこに置かれた `.claude/settings*.json` の allow・hook、`.codex/config.toml`、
//   `AGENTS.override.md` を見回りが読まないように）。中には Bot の指示文の写し（`AGENTS.md`）だけを置く
// - Claude Code: `--settings`（bypass を効かなくする）と、para-browser だけを書いた `--mcp-config` のファイルを、
//   一時ファイルに書いてから置き換える（0600）。中身にトークンは無い（Authorization は `${PARA_CODE_TERMINAL_PANE_ID}` の
//   まま書き、Claude Code が起動した時に展開する。利用者の `~/.claude.json` と同じ形）
// - Codex: 全部のホーム（アカウント）の `config.toml` を読み、para-browser 以外の MCP サーバーの名前と形を集める
// 利用者の設定ファイルへは、見回りのフォルダの親を Claude Code の信頼済みにする 1 項目だけを書く（呼び出し側。
// 起動ごとに新しいフォルダなので、無いと毎回「このフォルダを信頼しますか」で止まる）。

import { promises as fs } from 'fs';
import { generateUuid } from '../../../../base/common/uuid.js';
import { dirname, join } from '../../../../base/common/path.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { paradisClaudeMcpServerEntry } from '../../agentBrowser/common/paradisMcpSetupEncoding.js';
import { IParadisCodexMcpServerRef, PARADIS_BOT_PATROL_CLAUDE_SETTINGS, ParadisBotPatrolLaunchContext, paradisBotPatrolCodexDisabledServers } from '../common/paradisBotTools.js';

/** 読む `config.toml` の大きさの上限（Para Code の MCP の設定と同じ）。 */
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
/** 指示文の写しに入れる 1 ファイルの上限（文字数）。超えた分は切る。 */
const MAX_INSTRUCTION_FILE_CHARS = 64 * 1024;
/** 消さずに残す、前の回の見回りのフォルダの数（Bot ごと。今の回を除く）。 */
const KEEP_PREVIOUS_RUNS = 2;
/** 見回りのフォルダとその親にあってはならないもの（Claude Code・Codex がフォルダから設定・hook・MCP を読む所）。 */
const AGENT_CONFIG_ENTRIES: readonly string[] = ['.claude', '.codex', '.mcp.json', '.git', 'AGENTS.override.md', 'CLAUDE.local.md'];

export interface IParadisBotPatrolLaunchEnvironment {
	/** 設定ファイルを書くフォルダ（Bot のデータのフォルダの中。専用フォルダの外）。 */
	readonly folder: string;
	/** 見回りのフォルダを作る親のフォルダ。 */
	readonly runsFolder: string;
	/** 親を確かめるのを止める所（利用者のホーム。ここより上は見ない）。 */
	readonly stopFolder: string;
	/** para-browser の MCP の口のポート。動いていなければ undefined。 */
	readonly gatewayPort: () => Promise<number | undefined>;
	/** 見回りの Codex が使いうる全部のホームの `config.toml` のパス。 */
	readonly codexConfigFiles: () => readonly string[];
	/** そのフォルダ（と配下）を Claude Code の信頼済みにする。失敗しても投げない。 */
	readonly trustClaudeFolder?: (folder: string) => Promise<void>;
	readonly now?: () => number;
	readonly uuid?: () => string;
}

/** 見回りに渡す Bot の専用フォルダと、写す指示文（名前と中身）。 */
export interface IParadisBotPatrolHome {
	readonly folder: string;
	readonly files: readonly { readonly name: string; readonly text: string }[];
}

/** ファイルの名前に使う Bot の id（id は Para Code が作る uuid だが、念のため名前に使える文字だけにする）。 */
function fileStem(botId: string): string {
	return botId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'bot';
}

async function exists(path: string): Promise<boolean> {
	return fs.lstat(path).then(() => true, () => false);
}

async function readCodexConfig(path: string): Promise<string | undefined | false> {
	try {
		const stat = await fs.stat(path);
		if (!stat.isFile() || stat.size > MAX_CODEX_CONFIG_BYTES) {
			return false;
		}
		return await fs.readFile(path, 'utf8');
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? undefined : false;
	}
}

/** 見回りの指示文（cwd の `AGENTS.md` と、Claude Code の `--append-system-prompt-file`）。 */
export function paradisBotPatrolInstructions(home: IParadisBotPatrolHome): string {
	const parts = [
		'# Look-around',
		'',
		`This terminal is a look-around that Para Code started on a schedule. Your home folder is ${home.folder}. This working folder is not your home: read your files (SOUL.md, MEMORY.md, memory/) in your home folder. Below are copies of your instruction files from your home folder, taken when this look-around started; where they say "this folder", they mean your home folder.`,
	];
	for (const file of home.files) {
		const text = file.text.length > MAX_INSTRUCTION_FILE_CHARS ? `${file.text.slice(0, MAX_INSTRUCTION_FILE_CHARS)}\n…(cut)` : file.text;
		parts.push('', `## ${file.name} (copy)`, '', text.trim());
	}
	return parts.join('\n') + '\n';
}

/** 同じ Bot の前の回の見回りのフォルダを、新しい方から {@link KEEP_PREVIOUS_RUNS} 個だけ残して消す。 */
async function pruneRuns(runsFolder: string, stem: string): Promise<void> {
	const names = (await fs.readdir(runsFolder).catch(() => [] as string[])).filter(name => name.startsWith(`${stem}-`)).sort();
	for (const name of names.slice(0, Math.max(0, names.length - KEEP_PREVIOUS_RUNS))) {
		await fs.rm(join(runsFolder, name), { recursive: true, force: true }).catch(() => undefined);
	}
}

/** 見回りのフォルダの親に、エージェントがフォルダから読む設定があればその場所を返す。 */
async function agentConfigAbove(folder: string, stopFolder: string): Promise<string | undefined> {
	for (let current = folder; current !== stopFolder && dirname(current) !== current; current = dirname(current)) {
		for (const entry of AGENT_CONFIG_ENTRIES) {
			if (await exists(join(current, entry))) {
				return join(current, entry);
			}
		}
	}
	return undefined;
}

/** 見回りの起動に要るものを用意する。用意できなければ断る理由（英文。エージェントと定期実行の記録に出る）。 */
export async function paradisPrepareBotPatrolLaunch(environment: IParadisBotPatrolLaunchEnvironment, agent: 'claude' | 'codex', botId: string, home: IParadisBotPatrolHome): Promise<ParadisBotPatrolLaunchContext | string> {
	let disabledServers: readonly IParadisCodexMcpServerRef[] = [];
	let port = 0;
	if (agent === 'codex') {
		const texts: string[] = [];
		for (const path of environment.codexConfigFiles()) {
			const text = await readCodexConfig(path);
			if (text === false) {
				return 'Para Code could not read a Codex config.toml, so it cannot turn off the other MCP servers for a look-around.';
			}
			if (text !== undefined) {
				texts.push(text);
			}
		}
		const servers = paradisBotPatrolCodexDisabledServers(texts);
		if (servers === undefined) {
			return 'Para Code could not list the MCP servers in a Codex config.toml for certain, so it does not start a look-around (it could not turn the others off).';
		}
		disabledServers = servers;
	} else {
		const gatewayPort = await environment.gatewayPort();
		if (gatewayPort === undefined) {
			return 'The Para Code browser tools are not running, so a look-around cannot start.';
		}
		port = gatewayPort;
	}
	const stem = fileStem(botId);
	const runFolder = join(environment.runsFolder, `${stem}-${(environment.now ?? Date.now)()}-${(environment.uuid ?? generateUuid)().slice(0, 8)}`);
	const instructionsFile = join(runFolder, 'AGENTS.md');
	try {
		await fs.mkdir(environment.runsFolder, { recursive: true, mode: 0o700 });
		await pruneRuns(environment.runsFolder, stem);
		// 新しく作る（既にあれば失敗する）。中は空なので、置くのは指示文の写しだけ
		await fs.mkdir(runFolder, { mode: 0o700 });
		const above = await agentConfigAbove(runFolder, environment.stopFolder);
		if (above !== undefined) {
			return `Para Code found ${above} above the look-around folder, so it does not start a look-around there (Claude Code or Codex could read settings from it).`;
		}
		await paradisWriteFileAtomic(instructionsFile, paradisBotPatrolInstructions(home), { rejectSymlink: true, forceMode: 0o600 });
	} catch {
		return 'Para Code could not prepare the folder for a look-around.';
	}
	if (agent === 'codex') {
		return { agent, runFolder, disabledServers };
	}
	const settingsFile = join(environment.folder, `${stem}.claude-settings.json`);
	const mcpConfigFile = join(environment.folder, `${stem}.claude-mcp.json`);
	try {
		await fs.mkdir(environment.folder, { recursive: true, mode: 0o700 });
		await paradisWriteFileAtomic(settingsFile, JSON.stringify(PARADIS_BOT_PATROL_CLAUDE_SETTINGS, undefined, '\t') + '\n', { rejectSymlink: true, forceMode: 0o600 });
		await paradisWriteFileAtomic(mcpConfigFile, JSON.stringify({ mcpServers: { 'para-browser': paradisClaudeMcpServerEntry(port) } }, undefined, '\t') + '\n', { rejectSymlink: true, forceMode: 0o600 });
	} catch {
		return 'Para Code could not write the read-only settings for a look-around.';
	}
	await environment.trustClaudeFolder?.(environment.runsFolder);
	return { agent, runFolder, homeFolder: home.folder, instructionsFile, settingsFile, mcpConfigFile };
}
