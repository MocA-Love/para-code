/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルのシェルの下で Codex が動いているかを、プロセス表で見分ける（shared process）。
//
// アカウントを切り替えたとき「前のアカウントのまま動いている Codex」を数えるのに使う。画面側の
// シェル統合（実行中のコマンド）とプロセス名だけでは、次の場合に取りこぼす。
// - 再読み込みの後に再接続したペイン（実行中のコマンドが残っていない）
// - npm 版の codex（前面のプロセス名は `node`）
// - `echo …; codex` のように、行の先頭が codex でない
// プロセスの起動行の判定は、hook の所有者の判定と同じ `paradisHookAgentKindFromCommandLine` を使う
// （`node …/bin/codex.js`・vendor の本体・Para Code のランチャーを Codex と判定する）。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { IParadisHookProcessInfo, paradisHookAgentKindFromCommandLine } from '../../agentBrowser/node/paradisAgentHookOwnership.js';
import { paradisCodexHome, paradisNormalizeCodexHomePath } from '../../agentBrowser/node/paradisAgentHome.js';
import type { IParadisCodexPaneProcess } from '../common/paradisCodexAccounts.js';

/** シェルの下をたどる深さの上限（tmux・ラッパーを挟んでも届く程度）。 */
const MAX_DEPTH = 12;
/** 1回に調べるシェルの数の上限。 */
export const PARADIS_CODEX_PANE_SHELLS_MAX = 500;

/**
 * `shellPids` のうち、子孫のどこかで Codex が動いているシェルと、見つけた Codex のプロセス（シェルに
 * いちばん近いもの）を返す（渡した順）。プロセス表が取れなければ空（呼び出し側は画面側の判定だけで数える）。
 */
export function paradisFindCodexUnderShells(shellPids: readonly number[], snapshot: ReadonlyMap<number, IParadisHookProcessInfo> | undefined): { readonly shellPid: number; readonly codexPid: number }[] {
	if (snapshot === undefined) {
		return [];
	}
	const children = new Map<number, number[]>();
	for (const info of snapshot.values()) {
		if (info.ppid === undefined || info.ppid === info.pid) {
			continue;
		}
		let list = children.get(info.ppid);
		if (list === undefined) {
			list = [];
			children.set(info.ppid, list);
		}
		list.push(info.pid);
	}
	const isCodex = (pid: number) => {
		const command = snapshot.get(pid)?.command;
		return command !== undefined && paradisHookAgentKindFromCommandLine(command) === 'codex';
	};
	const result: { shellPid: number; codexPid: number }[] = [];
	for (const shellPid of shellPids) {
		const seen = new Set<number>([shellPid]);
		let frontier = children.get(shellPid) ?? [];
		let found: number | undefined;
		for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0 && found === undefined; depth++) {
			const next: number[] = [];
			for (const pid of frontier) {
				if (seen.has(pid)) {
					continue;
				}
				seen.add(pid);
				if (isCodex(pid)) {
					found = pid;
					break;
				}
				next.push(...(children.get(pid) ?? []));
			}
			frontier = next;
		}
		if (found !== undefined) {
			result.push({ shellPid, codexPid: found });
		}
	}
	return result;
}

// ---------- 動いている Codex の CODEX_HOME ----------
//
// 再接続したペインは、開いたときのホームを覚えていない。動いている Codex のプロセスの環境変数から
// `CODEX_HOME` だけを読み、実際のホームとして数える。環境変数には秘密が入りうるので、読んだ内容は
// `CODEX_HOME` の値だけを取り出してすぐ捨て、ログにも出さない。読むのは自分（同じユーザー）のプロセスだけ。

/** プロセスの `CODEX_HOME`。`known: false` は読めなかった（別のユーザー・非対応の OS・消えた）。 */
export interface IParadisCodexProcessHome {
	readonly known: boolean;
	/** 設定されていなければ undefined（既定のホーム）。 */
	readonly codexHome?: string;
}

export type ParadisCodexProcessHomeReader = (pid: number) => Promise<IParadisCodexProcessHome>;

