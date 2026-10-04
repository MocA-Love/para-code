/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペインと会話の記録（transcript）の結び付けを、Claude Code の `/fork`・`claude --bg`・`claude attach` が
// 混ぜないための判定をまとめる。
//
// `/fork` の分岐先は、元のペインではなく `claude daemon run` の配下の `claude bg-spare` が動かす。
// 分岐先の transcript は元の作業フォルダに作られ、元の会話と並んで更新され続けるので、作業フォルダと
// 更新時刻だけで会話を探す照合はこれを拾ってしまう。ここでは次の 3 つで切り分ける。
// - 分岐先（daemon が動かす会話）の行には `sessionKind: "bg"` が付く。照合の候補から外す。
// - hook で見た transcript はそのペインのもの（別のペインの照合では採らない）。
// - `claude attach <id>` は会話 id の先頭を名指しするので、ファイル名の前方一致で決め打ちする。

import { promises as fs } from 'fs';
import { basename, join } from '../../../../base/common/path.js';

/**
 * `claude attach <id>` の id として受け付ける形（`claude agents` が出す 8 桁の短い id から完全な会話 id まで）。
 * 8 桁（会話 id の最初の区切りまで）より短い id は、無関係な会話にも前方一致しやすいので受け付けない。
 */
const CLAUDE_SESSION_ID_PREFIX_PATTERN = /^[0-9A-Fa-f]{8}[0-9A-Fa-f-]{0,28}$/;
/** ペインの作業フォルダでの一致を、ほかのフォルダより優先してよい id の長さ。 */
const PREFER_PANE_FOLDER_MIN_PREFIX = 8;

export function paradisIsClaudeSessionIdPrefix(value: string): boolean {
	return CLAUDE_SESSION_ID_PREFIX_PATTERN.test(value);
}

export interface IParadisClaudeTranscriptPrefixMatch {
	readonly transcriptPath: string;
	readonly mtime: number;
}

/**
 * 会話 id の先頭に前方一致する transcript を 1 つに決める。
 *
 * 一致する会話 id が 2 つ以上あるときは、どれを attach したのか決められないので undefined を返す
 * （推測で別の会話を見せるより、何も出さない方がよい）。同じ会話 id のファイルが別の作業フォルダにも
 * あるときは、最後に更新された方を採る。
 */
export function paradisSelectClaudeTranscriptByIdPrefix<T extends IParadisClaudeTranscriptPrefixMatch>(entries: readonly T[], idPrefix: string): T | undefined {
	if (!paradisIsClaudeSessionIdPrefix(idPrefix)) {
		return undefined;
	}
	const prefix = idPrefix.toLowerCase();
	const matches = entries.filter(entry => {
		const name = basename(entry.transcriptPath).toLowerCase();
		return name.endsWith('.jsonl') && name.slice(0, -'.jsonl'.length).startsWith(prefix);
	});
	const sessionIds = new Set(matches.map(entry => basename(entry.transcriptPath).toLowerCase()));
	if (sessionIds.size !== 1) {
		return undefined;
	}
	return [...matches].sort((a, b) => b.mtime - a.mtime)[0];
}

/** 全作業フォルダを探すときに見る transcript の上限（前方一致したものだけを数える）。 */
const MAX_PREFIX_MATCHES = 64;

async function collectClaudeTranscriptsByIdPrefix(dir: string, prefix: string, into: IParadisClaudeTranscriptPrefixMatch[]): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (into.length >= MAX_PREFIX_MATCHES) {
			return;
		}
		const lower = name.toLowerCase();
		if (!lower.endsWith('.jsonl') || !lower.startsWith(prefix)) {
			continue;
		}
		try {
			const stat = await fs.stat(join(dir, name));
			if (stat.isFile()) {
				into.push({ transcriptPath: join(dir, name), mtime: stat.mtimeMs });
			}
		} catch { /* 消えた直後などは無視 */ }
	}
}

