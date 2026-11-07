/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code が作ったワークツリーで、Claude Code のフォルダの信頼の確認（「Is this a project you created or one you
// trust?」）を前もって済ませる（Orca #23744 の src/main/claude/claude-folder-trust-file.ts と同じ方式）。
//
// Claude Code は動いている間ずっと ~/.claude.json を書き換える。壊さないために次を守る:
//  - Claude と同じロック（`<設定ファイル>.lock` のフォルダーを mkdir で作る。proper-lockfile の形）を取ってから書く。
//    既にあるロックは古く見えても消さない・奪わない。数回待っても取れなければ書かない（今の「確認待ち」の検出に任せる）
//  - ロックを持っている間は await を挟まない（読み直し・変更・書き込み・名前の付け替えを同期の API で済ませる）
//  - 置き換えのファイルはロックの前に、元と同じフォルダーへ同じ権限で用意する。シンボリックリンクは実体を置き換える
//  - 設定ファイルが無い・壊れている・`projects` がオブジェクトでない・既に信頼済みなら、何も書かない
//
// 書いた鍵は、ワークツリーの git の管理フォルダー（`.git/worktrees/<名前>/`）に控える。削除のときにそれを読み、
// 自分が書いた `hasTrustDialogAccepted` だけを取り消す（項目には Claude の履歴や許可の記録も入るので、丸ごとは消さない）。
//
// この処理は、ワークツリーを作る git と同じプロセスで動く（手元なら shared process、SSH の窓なら接続先の REH）。
// Claude Code もそのホームで動くので、書く先はそのホームの設定ファイルで合っている。

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, normalize, posix, resolve, win32 } from '../../../../base/common/path.js';

/** 信頼の書き込みの結果。 */
export type ParadisClaudeTrustOutcome = 'granted' | 'unchanged' | 'missing-config' | 'locked' | 'unreadable' | 'skipped';

/** ワークツリーの管理フォルダーに置く控えのファイル名。 */
export const PARADIS_CLAUDE_TRUST_MARKER_FILE = 'paradis-claude-trust.json';

/** ロックを取り直す間隔（ミリ秒）。全部で 1 秒に満たない（Orca: retries 4, 50〜250ms）。 */
const LOCK_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 250];

/** 控えの中身。 */
export interface IParadisClaudeTrustMarker {
	readonly configFile: string;
	readonly keys: readonly string[];
}

/** 設定ファイルの選び方に使う環境変数。 */
export interface IParadisClaudeConfigEnv {
	readonly CLAUDE_CONFIG_DIR?: string;
	readonly CLAUDE_CODE_CUSTOM_OAUTH_URL?: string;
}

type PathStyle = 'posix' | 'win32';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Claude Code が読む全体の設定ファイル。古い `<CLAUDE_CONFIG_DIR か ~/.claude>/.config.json` があればそれ、無ければ
 * `<CLAUDE_CONFIG_DIR か ~>/.claude.json`（`CLAUDE_CODE_CUSTOM_OAUTH_URL` があれば `.claude-custom-oauth.json`）。
 * `CLAUDE_CONFIG_DIR` が相対パス（`~` を含む）なら、起動した場所しだいで指す先が変わるので決めない（undefined）。
 */
export function paradisResolveClaudeGlobalConfigFile(env: IParadisClaudeConfigEnv, homeDir: string, exists: (path: string) => boolean, style: PathStyle = process.platform === 'win32' ? 'win32' : 'posix'): string | undefined {
	const api = style === 'win32' ? win32 : posix;
	const configDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
	if (configDir !== undefined && !api.isAbsolute(configDir)) {
		return undefined;
	}
	const legacyFile = api.join((configDir ?? api.join(homeDir, '.claude')).normalize('NFC'), '.config.json');
	if (exists(legacyFile)) {
		return legacyFile;
	}
	const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
	return api.join(configDir ?? homeDir, `.claude${suffix}.json`);
}

/** Claude Code が `projects` の鍵に使う形（NFC の `path.normalize`。Windows は区切りを `/` に）。 */
export function paradisClaudeTrustKey(folderPath: string, style: PathStyle = process.platform === 'win32' ? 'win32' : 'posix'): string {
	const normalized = (style === 'win32' ? win32 : posix).normalize(folderPath.normalize('NFC'));
	return style === 'win32' ? normalized.replace(/\\/g, '/') : normalized;
}

