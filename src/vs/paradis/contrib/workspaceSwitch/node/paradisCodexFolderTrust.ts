/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code が作ったワークツリーで、Codex のフォルダの信頼の確認（「Do you trust the contents of this directory?」）を
// 前もって済ませる（Orca #23744・#33377 の markCodexProjectTrusted と同じく、起動に使う CODEX_HOME の config.toml すべてに
// `[projects."<path>"]` の `trust_level = "trusted"` を書く）。Claude Code 側は paradisClaudeFolderTrust.ts。
//
// config.toml は Codex 自身（TUI の信頼の確認・/hooks）や Para Code の hook の信頼（agentHookTrust）も書くので、壊さない
// ために次を守る:
//  - 行ごとに読み（paradisTomlScan の scanTomlLines。コメント・引用・複数行の文字列を見分ける）、末尾に表を 1 つ足すだけ。
//    ほかの行の中身は変えない
//  - そのパスの表や項目が既にある（信頼済み・`untrusted` を含め、どんな書き方でも）なら、何も書かない（利用者の決定を
//    上書きしない）。`projects` が表の配列やインラインの表で定義されている・読みきれない書き方なら、足すと同じ表を二重に
//    定義しかねないので書かない
//  - 書き込みは agentHookTrust と同じく、同じフォルダの一時ファイルから rename で置き換え、置き換える直前に中身が読んだ
//    ときのままかを確かめる（変わっていたら読み直してやり直す。3 回まで）。書く前の中身を 1 つ控える
//
// 足した表は、ワークツリーの git の管理フォルダー（`.git/worktrees/<名前>/`）に控える。削除の後、表がまだ書いたときの
// ままなら表ごと消す（利用者が手を入れた表は残す。Orca も書いたときのバイト列と一致するときだけ消す）。

import { promises as fs } from 'fs';
import { join, resolve } from '../../../../base/common/path.js';
import { encodeParadisTomlBasicString } from '../../agentBrowser/common/paradisMcpSetupEncoding.js';
import { scanTomlLines } from '../../agentBrowser/common/paradisTomlScan.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';
import { paradisWriteRollingBackup } from '../../../node/paradisRollingFileBackup.js';
import { paradisWorktreeAdminDir } from './paradisClaudeFolderTrust.js';

/** ワークツリーの管理フォルダーに置く控えのファイル名。 */
export const PARADIS_CODEX_TRUST_MARKER_FILE = 'paradis-codex-trust.json';

/** 書き込みの結果（設定ファイルごと）。 */
export type ParadisCodexTrustOutcome = 'granted' | 'unchanged' | 'unsupported' | 'failed';

/** 控えの中身（書いた設定ファイルと、そこへ足した表の鍵）。 */
export interface IParadisCodexTrustMarker {
	readonly entries: readonly { readonly configFile: string; readonly projectPath: string }[];
}

/** Codex が `projects` の鍵に使うパス（実体のパス。解けなければ resolve したもの）。 */
export async function paradisCodexTrustProjectPath(worktreePath: string): Promise<string> {
	try {
		return await fs.realpath(worktreePath);
	} catch {
		return resolve(worktreePath);
	}
}

function samePath(a: string, b: string): boolean {
	return process.platform === 'win32' ? a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase() : a === b;
}

function startsWithProject(path: readonly string[] | undefined, projectPath: string): boolean | undefined {
	if (path === undefined) {
		return undefined;
	}
	return path.length >= 2 && path[0] === 'projects' && samePath(path[1], projectPath);
}

/** 足す表の行（見出しと trust_level の 2 行）。 */
function projectTableLines(projectPath: string): string[] {
	return [`[projects.${encodeParadisTomlBasicString(projectPath)}]`, 'trust_level = "trusted"'];
}

/**
 * config.toml にそのパスの信頼の表を足した中身。既にそのパスの表・項目があれば 'unchanged'、安全に足せない書き方なら
 * 'unsupported'。
 */
