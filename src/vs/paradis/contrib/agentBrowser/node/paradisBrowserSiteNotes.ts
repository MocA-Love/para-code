/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// サイトメモ（para-browser-improvement.html の E4、設定 `paradis.agentBrowser.siteNotes`。既定は無効）。
// エージェントが、あるサイトでの気づき（「日付欄は YYYY/MM/DD で fill_by」「保存ボタンは iframe の中」）を短く残し、
// 次にそのサイトを開いたエージェントへ「ヒント」として添える。
//
// 決め事（q.html Q303・Q304）:
// - 保存はオリジンとスペース（リポジトリ）の組で分ける。E2E は localhost:3000 などを使うので、オリジンだけで
//   分けると別の製品のメモと混ざる
// - メモには書いた日付と、書いたエージェント（claude / codex）、分かればコミットを残す
// - 結果に添えるときは確定した事実ではなく、古いかもしれないヒントとして渡す。エージェントが消せる
// - ペインが同じスペース・オリジンのメモを受け取るのは 1 回だけ（毎回の結果を膨らませない）
// - 1 つの組に 20 件、1 件 600 字まで。古いものから消す

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';

const MAX_NOTES_PER_KEY = 20;
const MAX_NOTE_CHARS = 600;
const MAX_KEYS = 2000;

export interface IParadisSiteNote {
	readonly id: string;
	readonly text: string;
	/** 書いた日（YYYY-MM-DD、利用者の暦）。 */
	readonly date: string;
	readonly agent?: 'claude' | 'codex';
	/** 書いたときのリポジトリの HEAD（短い形）。 */
	readonly commit?: string;
}

interface IStoreFile {
	readonly version: 1;
	readonly notes: Record<string, IParadisSiteNote[]>;
}

/** URL のオリジン（http / https だけ）。それ以外は undefined。 */
export function paradisSiteNoteOrigin(url: unknown): string | undefined {
	if (typeof url !== 'string') {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
	} catch {
		return undefined;
	}
}

/** 既定の置き場（利用者のフォルダの .para-code の下）。 */
export function paradisSiteNotesDefaultPath(): string {
	return join(homedir(), '.para-code', 'browser-notes', 'site-notes.json');
}

/** フォルダが git のリポジトリなら、その HEAD の短い形。分からなければ undefined（2 秒で諦める）。 */
export function paradisSiteNoteCommit(folder: string | undefined): Promise<string | undefined> {
	if (folder === undefined || !isAbsolute(folder)) {
		return Promise.resolve(undefined);
	}
	return new Promise(resolve => {
		execFile('git', ['-C', folder, 'rev-parse', '--short', 'HEAD'], { timeout: 2000 }, (error, stdout) => {
			const commit = String(stdout ?? '').trim();
			resolve(!error && /^[0-9a-f]{4,40}$/.test(commit) ? commit : undefined);
		});
	});
}

/** 利用者の暦の日付（YYYY-MM-DD）。 */
function localDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function storeKey(space: string, origin: string): string {
	return `${space}\n${origin}`;
}