/** 全作業フォルダ（`~/.claude/projects/*`）から、会話 id の先頭に前方一致する transcript を集める。 */
export async function paradisListClaudeTranscriptsByIdPrefixAcrossProjects(projectsRoot: string, idPrefix: string): Promise<readonly IParadisClaudeTranscriptPrefixMatch[]> {
	if (!paradisIsClaudeSessionIdPrefix(idPrefix)) {
		return [];
	}
	let projectDirs: string[];
	try {
		projectDirs = (await fs.readdir(projectsRoot, { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => join(projectsRoot, entry.name));
	} catch {
		return [];
	}
	const all: IParadisClaudeTranscriptPrefixMatch[] = [];
	for (const dir of projectDirs) {
		if (all.length >= MAX_PREFIX_MATCHES) {
			break;
		}
		await collectClaudeTranscriptsByIdPrefix(dir, idPrefix.toLowerCase(), all);
	}
	return all;
}

/**
 * `claude attach <id>` の会話の transcript を探す。
 *
 * id が 8 桁以上なら、まずペインの作業フォルダの記録を見る。そこで一致したら（決められなくても）そこで止める。
 * 一致しなければ全作業フォルダを見る（attach はどのフォルダからでも打てるので、ペインの作業フォルダと
 * 会話の作業フォルダは同じとは限らない）。全作業フォルダの走査は重いので、呼び手が `scanAllProjects` で
 * 結果を使い回せるようにしてある。
 */
export async function paradisFindClaudeTranscriptByIdPrefix(
	projectsRoot: string,
	preferredProjectDir: string | undefined,
	idPrefix: string,
	scanAllProjects: (idPrefix: string) => Promise<readonly IParadisClaudeTranscriptPrefixMatch[]> = prefix => paradisListClaudeTranscriptsByIdPrefixAcrossProjects(projectsRoot, prefix),
): Promise<{ readonly transcriptPath: string; readonly mtime: number; readonly sessionId: string } | undefined> {
	if (!paradisIsClaudeSessionIdPrefix(idPrefix)) {
		return undefined;
	}
	const pick = (entries: readonly IParadisClaudeTranscriptPrefixMatch[]) => {
		const selected = paradisSelectClaudeTranscriptByIdPrefix(entries, idPrefix);
		return selected === undefined ? undefined : { ...selected, sessionId: basename(selected.transcriptPath).slice(0, -'.jsonl'.length) };
	};
	if (preferredProjectDir !== undefined && idPrefix.length >= PREFER_PANE_FOLDER_MIN_PREFIX) {
		const local: IParadisClaudeTranscriptPrefixMatch[] = [];
		await collectClaudeTranscriptsByIdPrefix(preferredProjectDir, idPrefix.toLowerCase(), local);
		if (local.length > 0) {
			return pick(local);
		}
	}
	return pick(await scanAllProjects(idPrefix));
}

/** 会話の行（`sessionKind` を持ちうる行）の種類。ファイル先頭の題名・モードなどの行は判定に使わない。 */
const CLAUDE_CONVERSATION_LINE_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

/**
 * transcript の行を与えた順に見て、最初に判定できた行で「daemon が動かす会話か」を返す。
 * 判定できる行が無ければ undefined。
 *
 * Claude Code 2.1.289 で実測した形: daemon の配下で動く会話（`/fork` の分岐先と `claude --bg`）は、
 * 会話の行の最上位に `"sessionKind": "bg"` を持つ（`/fork` で写した元の行にも付く）。ペインで動く会話の
 * 行には `sessionKind` が無い。本文に `sessionKind` という文字列が出るだけの会話を取り違えないよう、
 * 行を JSON として読んで最上位のフィールドだけを見る。
 */
export function paradisClaudeTranscriptLinesAreBackground(lines: Iterable<string>): boolean | undefined {
	for (const line of lines) {
		if (!line.includes('"sessionId"')) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			continue;
		}
		const record = parsed as { readonly sessionKind?: unknown; readonly uuid?: unknown; readonly type?: unknown };
		if (typeof record.sessionKind === 'string') {
			return record.sessionKind === 'bg';
		}
		if (typeof record.uuid === 'string' && typeof record.type === 'string' && CLAUDE_CONVERSATION_LINE_TYPES.has(record.type)) {
			return false;
		}
	}
	return undefined;
}

/**
 * 窓の頭で切れた行（終わりだけが読めた行）の末尾から、最上位の `sessionKind` を読む。
 *
 * Claude Code 2.1.289 は `sessionKind` を会話の行の最後のキーとして書く（`…,"gitBranch":"main","sessionKind":"bg"}`）。
 * 行の最後の `}` は最上位のオブジェクトを閉じるものなので、その直前のキーは最上位のもの。画像などで 1 行が窓より
 * 長くても、行の終わりさえ読めれば判定できる。行の頭には `sessionKind` が無いので、頭だけ読めた行では判定しない。
 */
export function paradisClaudeTranscriptLineEndIsBackground(lineEnd: string): boolean | undefined {
	const match = /"sessionKind":"(?<kind>[^"\\]*)"\}\s*$/.exec(lineEnd);
	return match?.groups === undefined ? undefined : match.groups.kind === 'bg';
}