export function paradisAddCodexProjectTrust(configToml: string, projectPath: string): string | 'unchanged' | 'unsupported' {
	const bom = configToml.charCodeAt(0) === 0xfeff ? configToml[0] : '';
	const text = configToml.slice(bom.length);
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	const infos = scanTomlLines(lines);
	let table: readonly string[] = [];
	for (const info of infos) {
		if (info.header !== undefined) {
			const path = info.header.path;
			if (path === undefined || (info.header.array && path[0] === 'projects')) {
				return 'unsupported'; // 読めない見出し・`[[projects]]`
			}
			if (startsWithProject(path, projectPath)) {
				return 'unchanged';
			}
			table = path;
			continue;
		}
		if (info.key !== undefined) {
			const full = [...table, ...info.key];
			if (full[0] !== 'projects') {
				continue;
			}
			if (full.length >= 2 && samePath(full[1], projectPath)) {
				return 'unchanged'; // `[projects]` の下の `"<path>" = { ... }`・dotted key など、別の書き方で既にある
			}
			if (full.length === 1 || table.length === 0) {
				// `projects = { ... }`（インラインの表）やルートの `projects.<...> = ...` に見出しを足すと、同じ表の二重の定義になりうる
				return 'unsupported';
			}
		}
	}
	if (infos.length > 0 && infos[infos.length - 1].continued) {
		return 'unsupported'; // 複数行の文字列・配列の途中で終わっている
	}
	const block = projectTableLines(projectPath).join(eol);
	if (text.length === 0) {
		return `${bom}${block}${eol}`;
	}
	const separator = text.endsWith(`${eol}${eol}`) ? '' : text.endsWith(eol) ? eol : eol + eol;
	return `${bom}${text}${separator}${block}${eol}`;
}

/**
 * 足した表を消した中身。表がそのパスに 1 つだけあり、中身が書いたときのまま（見出しと trust_level の行、続く空行）なら
 * 消す。それ以外（無い・利用者が手を入れた）は 'unchanged'。
 */
export function paradisRemoveCodexProjectTrust(configToml: string, projectPath: string): string | 'unchanged' {
	const eol = configToml.includes('\r\n') ? '\r\n' : '\n';
	const lines = configToml.split(/\r?\n/);
	const infos = scanTomlLines(lines);
	const headerIndexes = infos.flatMap((info, index) => info.header !== undefined ? [index] : []);
	const ours = headerIndexes.filter(index => startsWithProject(infos[index].header?.path, projectPath) === true);
	if (ours.length !== 1 || infos[ours[0]].header?.path?.length !== 2) {
		return 'unchanged';
	}
	const start = ours[0];
	const next = headerIndexes.find(index => index > start);
	const body = lines.slice(start + 1, next ?? lines.length).filter(line => line.trim().length > 0);
	if (body.length !== 1 || body[0].trim() !== projectTableLines(projectPath)[1]) {
		return 'unchanged';
	}
	// 表と、その前の空行（足すときに入れた区切り）を消す。前後に表が残るなら、間の空行を 1 つ戻す
	let removeStart = start;
	while (removeStart > 0 && lines[removeStart - 1].trim().length === 0) {
		removeStart--;
	}
	const before = lines.slice(0, removeStart);
	const after = next === undefined ? [''] : lines.slice(next);
	const kept = next !== undefined && before.length > 0 ? [...before, '', ...after] : [...before, ...after];
	const joined = kept.join(eol);
	return joined === eol ? '' : joined;
}

async function readOptionalText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

/** 設定ファイルごとに、こちらの書き込みを 1 本ずつにする。 */
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

/**
 * config.toml を書き換える。読んでから置き換えるまでに中身が変わっていたら（Codex の TUI が書いた等）、読み直して
 * やり直す（3 回まで）。`change` は読んだ中身（無ければ undefined）から新しい中身か、書かない理由を返す。
 */