/** ワークツリーの鍵。そのままの形と実体の形（シンボリックリンクを解いたもの）の両方。 */
export async function paradisClaudeTrustKeysFor(worktreePath: string): Promise<string[]> {
	const forms = [resolve(worktreePath)];
	try {
		forms.push(await fs.promises.realpath(worktreePath));
	} catch {
		// 解けなくても、そのままの形の鍵だけで足りる
	}
	return [...new Set(forms.map(form => paradisClaudeTrustKey(form)))];
}

/**
 * 信頼を前もって書いてはいけない場所か。Claude Code の信頼は配下のフォルダーにも効くので、ホーム・ルート・
 * ホームを含むフォルダーには書かない。
 */
export function paradisIsTooBroadToTrust(keys: readonly string[], homeDir: string): boolean {
	const home = paradisClaudeTrustKey(resolve(homeDir));
	return keys.some(key => {
		const withSlash = key.endsWith('/') ? key : `${key}/`;
		return key === home || home.startsWith(withSlash) || dirname(key) === key;
	});
}

/** 設定の変更の計画。 */
export type ParadisClaudeConfigChange =
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'refuse' }
	| { readonly kind: 'changed'; readonly config: Record<string, unknown>; readonly keys: readonly string[] };

/** どれかの鍵が既に信頼済みなら何もしない。そうでなければ全部の鍵に `hasTrustDialogAccepted: true` を書く。 */
export function paradisApplyClaudeFolderTrust(config: Record<string, unknown>, keys: readonly string[]): ParadisClaudeConfigChange {
	if (config.projects !== undefined && !isPlainObject(config.projects)) {
		return { kind: 'refuse' };
	}
	const projects: Record<string, unknown> = { ...config.projects };
	if (keys.some(key => isPlainObject(projects[key]) && (projects[key] as Record<string, unknown>).hasTrustDialogAccepted === true)) {
		return { kind: 'unchanged' };
	}
	for (const key of keys) {
		const entry = projects[key];
		projects[key] = isPlainObject(entry) ? { ...entry, hasTrustDialogAccepted: true } : { hasTrustDialogAccepted: true };
	}
	return { kind: 'changed', config: { ...config, projects }, keys };
}

/** 書いた `hasTrustDialogAccepted: true` だけを外す。項目が空になったら項目ごと消す。 */
export function paradisRevokeClaudeFolderTrust(config: Record<string, unknown>, keys: readonly string[]): ParadisClaudeConfigChange {
	if (!isPlainObject(config.projects)) {
		return config.projects === undefined ? { kind: 'unchanged' } : { kind: 'refuse' };
	}
	const projects: Record<string, unknown> = { ...config.projects };
	const revoked: string[] = [];
	for (const key of keys) {
		const entry = projects[key];
		if (!isPlainObject(entry) || entry.hasTrustDialogAccepted !== true) {
			continue;
		}
		const { hasTrustDialogAccepted: _removed, ...rest } = entry;
		if (Object.keys(rest).length === 0) {
			delete projects[key];
		} else {
			projects[key] = rest;
		}
		revoked.push(key);
	}
	return revoked.length === 0 ? { kind: 'unchanged' } : { kind: 'changed', config: { ...config, projects }, keys: revoked };
}

type ReadResult = { readonly path: string; readonly config: Record<string, unknown> } | 'missing-config' | 'unreadable';

function readFailure(error: unknown): 'missing-config' | 'unreadable' {
	const code = (error as NodeJS.ErrnoException).code;
	return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing-config' : 'unreadable';
}

function parseConfig(path: string, text: string): ReadResult {
	try {
		const parsed: unknown = JSON.parse(text);
		return isPlainObject(parsed) ? { path, config: parsed } : 'unreadable';
	} catch {
		return 'unreadable';
	}
}

/** ロックの前の下見。シンボリックリンクなら実体を置き換えるので、実体のパスを読む。 */
async function readConfig(configFile: string): Promise<ReadResult> {
	let path: string;
	try {
		const entry = await fs.promises.lstat(configFile);
		path = entry.isSymbolicLink() ? await fs.promises.realpath(configFile) : configFile;
		if (!(await fs.promises.stat(path)).isFile()) {
			return 'unreadable';
		}
	} catch (error) {
		return readFailure(error);
	}
	try {
		return parseConfig(path, await fs.promises.readFile(path, 'utf8'));
	} catch {
		return 'unreadable';
	}
}

/*
 * ロックを持っている間の読み直しと置き換え。ここだけ同期の API を使う: Claude Code も同じロックで ~/.claude.json を
 * 書き換えていて、こちらがロックを持つ間は待たされる（待ちきれないと Claude 側の書き込みが失敗する）。await を挟むと、
 * 混んだ shared process / REH ではほかの処理の分だけロックの時間が延びるので、ロックの中は同期で一息に済ませる。
 */
