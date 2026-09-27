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
import { Emitter, Event } from '../../../../base/common/event.js';
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

/**
 * Para Code がアカウントごとに作るホームの名前。使用量パネルの「アカウントを追加」が `~/.codex-2` から
 * 順に作る。`~/.codex-backup` のように手で作ったものは含めない（hook や設定を書きに行かないため）。
 * それ以外の場所は設定 `paradis.limitsMonitor.codexHomes` で足す。
 */
const PARA_CODE_CODEX_HOME_PATTERN = /^\.codex-\d+$/;
/** 走査結果を使い回す時間。hook のたびにホームディレクトリを読まないため。 */
const CODEX_HOMES_CACHE_MS = 5_000;

/**
 * アカウント用ホームを扱うか。Codex のアカウント切替はこの PC の shared process だけの機能なので、
 * そこで codexAccounts が有効にする。SSH の接続先（REH）では有効にせず、従来どおり既定のホームだけを見る。
 */
let codexAccountHomesEnabled = false;
/** 設定で足したホーム（正規化済み）。 */
let configuredCodexHomes: readonly string[] = [];
let codexHomesCache: { readonly at: number; readonly key: string; readonly candidates: readonly string[]; readonly signedIn: readonly string[] } | undefined;
/** 前回の走査で見つけたログイン済みのホーム。Para Code の外でログイン・ログアウトしたことに気付くため。 */
let lastSignedInKey: string | undefined;

export interface IParadisCodexHomesOptions {
	/** テスト用。指定したときはキャッシュも有効化の状態も使わず、`<homeDirectory>/.codex` を既定とする。 */
	readonly homeDirectory?: string;
	/** テスト用。`homeDirectory` と一緒に、設定で足したホームを渡す。 */
	readonly configured?: readonly string[];
}

const onDidChangeCodexHomesEmitter = new Emitter<void>();
/** ホームが増えた・消えた・ログインした（{@link paradisNotifyCodexHomesChanged} が呼ばれた）。 */
export const onDidChangeParadisCodexHomes: Event<void> = onDidChangeCodexHomesEmitter.event;

/**
 * Codex のホームを作った・消した・ログインが終わったときに呼ぶ（使用量パネルのアカウント追加・削除）。
 * 一覧のキャッシュを捨て、codexAccounts に選択を見直させる。
 */
export function paradisNotifyCodexHomesChanged(): void {
	codexHomesCache = undefined;
	// この通知で聞き手が読み直すので、次の走査で同じ変化をもう一度知らせない
	lastSignedInKey = undefined;
	onDidChangeCodexHomesEmitter.fire();
}

/** shared process の codexAccounts が起動時に呼ぶ。 */
export function paradisEnableCodexAccountHomes(): void {
	codexAccountHomesEnabled = true;
	codexHomesCache = undefined;
}

/**
 * 設定で足した Codex ホームのパスをそろえる（`~` の展開、`..` や末尾の区切りの除去）。使用量パネルと
 * 切替で同じホームを同じ文字列で扱うため、両方ともこれを通す。絶対パスにならないものは捨てる。
 */
export function paradisNormalizeCodexHomePath(raw: unknown, homeDirectory: string = homedir()): string | undefined {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		return undefined;
	}
	const trimmed = raw.trim();
	const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? join(homeDirectory, trimmed.slice(1)) : trimmed;
	return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/** 設定で足したホームを差し替える（codexAccounts が設定の変更ごとに呼ぶ）。 */
export function paradisSetConfiguredCodexHomes(raw: readonly unknown[]): void {
	configuredCodexHomes = [...new Set(raw.map(entry => paradisNormalizeCodexHomePath(entry)).filter((entry): entry is string => entry !== undefined))];
	codexHomesCache = undefined;
}

function isSignedIn(codexHome: string): boolean {
	try {
		return fs.statSync(join(codexHome, 'auth.json')).isFile();
	} catch {
		return false;
	}
}

function scanCodexHomes(options: IParadisCodexHomesOptions): { readonly primary: string; readonly candidates: readonly string[]; readonly signedIn: readonly string[] } {
	const testing = options.homeDirectory !== undefined;
	const home = options.homeDirectory ?? homedir();
	// 既定のホームは $CODEX_HOME で変わるので毎回解決する。キャッシュするのは走査結果だけ。
	const primary = testing ? join(home, '.codex') : paradisCodexHome();
	if (!testing && !codexAccountHomesEnabled) {
		return { primary, candidates: [primary], signedIn: [primary] };
	}
	const configured = testing ? (options.configured ?? []) : configuredCodexHomes;
	const key = JSON.stringify([home, primary, configured]);
	const now = Date.now();
	if (!testing && codexHomesCache && codexHomesCache.key === key && now - codexHomesCache.at < CODEX_HOMES_CACHE_MS) {
		return { primary, candidates: codexHomesCache.candidates, signedIn: codexHomesCache.signedIn };
	}
	const found: string[] = [];
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(home, { withFileTypes: true });
	} catch {
		// 読めなければ既定のホームと設定分だけ
	}
	for (const entry of entries) {
		if (!PARA_CODE_CODEX_HOME_PATTERN.test(entry.name)) {
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
	found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	const candidates = [...new Set<string>([primary, ...found, ...configured])];
	const signedIn = [primary, ...candidates.slice(1).filter(isSignedIn)];
	if (!testing) {
		codexHomesCache = { at: now, key, candidates, signedIn };
		// Para Code の外で `CODEX_HOME=~/.codex-3 codex login` した・ログアウトしたときは、使用量パネルからの
		// 通知が来ない。走査（hook の定期監査・選択の見直しが定期的に呼ぶ）で一覧が変わっていたら知らせる。
		// 呼び出しの途中で聞き手がまたこの関数を呼ぶので、知らせるのは後にする。
		const signedInKey = JSON.stringify(signedIn);
		if (lastSignedInKey !== undefined && lastSignedInKey !== signedInKey) {
			setTimeout(() => onDidChangeCodexHomesEmitter.fire(), 0);
		}
		lastSignedInKey = signedInKey;
	}
	return { primary, candidates, signedIn };
}

/**
 * Para Code が Codex のホームとして扱うディレクトリ。先頭は既定のホーム（{@link paradisCodexHome}）で、
 * 続くのはログイン済み（auth.json がある）のアカウント用ホーム。
 *
 * Codex のアカウントを切り替えると、新しく開いたターミナルの Codex は `CODEX_HOME=~/.codex-2` の
 * ように別のホームへ transcript・state DB・hooks.json を置く。transcript を読んでよい範囲、hook と
 * 設定の書き込み先、会話の探索は、既定のホーム1つではなくこの一覧を見ること。一覧を決めるのは
 * ここだけにする（codexAccounts もこれを使う）。
 */
export function paradisCodexHomes(options: IParadisCodexHomesOptions = {}): readonly string[] {
	return scanCodexHomes(options).signedIn;
}

/**
 * ログインしていないものも含めた候補。取り外し（hook をオフにしたとき）にだけ使う。ログアウトした
 * ホームにも前に置いた hook が残っているので、外すときは広く見る（外すだけなので安全）。
 */
export function paradisCodexHomeCandidates(options: IParadisCodexHomesOptions = {}): readonly string[] {
	return scanCodexHomes(options).candidates;
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
