/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLIの設定ホームディレクトリ解決 (shared process側)。
// Codex は $CODEX_HOME (既定 ~/.codex)、Claude Code は $CLAUDE_CONFIG_DIR (既定 ~/.claude) に
// 設定・hook・transcript (rollout) を保存する (両CLIの公式仕様)。hook設置・セッション探索・
// transcript許可rootの全経路がこの2関数を通ることで、home override環境でも検知が一貫する。
// 注意: shared process の process.env はGUI起動時に必ずしもログインシェルのexportを含まない
// (シェルrcでのみ設定している場合は拾えない)。その場合は既定パスへフォールバックするため、
// 従来 (ハードコード) と同じ挙動になる。

import { homedir } from 'os';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { IParadisWslAgentHome, paradisResolveWslAgentHome, paradisWslUncPathFrom } from '../../../common/paradisWslAgentHome.js';

function resolveAgentHome(envVarName: string, fallbackDirName: string): string {
	const value = process.env[envVarName]?.trim();
	if (value !== undefined && value.length > 0 && isAbsolute(value)) {
		return value;
	}
	return join(homedir(), fallbackDirName);
}

/** Codex CLI の状態ディレクトリ ($CODEX_HOME、既定 ~/.codex)。hooks.json / sessions/ / config.toml の親。 */
export function paradisCodexHome(): string {
	return resolveAgentHome('CODEX_HOME', '.codex');
}

/** Claude Code の設定ディレクトリ ($CLAUDE_CONFIG_DIR、既定 ~/.claude)。settings.json / projects/ の親。 */
export function paradisClaudeConfigDir(): string {
	return resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude');
}

/**
 * 1つのターミナルに対応するエージェントCLIの居場所一式。
 *
 * ペインの作業ディレクトリが WSL の中を指しているなら、そこで動く claude / codex が読み書き
 * するのはディストロ側のホームであって、この Windows プロセスのホームではない。探索先と、
 * 突き合わせに使う作業ディレクトリの表記を、ペインごとに揃えて持ち回るための型。
 */
export interface IParadisAgentHomes {
	/** `projects/<スラッグ>` と settings.json の親。 */
	readonly claude: string;
	/** `sessions/` と `state_*.sqlite` の親。 */
	readonly codex: string;
	/**
	 * transcript との突き合わせに使う作業ディレクトリ。エージェントCLIが自分で記録した値と
	 * 比較するので、**そのCLIから見た表記**でなければならない（WSL ならディストロ内の絶対パス）。
	 */
	readonly matchCwd: string;
	/** WSL のディストロの中を指しているときだけ入る。パスの読み替えに使う。 */
	readonly wsl?: IParadisWslAgentHome;
}

/**
 * エージェントCLIが記録したパスを、この Windows プロセスから開ける形へ直す。
 *
 * WSL の中で動く codex が state DB や rollout に書くのは `/home/u/.codex/...` という Linux 側の
 * 表記で、そのまま開こうとしても存在しない。読む前に必ずここを通すこと。ローカルのときは
 * 何もしない。
 */
export function paradisLocalAgentPath(homes: IParadisAgentHomes, recordedPath: string): string {
	return homes.wsl !== undefined && recordedPath.startsWith('/') ? paradisWslUncPathFrom(homes.wsl, recordedPath) : recordedPath;
}

/**
 * 作業ディレクトリから、そのターミナルで動くエージェントCLIのホームを解決する。
 *
 * WSL の中を指していないとき（通常のローカルリポジトリ）は、従来どおりこのプロセスのホームを
 * 返すので挙動は変わらない。
 */
export function paradisResolveAgentHomes(cwd: string): IParadisAgentHomes {
	const wsl = paradisResolveWslAgentHome(cwd);
	if (wsl === undefined) {
		return { claude: paradisClaudeConfigDir(), codex: paradisCodexHome(), matchCwd: cwd };
	}
	// ディストロ側のホームには、この Windows プロセスの $CLAUDE_CONFIG_DIR / $CODEX_HOME は効かない
	// （あれは Windows 側のプロセスにだけ効く設定なので、WSL の中の CLI は見ていない）。
	// UNC は定義上 Windows のパスなので、区切りは明示して組み立てる。`join` は動作中のホスト OS で
	// 区切りを選ぶため、ここで使うと Windows 以外での結果が変わり、テストで固定できなくなる。
	return {
		claude: `${wsl.homeUncPath}\\.claude`,
		codex: `${wsl.homeUncPath}\\.codex`,
		matchCwd: wsl.linuxCwd,
		wsl,
	};
}