/** 末尾・先頭それぞれで読む量。会話の 1 行がこれより長い（画像など）と、その窓では判定できない。 */
const SESSION_KIND_WINDOW_BYTES = 64 * 1024;
const SESSION_KIND_CACHE_LIMIT = 256;

/** `bg`: daemon の配下の会話。`pane`: ペインで動く会話（または会話の行がまだ無い）。undefined: 読めない・決まらない。 */
export type ParadisClaudeTranscriptSessionKind = 'bg' | 'pane' | undefined;
const sessionKindCache = new Map<string, { readonly stamp: string; readonly kind: ParadisClaudeTranscriptSessionKind }>();

/**
 * transcript を今書いているのが daemon の配下の会話か。
 *
 * 末尾の行から見る（今書いているプロセスの行）。daemon の会話をペインで `claude --resume` し直した
 * ときは、先頭の行は `bg` のままで末尾の行だけがペインのものになるので、先頭だけでは判定を誤る。
 * 末尾で決まらなければ先頭を見る。ファイル全体を読み切って会話の行が 1 つも無ければ `pane`（まだ何も
 * 書かれていない会話）。読めない・窓に収まらない行しか無くて決まらないときは undefined。
 */
export async function paradisClaudeTranscriptSessionKind(transcriptPath: string): Promise<ParadisClaudeTranscriptSessionKind> {
	let handle: fs.FileHandle | undefined;
	try {
		// 先に stat だけで控えと照らす（変わっていなければファイルを開かない）
		const stat = await fs.stat(transcriptPath);
		const stamp = `${stat.size}:${stat.mtimeMs}`;
		const cached = sessionKindCache.get(transcriptPath);
		if (cached?.stamp === stamp) {
			return cached.kind;
		}
		const fileHandle = await fs.open(transcriptPath, 'r');
		handle = fileHandle;
		const read = async (position: number, length: number): Promise<string> => {
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
			return buffer.subarray(0, bytesRead).toString('utf8');
		};
		const tailStart = Math.max(0, stat.size - SESSION_KIND_WINDOW_BYTES);
		const tailLines = (await read(tailStart, stat.size - tailStart)).split('\n');
		// 窓の頭で切れた行。終わりは読めているので、末尾の sessionKind だけは読める
		const cutLineEnd = tailStart > 0 ? tailLines.shift() : undefined;
		let background = paradisClaudeTranscriptLinesAreBackground(tailLines.reverse());
		if (background === undefined && cutLineEnd !== undefined) {
			background = paradisClaudeTranscriptLineEndIsBackground(cutLineEnd);
		}
		if (background === undefined && tailStart > 0) {
			const headLines = (await read(0, Math.min(SESSION_KIND_WINDOW_BYTES, stat.size))).split('\n');
			headLines.pop(); // 窓の尻で切れた行（頭には sessionKind が無いので読まない）
			background = paradisClaudeTranscriptLinesAreBackground(headLines);
		}
		const kind: ParadisClaudeTranscriptSessionKind = background === true ? 'bg' : background === false ? 'pane'
			// ファイル全体を窓で読み切れたのに会話の行が無い = まだ会話が書かれていない
			: tailStart === 0 ? 'pane' : undefined;
		sessionKindCache.delete(transcriptPath);
		while (sessionKindCache.size >= SESSION_KIND_CACHE_LIMIT) {
			const oldest = sessionKindCache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			sessionKindCache.delete(oldest);
		}
		sessionKindCache.set(transcriptPath, { stamp, kind });
		return kind;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => { /* ignore */ });
	}
}

