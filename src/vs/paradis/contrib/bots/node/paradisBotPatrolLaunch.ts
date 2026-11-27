/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 見回り（読むだけ）の起動のたびに、制限に要るものを用意する（shared process）。
// - Claude Code: `--settings`（bypass を効かなくする）と、para-browser だけを書いた `--mcp-config` のファイルを、Bot の
//   データのフォルダ（専用フォルダの外。Bot が書き換えられない所）に 0600 で書く。中身にトークンは無い（Authorization は
//   `${PARA_CODE_TERMINAL_PANE_ID}` のまま書き、Claude Code が起動した時に展開する。利用者の `~/.claude.json` と同じ形）
// - Codex: 全部のホーム（アカウント）の `config.toml` を読み、para-browser 以外の MCP サーバーの名前と形を集める
// 利用者の設定ファイルには何も書かない。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { paradisClaudeMcpServerEntry } from '../../agentBrowser/common/paradisMcpSetupEncoding.js';
import { PARADIS_BOT_PATROL_CLAUDE_SETTINGS, ParadisBotPatrolLaunchContext, paradisBotPatrolCodexDisabledServers } from '../common/paradisBotTools.js';

/** 読む `config.toml` の大きさの上限（Para Code の MCP の設定と同じ）。 */
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;

export interface IParadisBotPatrolLaunchEnvironment {
	/** 設定ファイルを書くフォルダ（Bot のデータのフォルダの中。専用フォルダの外）。 */
	readonly folder: string;
	/** para-browser の MCP の口のポート。動いていなければ undefined。 */
	readonly gatewayPort: () => Promise<number | undefined>;
	/** 見回りの Codex が使いうる全部のホームの `config.toml` のパス。 */
	readonly codexConfigFiles: () => readonly string[];
}

/** ファイルの名前に使う Bot の id（id は Para Code が作る uuid だが、念のため名前に使える文字だけにする）。 */
function fileStem(botId: string): string {
	return botId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'bot';
}

async function writePrivate(path: string, content: string): Promise<void> {
	await fs.writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
	// 既にあったファイルは mode が効かないので、改めて絞る
	await fs.chmod(path, 0o600);
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

/** 見回りの起動に要るものを用意する。用意できなければ断る理由（英文。エージェントと定期実行の記録に出る）。 */
export async function paradisPrepareBotPatrolLaunch(environment: IParadisBotPatrolLaunchEnvironment, agent: 'claude' | 'codex', botId: string): Promise<ParadisBotPatrolLaunchContext | string> {
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
		const disabledServers = paradisBotPatrolCodexDisabledServers(texts);
		return disabledServers !== undefined
			? { agent, disabledServers }
			: 'Para Code could not list the MCP servers in a Codex config.toml for certain, so it does not start a look-around (it could not turn the others off).';
	}
	const port = await environment.gatewayPort();
	if (port === undefined) {
		return 'The Para Code browser tools are not running, so a look-around cannot start.';
	}
	const stem = fileStem(botId);
	const settingsFile = join(environment.folder, `${stem}.claude-settings.json`);
	const mcpConfigFile = join(environment.folder, `${stem}.claude-mcp.json`);
	try {
		await fs.mkdir(environment.folder, { recursive: true, mode: 0o700 });
		await writePrivate(settingsFile, JSON.stringify(PARADIS_BOT_PATROL_CLAUDE_SETTINGS, undefined, '\t') + '\n');
		await writePrivate(mcpConfigFile, JSON.stringify({ mcpServers: { 'para-browser': paradisClaudeMcpServerEntry(port) } }, undefined, '\t') + '\n');
	} catch {
		return 'Para Code could not write the read-only settings for a look-around.';
	}
	return { agent, settingsFile, mcpConfigFile };
}