/** メモの置き場（1 つの JSON ファイル）。書くたびにファイルへ書き戻す。 */
export class ParadisSiteNotesStore {
	private loaded: Promise<Map<string, IParadisSiteNote[]>> | undefined;
	private writing: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string, private readonly now: () => Date = () => new Date()) { }

	private load(): Promise<Map<string, IParadisSiteNote[]>> {
		this.loaded ??= (async () => {
			try {
				const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
				const notes = typeof parsed === 'object' && parsed !== null && typeof (parsed as IStoreFile).notes === 'object' ? (parsed as IStoreFile).notes : {};
				return new Map(Object.entries(notes).filter(([, list]) => Array.isArray(list)));
			} catch {
				return new Map();
			}
		})();
		return this.loaded;
	}

	private async save(map: Map<string, IParadisSiteNote[]>): Promise<void> {
		const body: IStoreFile = { version: 1, notes: Object.fromEntries(map) };
		const write = async () => {
			await fs.mkdir(dirname(this.filePath), { recursive: true });
			const temporary = `${this.filePath}.${generateUuid()}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(body, null, '\t'), { mode: 0o600 });
			await fs.rename(temporary, this.filePath);
		};
		this.writing = this.writing.then(write, write);
		await this.writing;
	}

	async list(space: string, origin: string): Promise<readonly IParadisSiteNote[]> {
		return (await this.load()).get(storeKey(space, origin)) ?? [];
	}

	async write(space: string, origin: string, text: string, meta: { readonly agent?: 'claude' | 'codex'; readonly commit?: string }): Promise<IParadisSiteNote> {
		const map = await this.load();
		const key = storeKey(space, origin);
		const note: IParadisSiteNote = {
			id: generateUuid().slice(0, 8),
			text: text.trim().slice(0, MAX_NOTE_CHARS),
			date: localDate(this.now()),
			...(meta.agent ? { agent: meta.agent } : {}),
			...(meta.commit ? { commit: meta.commit } : {}),
		};
		const list = [...(map.get(key) ?? []), note].slice(-MAX_NOTES_PER_KEY);
		map.delete(key);
		map.set(key, list);
		while (map.size > MAX_KEYS) {
			map.delete(map.keys().next().value!);
		}
		await this.save(map);
		return note;
	}

	/** 消せたら true。 */
	async delete(space: string, origin: string, id: string): Promise<boolean> {
		const map = await this.load();
		const key = storeKey(space, origin);
		const list = map.get(key) ?? [];
		const kept = list.filter(note => note.id !== id);
		if (kept.length === list.length) {
			return false;
		}
		if (kept.length === 0) {
			map.delete(key);
		} else {
			map.set(key, kept);
		}
		await this.save(map);
		return true;
	}
}

/** メモをヒントとして添える文。 */
export function paradisFormatSiteNotesHint(origin: string, notes: readonly IParadisSiteNote[]): string | undefined {
	if (notes.length === 0) {
		return undefined;
	}
	const lines = notes.map(note => `- (${note.id}, ${note.date}${note.agent ? `, ${note.agent}` : ''}${note.commit ? `, commit ${note.commit}` : ''}) ${note.text}`);
	return `[Site notes for ${origin}] Hints left by earlier agents in this repository. They may be out of date: check them against the page, and fix or delete a wrong one (write_site_note / delete_site_note).\n${lines.join('\n')}`;
}

export const PARADIS_SITE_NOTE_TOOL_NAMES: ReadonlySet<string> = new Set(['write_site_note', 'list_site_notes', 'delete_site_note']);

const URL_PROPERTY = { type: 'string', description: 'A URL of the site (the note belongs to its origin, for example https://example.com). Default: the URL of this pane\'s current tab.' };

/** サイトメモの道具（設定が有効なときだけ tools/list に出す）。 */
export const PARADIS_SITE_NOTE_TOOLS = [
	{
		name: 'write_site_note',
		description: 'Leave a short note about the current website for later agents working in this repository, for example "Dates are filled as YYYY/MM/DD with fill_by", "The Save button is inside the payment iframe" or "Log in at /login first". Notes are kept per site (origin) and repository, and are shown once to the next agent that opens the site, as hints. Write facts you had to discover, not the task itself. Never write passwords or other secrets.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: `The note (at most ${MAX_NOTE_CHARS} characters).` },
				url: URL_PROPERTY,
			},
			required: ['text'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_site_notes',
		description: 'List the notes left for a website in this repository (see write_site_note), with their ids, dates and the agent that wrote them.',
		inputSchema: { type: 'object', properties: { url: URL_PROPERTY }, additionalProperties: false },
	},
	{
		name: 'delete_site_note',
		description: 'Delete a note of a website (by the id shown in the notes) that turned out to be wrong or out of date.',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'The id of the note.' }, url: URL_PROPERTY },
			required: ['id'],
			additionalProperties: false,
		},
	},
] as const;

/** 秘密らしい文を書かせない（パスワード・トークン・鍵の形）。 */
export function paradisSiteNoteLooksSecret(text: string): boolean {
	return /\b(password|passwd|pwd|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*\S+/i.test(text)
		|| /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/.test(text);
}