/** hook の経路用。決まらないときは daemon の会話とみなさない（ペインの hook を捨てない）。 */
export async function paradisClaudeTranscriptIsBackground(transcriptPath: string): Promise<boolean> {
	return await paradisClaudeTranscriptSessionKind(transcriptPath) === 'bg';
}

export type ParadisHookTranscriptSightingKind = 'root' | 'nested' | 'background';

/** 見たことを覚えておく時間。hook が来続ける限り延びる。 */
const SIGHTING_TTL_MS = 60 * 60_000;
const SIGHTING_LIMIT = 1_024;

/**
 * hook で見た transcript の控え。作業フォルダからの照合で「ほかのペインの会話」を採らないために使う。
 *
 * - `root`: そのペインの会話。そのペイン自身の照合では候補に残し、ほかのペインの照合では外す。
 * - `nested`: ペインの中で動いた子エージェントの会話。どのペインの会話でもないので、どの照合でも外す。
 * - `background`: daemon の配下の会話（`/fork` の分岐先など）。どのペインの会話でもないので、どの照合でも外す
 *   （`claude attach <id>` の決め打ちだけが採る）。
 */
export class ParadisHookTranscriptSightings {
	private readonly entries = new Map<string, { readonly token: string; readonly kind: ParadisHookTranscriptSightingKind; readonly at: number }>();

	constructor(
		private readonly ttlMs: number = SIGHTING_TTL_MS,
		private readonly limit: number = SIGHTING_LIMIT,
	) { }

	note(transcriptPath: string, token: string, kind: ParadisHookTranscriptSightingKind, at: number): void {
		if (transcriptPath.length === 0) {
			return;
		}
		this.entries.delete(transcriptPath);
		while (this.entries.size >= this.limit) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.entries.delete(oldest);
		}
		this.entries.set(transcriptPath, { token, kind, at });
	}

	/** `token` のペインの照合で候補から外す transcript。 */
	excludedFor(token: string, now: number): Set<string> {
		const excluded = new Set<string>();
		for (const [transcriptPath, entry] of [...this.entries]) {
			if (now - entry.at > this.ttlMs) {
				this.entries.delete(transcriptPath);
				continue;
			}
			if (entry.kind !== 'root' || entry.token !== token) {
				excluded.add(transcriptPath);
			}
		}
		return excluded;
	}

	/**
	 * ペインのエージェントが終わった・ペインが消えた。そのペインの会話は、別のペインで
	 * `--resume` し直されうるので外す（子エージェントと daemon の会話は残す）。
	 */
	forgetRoots(token: string): void {
		for (const [transcriptPath, entry] of [...this.entries]) {
			if (entry.token === token && entry.kind === 'root') {
				this.entries.delete(transcriptPath);
			}
		}
	}

	/** `transcriptPath` を `token` のペインの会話として hook で見たか。 */
	isRootFor(transcriptPath: string, token: string): boolean {
		const entry = this.entries.get(transcriptPath);
		return entry !== undefined && entry.kind === 'root' && entry.token === token;
	}

	/** `keep` が false を返すペイン（消えたペイン）の会話を外す。 */
	forgetRootsExcept(keep: (token: string) => boolean): void {
		for (const [transcriptPath, entry] of [...this.entries]) {
			if (entry.kind === 'root' && !keep(entry.token)) {
				this.entries.delete(transcriptPath);
			}
		}
	}

	clear(): void {
		this.entries.clear();
	}
}