/* eslint-disable local/code-no-sync-fs */
function readConfigSync(configFile: string): ReadResult {
	let path: string;
	try {
		const entry = fs.lstatSync(configFile);
		path = entry.isSymbolicLink() ? fs.realpathSync(configFile) : configFile;
		if (!fs.statSync(path).isFile()) {
			return 'unreadable';
		}
	} catch (error) {
		return readFailure(error);
	}
	try {
		return parseConfig(path, fs.readFileSync(path, 'utf8'));
	} catch {
		return 'unreadable';
	}
}

function writeReplacementSync(replacement: string, target: string, config: Record<string, unknown>): void {
	fs.writeFileSync(replacement, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'r+' });
	fs.renameSync(replacement, target);
}

function releaseLockSync(lockPath: string): void {
	try {
		fs.rmdirSync(lockPath);
	} catch {
		// 外せなくても、Claude は古いロックとして扱える
	}
}
/* eslint-enable local/code-no-sync-fs */

/** 設定ファイルごとに、こちらの書き込みを 1 本ずつにする（同時に作った 2 本のワークツリーが自分のロックに負けないように）。 */
const queueByConfigFile = new Map<string, Promise<unknown>>();

function serialized<T>(configFile: string, run: () => Promise<T>): Promise<T> {
	const previous = queueByConfigFile.get(configFile) ?? Promise.resolve();
	const next = previous.then(run, run);
	const tail = next.then(() => undefined, () => undefined);
	queueByConfigFile.set(configFile, tail);
	void tail.then(() => {
		if (queueByConfigFile.get(configFile) === tail) {
			queueByConfigFile.delete(configFile);
		}
	});
	return next;
}

/** テストから差し替える待ち。 */
export interface IParadisClaudeTrustTiming {
	readonly retryDelaysMs: readonly number[];
	readonly sleep: (ms: number) => Promise<void>;
}

const DEFAULT_TIMING: IParadisClaudeTrustTiming = {
	retryDelaysMs: LOCK_RETRY_DELAYS_MS,
	sleep: ms => new Promise<void>(resolveSleep => setTimeout(resolveSleep, ms)),
};

/**
 * 設定ファイルを、Claude のロックを取って書き換える。`change` は純関数にする（ロックの前の下見と、ロックの中の
 * 読み直しの 2 回呼ぶ）。返すのは書き換えた鍵（書かなければ undefined）と結果。
 */
export function paradisUpdateClaudeConfig(configFile: string, change: (config: Record<string, unknown>) => ParadisClaudeConfigChange, timing: IParadisClaudeTrustTiming = DEFAULT_TIMING): Promise<{ readonly outcome: ParadisClaudeTrustOutcome; readonly keys?: readonly string[] }> {
	return serialized(configFile, () => updateNow(configFile, change, timing));
}

async function updateNow(configFile: string, change: (config: Record<string, unknown>) => ParadisClaudeConfigChange, timing: IParadisClaudeTrustTiming): Promise<{ readonly outcome: ParadisClaudeTrustOutcome; readonly keys?: readonly string[] }> {
	const probe = await readConfig(configFile);
	if (typeof probe === 'string') {
		return { outcome: probe };
	}
	const planned = change(probe.config);
	if (planned.kind !== 'changed') {
		return { outcome: planned.kind === 'refuse' ? 'unreadable' : 'unchanged' };
	}
	// 置き換えのファイルは、元と同じフォルダーに同じ権限で先に作る（ロックの中で待たないため）
	const replacement = `${probe.path}.paradis-trust-${randomUUID()}.tmp`;
	try {
		const mode = (await fs.promises.stat(probe.path)).mode & 0o777;
		await fs.promises.writeFile(replacement, '', { flag: 'wx', mode });
		if (process.platform !== 'win32') {
			await fs.promises.chmod(replacement, mode); // umask で狭まった分を戻す
		}
	} catch {
		await fs.promises.rm(replacement, { force: true });
		return { outcome: 'unreadable' };
	}
	try {
		// Claude はシンボリックリンクでも、リンクそのもののパスに `.lock` を付けてロックする（proper-lockfile の mkdir）。
		// 既にあるロックは古く見えても消さない
		const lockPath = `${configFile}.lock`;
		let locked = false;
		for (let attempt = 0; ; attempt++) {
			try {
				await fs.promises.mkdir(lockPath);
				locked = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= timing.retryDelaysMs.length) {
					break;
				}
			}
			await timing.sleep(timing.retryDelaysMs[attempt]);
		}
		if (!locked) {
			return { outcome: 'locked' };
		}
		// ここから先はロックを外すまで await しない
		try {
			const current = readConfigSync(configFile);
			if (typeof current === 'string') {
				return { outcome: current };
			}
			if (current.path !== probe.path) {
				return { outcome: 'unreadable' }; // リンクの向き先が変わった（用意した権限が合わない）
			}
			const next = change(current.config);
			if (next.kind !== 'changed') {
				return { outcome: next.kind === 'refuse' ? 'unreadable' : 'unchanged' };
			}
			writeReplacementSync(replacement, current.path, next.config);
			return { outcome: 'granted', keys: next.keys };
		} finally {
			releaseLockSync(lockPath);
		}
	} finally {
		await fs.promises.rm(replacement, { force: true });
	}
}