const UNKNOWN_HOME: IParadisCodexProcessHome = { known: false };
const PS_TIMEOUT_MS = 3_000;

/**
 * macOS の `ps -E -ww -o uid=,command=` の出力（コマンドの後ろに `NAME=value` が空白区切りで続く）から
 * `CODEX_HOME` を取り出す。値の途中の空白（`/Users/John Smith/...`）は、次の `NAME=` の手前までを値とみなす。
 * 環境変数が見えていない（`PATH=` が無い）ときは読めなかったとする。
 */
export function paradisParseCodexHomeFromPsEnvironment(output: string, uid: number | undefined): IParadisCodexProcessHome {
	const match = /^\s*(\d+)\s+([\s\S]*)$/.exec(output.replace(/\n+$/, ''));
	if (!match || (uid !== undefined && Number(match[1]) !== uid)) {
		return UNKNOWN_HOME;
	}
	const line = match[2];
	if (!/(?:^|\s)PATH=/.test(line)) {
		return UNKNOWN_HOME;
	}
	let value: string | undefined;
	for (const entry of line.matchAll(/(?:^|\s)CODEX_HOME=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/g)) {
		value = entry[1]; // 環境変数はコマンドの引数より後ろに並ぶので、最後のものを使う
	}
	return { known: true, codexHome: value !== undefined && value.length > 0 ? value : undefined };
}

/** Linux の `/proc/<pid>/environ`（NUL 区切り）から `CODEX_HOME` を取り出す。 */
export function paradisParseCodexHomeFromProcEnviron(environ: Buffer): IParadisCodexProcessHome {
	for (const entry of environ.toString('utf8').split('\0')) {
		if (entry.startsWith('CODEX_HOME=')) {
			const value = entry.slice('CODEX_HOME='.length);
			return { known: true, codexHome: value.length > 0 ? value : undefined };
		}
	}
	return { known: true };
}

/** 既定の読み方（macOS は `ps -E`、Linux は `/proc`、それ以外は読まない）。 */
export const paradisReadCodexProcessHome: ParadisCodexProcessHomeReader = async pid => {
	const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	try {
		if (process.platform === 'linux') {
			if (uid === undefined || (await fs.stat(`/proc/${pid}`)).uid !== uid) {
				return UNKNOWN_HOME;
			}
			return paradisParseCodexHomeFromProcEnviron(await fs.readFile(`/proc/${pid}/environ`));
		}
		if (process.platform === 'darwin') {
			const output = await new Promise<string>((resolve, reject) => {
				execFile('/bin/ps', ['-E', '-ww', '-o', 'uid=,command=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error('ps failed')) : resolve(stdout));
			});
			return paradisParseCodexHomeFromPsEnvironment(output, uid);
		}
	} catch {
		// 失敗の中身（環境変数を含みうる）は捨てる
	}
	return UNKNOWN_HOME;
};

/**
 * シェルの下で動いている Codex と、読めたらそのホーム。ホームは既定のホームなら undefined にそろえる
 * （画面側の選択と同じ表し方。`CODEX_HOME` を既定のホームと同じ場所にしている場合も既定とみなす）。
 */
export async function paradisCodexPaneProcesses(
	shellPids: readonly number[],
	snapshot: ReadonlyMap<number, IParadisHookProcessInfo> | undefined,
	readHome: ParadisCodexProcessHomeReader = paradisReadCodexProcessHome,
	defaultHome: string = paradisCodexHome(),
): Promise<IParadisCodexPaneProcess[]> {
	const primary = paradisNormalizeCodexHomePath(defaultHome);
	return Promise.all(paradisFindCodexUnderShells(shellPids, snapshot).map(async ({ shellPid, codexPid }) => {
		const home = await readHome(codexPid).catch(() => UNKNOWN_HOME);
		if (!home.known) {
			return { shellPid, homeKnown: false };
		}
		const normalized = home.codexHome === undefined ? undefined : paradisNormalizeCodexHomePath(home.codexHome);
		return normalized === undefined || normalized === primary ? { shellPid, homeKnown: true } : { shellPid, homeKnown: true, codexHome: normalized };
	}));
}
