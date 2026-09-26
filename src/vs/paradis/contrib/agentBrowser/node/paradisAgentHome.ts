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

import * as fs from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve, sep } from '../../../../base/common/path.js';
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

/** `~/.codex` と、Para Code がアカウントごとに作る `~/.codex-2` 等。`.codexbar` のような別物は含めない。 */
const CODEX_HOME_DIR_PATTERN = /^\.codex(?:-[\w.]+)?$/;
/** ホームの走査結果を使い回す時間。hook のたびにホームディレクトリを読まないため。 */
const CODEX_HOMES_CACHE_MS = 5_000;

let codexHomesCache: { readonly at: number; readonly home: string; readonly found: readonly string[] } | undefined;
/** 既定の走査に掛からない場所（設定で足したホーム）を、選ばれたときに覚えておく。 */
const registeredCodexHomes = new Set<string>();

/**
 * Para Code が Codex のホームとして扱う全ディレクトリ。先頭は既定のホーム（{@link paradisCodexHome}）。
 *
 * Codex のアカウントを切り替えると、新しく開いたターミナルの Codex は `CODEX_HOME=~/.codex-2` の
 * ように別のホームへ transcript・state DB・hooks.json を置く。transcript の許可 root、hook の設置先、
 * 会話の探索は「既定のホーム1つ」ではなくこの一覧を見ること。
 *
 * @param homeDirectory テスト用。指定したときはキャッシュを使わず、`<homeDirectory>/.codex` を既定とする。
 */
export function paradisCodexHomes(homeDirectory?: string): readonly string[] {
	const home = homeDirectory ?? homedir();
	// 既定のホームは $CODEX_HOME で変わるので毎回解決する。キャッシュするのは走査結果だけ。
	const primary = homeDirectory === undefined ? paradisCodexHome() : join(home, '.codex');
	const now = Date.now();
	let found: readonly string[];
	if (homeDirectory === undefined && codexHomesCache && codexHomesCache.home === home && now - codexHomesCache.at < CODEX_HOMES_CACHE_MS) {
		found = codexHomesCache.found;
	} else {
		found = scanCodexHomes(home);
		if (homeDirectory === undefined) {
			codexHomesCache = { at: now, home, found };
		}
	}
	return [...new Set<string>([primary, ...found, ...registeredCodexHomes])];
}

function scanCodexHomes(home: string): string[] {
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(home, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const entry of entries) {
		if (!CODEX_HOME_DIR_PATTERN.test(entry.name)) {
			continue;
		}
		const candidate = join(home, entry.name);
		try {
			if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(candidate).isDirectory())) {
				found.push(candidate);
			}
		} catch {
			// 壊れたリンクは飛ばす
		}
	}
	return found.sort();
}

/**
 * 既定の走査（`~/.codex*`）に掛からない Codex ホームを一覧へ加える。設定で足したホームが
 * 切替で選ばれたとき、その transcript を許可 root に入れるために使う。
 */
export function paradisRegisterCodexHome(homePath: string): void {
	if (isAbsolute(homePath) && !registeredCodexHomes.has(homePath)) {
		registeredCodexHomes.add(homePath);
		codexHomesCache = undefined;
	}
}

/**
 * 設定を書き込む先の Codex ホーム（hook・MCP・TUI の設定）。既定のホームと、ログイン済み
 * （auth.json がある）ホームだけ。ログインに失敗して log/ しか無いホームへは書かない。
 */
export function paradisCodexAccountHomes(homeDirectory?: string): readonly string[] {
	const [primary, ...others] = paradisCodexHomes(homeDirectory);
	return [primary, ...others.filter(candidate => {
		try {
			return fs.statSync(join(candidate, 'auth.json')).isFile();
		} catch {
			return false;
		}
	})];
}

/** パスがどれかの Codex ホームの中（またはホームそのもの）か。字面だけで判定する。 */
export function paradisIsWithinCodexHome(candidate: string, homes: readonly string[] = paradisCodexHomes()): boolean {
	const resolved = resolve(candidate);
	return homes.some(home => resolved === home || resolved.startsWith(home + sep));
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
	 * 探索対象の Codex ホームすべて（先頭は {@link codex}）。アカウントを切り替えると、ペインごとに
	 * 別のホームで Codex が動く。undefined のときは {@link codex} だけ（WSL など）。
	 * 1つずつ見るときは {@link paradisEachCodexHome} を使う。
	 */
	readonly codexHomes?: readonly string[];
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
		return { claude: paradisClaudeConfigDir(), codex: paradisCodexHome(), codexHomes: paradisCodexHomes(), matchCwd: cwd };
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

/**
 * {@link IParadisAgentHomes} を Codex ホーム1つずつに展開する（先頭は元の `codex`）。
 * state DB・sessions/ を読む処理は、これで全ホームを順に見る。
 */
export function paradisEachCodexHome(homes: IParadisAgentHomes): readonly IParadisAgentHomes[] {
	const others = (homes.codexHomes ?? []).filter(candidate => candidate !== homes.codex);
	return [homes, ...others.map(codex => ({ ...homes, codex, codexHomes: undefined }))];
}