/** ワークツリーの git の管理フォルダー（`<worktree>/.git` の `gitdir:` の先）。読めなければ undefined。 */
export async function paradisWorktreeAdminDir(worktreePath: string): Promise<string | undefined> {
	try {
		const text = await fs.promises.readFile(join(worktreePath, '.git'), 'utf8');
		const match = /^gitdir:\s*(?<dir>.+?)\s*$/m.exec(text);
		const dir = match?.groups?.dir;
		if (dir === undefined) {
			return undefined;
		}
		return isAbsolute(dir) ? normalize(dir) : resolve(worktreePath, dir);
	} catch {
		return undefined;
	}
}

/**
 * 作ったワークツリーを Claude Code に信頼済みとして書き、書いた鍵を管理フォルダーに控える。失敗しても投げない
 * （作成は止めない。信頼の確認の画面は今までどおり検出される）。
 */
export async function paradisGrantClaudeWorktreeTrust(worktreePath: string, env: IParadisClaudeConfigEnv, homeDir: string = homedir(), timing?: IParadisClaudeTrustTiming): Promise<ParadisClaudeTrustOutcome> {
	const configDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(homeDir, '.claude');
	const legacyExists = await fs.promises.access(join(configDir.normalize('NFC'), '.config.json')).then(() => true, () => false);
	const configFile = paradisResolveClaudeGlobalConfigFile(env, homeDir, () => legacyExists);
	const keys = await paradisClaudeTrustKeysFor(worktreePath);
	const adminDir = await paradisWorktreeAdminDir(worktreePath);
	if (configFile === undefined || adminDir === undefined || keys.length === 0 || paradisIsTooBroadToTrust(keys, homeDir)) {
		return 'skipped';
	}
	const result = await paradisUpdateClaudeConfig(configFile, config => paradisApplyClaudeFolderTrust(config, keys), timing);
	if (result.outcome === 'granted' && result.keys !== undefined) {
		const marker: IParadisClaudeTrustMarker = { configFile, keys: result.keys };
		try {
			await fs.promises.writeFile(join(adminDir, PARADIS_CLAUDE_TRUST_MARKER_FILE), JSON.stringify(marker), { mode: 0o600 });
		} catch {
			// 控えが書けなければ、削除のときに取り消せないだけ（信頼は書けている）
		}
	}
	return result.outcome;
}

/** 削除の前に、控えを読む（削除で管理フォルダーごと消えるため）。無ければ undefined。 */
export async function paradisReadClaudeTrustMarker(worktreePath: string): Promise<IParadisClaudeTrustMarker | undefined> {
	const adminDir = await paradisWorktreeAdminDir(worktreePath);
	if (adminDir === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(await fs.promises.readFile(join(adminDir, PARADIS_CLAUDE_TRUST_MARKER_FILE), 'utf8'));
		if (isPlainObject(parsed) && typeof parsed.configFile === 'string' && isAbsolute(parsed.configFile)
			&& Array.isArray(parsed.keys) && parsed.keys.every(key => typeof key === 'string')) {
			return { configFile: parsed.configFile, keys: parsed.keys as string[] };
		}
	} catch {
		// 控えが無い（Para Code が信頼を書いていない）
	}
	return undefined;
}

/** 控えに書いた信頼を取り消す。失敗しても投げない。 */
export async function paradisRevokeClaudeWorktreeTrust(marker: IParadisClaudeTrustMarker, timing?: IParadisClaudeTrustTiming): Promise<ParadisClaudeTrustOutcome> {
	if (marker.keys.length === 0) {
		return 'skipped';
	}
	return (await paradisUpdateClaudeConfig(marker.configFile, config => paradisRevokeClaudeFolderTrust(config, marker.keys), timing)).outcome;
}