function updateConfig(configFile: string, change: (text: string | undefined) => string | 'unchanged' | 'unsupported'): Promise<ParadisCodexTrustOutcome> {
	return serialized(configFile, async () => {
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				const current = await readOptionalText(configFile);
				const next = change(current);
				if (next === 'unchanged' || next === 'unsupported') {
					return next;
				}
				if (current !== undefined) {
					await paradisWriteRollingBackup(configFile).catch(() => false);
				}
				let changedMeanwhile = false;
				await paradisWriteFileAtomic(configFile, next, {
					// 新しく作るときは Codex が作るのと同じく利用者だけが読める権限にする
					newFileMode: 0o600,
					beforeReplace: async () => {
						if (await readOptionalText(configFile) !== current) {
							changedMeanwhile = true;
							throw new Error('config.toml changed while it was being updated');
						}
					},
				}).catch(error => {
					if (!changedMeanwhile) {
						throw error;
					}
				});
				if (!changedMeanwhile) {
					return 'granted';
				}
			}
			return 'failed';
		} catch {
			return 'failed';
		}
	});
}

/**
 * 作ったワークツリーを、渡した CODEX_HOME すべての config.toml に信頼済みとして書き、足した表を管理フォルダーに控える。
 * 失敗しても投げない（作成は止めない。信頼の確認の画面は今までどおり検出される）。ホームのフォルダーが無ければ書かない。
 */
export async function paradisGrantCodexWorktreeTrust(worktreePath: string, codexHomes: readonly string[]): Promise<readonly ParadisCodexTrustOutcome[]> {
	const adminDir = await paradisWorktreeAdminDir(worktreePath);
	if (adminDir === undefined || codexHomes.length === 0) {
		return [];
	}
	const projectPath = await paradisCodexTrustProjectPath(worktreePath);
	const outcomes: ParadisCodexTrustOutcome[] = [];
	const written: { configFile: string; projectPath: string }[] = [];
	for (const home of codexHomes) {
		const isDirectory = await fs.stat(home).then(stat => stat.isDirectory(), () => false);
		if (!isDirectory) {
			continue;
		}
		const configFile = join(home, 'config.toml');
		const outcome = await updateConfig(configFile, text => paradisAddCodexProjectTrust(text ?? '', projectPath));
		outcomes.push(outcome);
		if (outcome === 'granted') {
			written.push({ configFile, projectPath });
		}
	}
	if (written.length > 0) {
		const marker: IParadisCodexTrustMarker = { entries: written };
		try {
			await fs.writeFile(join(adminDir, PARADIS_CODEX_TRUST_MARKER_FILE), JSON.stringify(marker), { mode: 0o600 });
		} catch {
			// 控えが書けなければ、削除のときに取り消せないだけ（信頼は書けている）
		}
	}
	return outcomes;
}

/** 削除の前に、控えを読む（削除で管理フォルダーごと消えるため）。無ければ undefined。 */
export async function paradisReadCodexTrustMarker(worktreePath: string): Promise<IParadisCodexTrustMarker | undefined> {
	const adminDir = await paradisWorktreeAdminDir(worktreePath);
	if (adminDir === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(join(adminDir, PARADIS_CODEX_TRUST_MARKER_FILE), 'utf8'));
		const entries = typeof parsed === 'object' && parsed !== null ? (parsed as { entries?: unknown }).entries : undefined;
		if (Array.isArray(entries) && entries.every(entry => typeof entry?.configFile === 'string' && typeof entry?.projectPath === 'string')) {
			return { entries: entries.map(entry => ({ configFile: entry.configFile as string, projectPath: entry.projectPath as string })) };
		}
	} catch {
		// 控えが無い（Para Code が信頼を書いていない）
	}
	return undefined;
}

/** 控えに書いた信頼の表を取り消す（書いたときのままの表だけ）。失敗しても投げない。 */
export async function paradisRevokeCodexWorktreeTrust(marker: IParadisCodexTrustMarker): Promise<readonly ParadisCodexTrustOutcome[]> {
	const outcomes: ParadisCodexTrustOutcome[] = [];
	for (const entry of marker.entries) {
		outcomes.push(await updateConfig(entry.configFile, text => text === undefined ? 'unchanged' : paradisRemoveCodexProjectTrust(text, entry.projectPath)));
	}
	return outcomes;
}
