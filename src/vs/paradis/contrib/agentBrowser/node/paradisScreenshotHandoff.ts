/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// take_screenshot がファイルに保存したとき、そのファイルを別の機械から取りに来られるようにする。
//
// なぜ要るか: MCP サーバーは手元の shared process に居る。SSH で繋いだ先で動くエージェントが
// `filePath` を渡すと、そのパスは**手元の**パスとして解釈され、画像は接続先から見えない場所へ
// 落ちる。エージェントは自分の機械に画像が出来たつもりで PR に添付しようとして失敗する。
//
// 画像を「見る」だけなら今も困らない（2MB 未満は応答に直接載るので接続先まで届く）。ここで
// 埋めるのは「接続先にファイルとして残す」経路だけ。
//
// 仕組み: 保存したファイルに使い捨ての id を振って覚えておき、ゲートウェイに取り出し口を1つ
// 生やす。接続先から手元へは既に戻り経路（ssh -R）が張ってあるので、接続先で curl するだけで
// 同じ番号に届く。新しいトンネルも renderer の関与も要らない。
//
// 安全側の作り:
//  - 取り出せるのは**私たちが登録したパスだけ**（要求側はパスを指定できない。id は乱数）
//  - 撮ったペインと同じトークンでなければ渡さない
//  - 件数と保持時間に上限を置く

import { promises as fs } from 'fs';

/** 取り出し口のパス。ゲートウェイの他のエンドポイントと同じ接頭辞に揃える。 */
export const PARADIS_SCREENSHOT_FETCH_PATH = '/paradis-mcp/screenshot';

/** 覚えておく件数の上限。古いものから捨てる。 */
const MAX_ENTRIES = 32;

/** 保存から取り出しまでの猶予。撮ってすぐ取りに来る想定なので短くてよい。 */
const ENTRY_TTL_MS = 30 * 60_000;

/** 配る1ファイルの上限。フルページの巨大な画像で shared process を膨らませない。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const EXTENSION_CONTENT_TYPES = new Map<string, string>([
	['.png', 'image/png'],
	['.jpeg', 'image/jpeg'],
	['.jpg', 'image/jpeg'],
	['.webp', 'image/webp'],
]);

interface IHandoffEntry {
	readonly token: string;
	readonly path: string;
	readonly at: number;
}

/**
 * chrome-devtools-mcp の take_screenshot が返す本文から、保存先のパスを拾う。
 *
 * 保存の経路は2つある（`filePath` 指定と、2MB 超で自動的に一時ファイルへ逃げる場合）が、
 * どちらも `Saved screenshot to <path>.` という同じ1行を書く。ベンダーしている成果物には
 * 手を入れたくないので、出力の側から拾う。
 */
export function paradisScreenshotPathsFromToolResult(result: unknown): readonly string[] {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) {
		return [];
	}
	const paths: string[] = [];
	for (const entry of content) {
		const text = (entry as { type?: unknown; text?: unknown })?.text;
		if ((entry as { type?: unknown })?.type !== 'text' || typeof text !== 'string') {
			continue;
		}
		for (const line of text.split('\n')) {
			// 末尾の句点だけを外す。パス自体にも `.` は入るので、行末に固定して最短一致で取る
			const match = /^\s*Saved screenshot to (.+?)\.\s*$/.exec(line);
			if (match !== null && match[1].length > 0) {
				paths.push(match[1]);
			}
		}
	}
	return paths;
}

/**
 * 「この機械では別の場所にある」ことと、取りに来る方法を応答へ書き足す。
 *
 * 手元のペインから呼ばれたときは元のパスがそのまま使えるので余計な情報になるが、呼び出し元が
 * どの機械に居るかは MCP の要求からは分からない。数行足すだけの害と、SSH 接続時に画像を
 * 取り出せない害とを比べて、常に添える方を選んでいる。
 *
 * ポート番号は手元のぶんしか書かない。接続先で開いている番号は `ssh -R` が空きから選ぶので
 * 手元とは一致せず、書いても必ず古くなる（以前は接続先でも同じ固定番号を開いていたので
 * たまたま一致していた）。接続先には、その場でポートファイルを読ませる。
 */
export function paradisAppendScreenshotFetchHint(result: unknown, entries: readonly IParadisScreenshotFetchTarget[]): unknown {
	const content = (result as { content?: unknown })?.content;
	if (entries.length === 0 || !Array.isArray(content)) {
		return result;
	}
	const lines = [
		'The screenshot was written on the machine running Para Code, which is not necessarily the machine you are on.',
		'If that path does not exist for you (for example when Para Code is connected to this host over SSH), download it instead.',
		'',
		'On the machine running Para Code:',
		...entries.map(entry => `  curl -fsS -H "Authorization: Bearer $PARA_CODE_TERMINAL_PANE_ID" http://127.0.0.1:${entry.localPort}${PARADIS_SCREENSHOT_FETCH_PATH}/${entry.id} -o <local-name>`),
		'',
		// 接続先で開くポートは ssh に選ばせた番号で、手元の番号とは一致しない。番号を焼き込むと
		// 必ず古くなるので、その場で読ませる (このファイルの場所は接続先の hooks が持っている)。
		'Over SSH the port is different — the return tunnel picks a free one. Read it from the port file first:',
		`  PORT=$(sed -n 's/.*"port":[[:space:]]*\\([0-9]*\\).*/\\1/p' "$PARA_CODE_MCP_PORT_FILE")`,
		...entries.map(entry => `  curl -fsS -H "Authorization: Bearer $PARA_CODE_TERMINAL_PANE_ID" "http://127.0.0.1:$PORT${PARADIS_SCREENSHOT_FETCH_PATH}/${entry.id}" -o <local-name>`),
	];
	return { ...(result as object), content: [...content, { type: 'text', text: lines.join('\n') }] };
}

/** 取り出し口1件分。番号は手元のぶんだけを持ち、接続先の番号は案内側で読ませる。 */
export interface IParadisScreenshotFetchTarget {
	readonly id: string;
	/** 手元 (Para Code が動いている機械) の MCP ポート。 */
	readonly localPort: number;
}

/**
 * 保存したスクリーンショットの受け渡し台帳（shared process 側）。
 */
export class ParadisScreenshotHandoff {

	private readonly entries = new Map<string, IHandoffEntry>();

	constructor(private readonly newId: () => string) { }

	/** 保存先を覚え、取り出し用の id を返す。 */
	register(token: string, path: string): string {
		this.sweep();
		const id = this.newId();
		this.entries.set(id, { token, path, at: Date.now() });
		while (this.entries.size > MAX_ENTRIES) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.entries.delete(oldest.value);
		}
		return id;
	}

	/** 撮ったペインと同じトークンのときだけ、保存先を返す。 */
	resolve(token: string, id: string): string | undefined {
		this.sweep();
		const entry = this.entries.get(id);
		return entry !== undefined && entry.token === token ? entry.path : undefined;
	}

	/** テスト・診断用。 */
	get size(): number {
		return this.entries.size;
	}

	private sweep(): void {
		const now = Date.now();
		for (const [id, entry] of [...this.entries]) {
			if (now - entry.at > ENTRY_TTL_MS) {
				this.entries.delete(id);
			}
		}
	}
}

/** 取り出し口へ来た URL から id を取り出す。余計なパスが付いていたら受け付けない。 */
export function paradisScreenshotIdFromUrl(url: string | undefined): string | undefined {
	if (url === undefined) {
		return undefined;
	}
	const path = url.split('?')[0];
	if (!path.startsWith(`${PARADIS_SCREENSHOT_FETCH_PATH}/`)) {
		return undefined;
	}
	const id = path.slice(PARADIS_SCREENSHOT_FETCH_PATH.length + 1);
	return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : undefined;
}

/** 拡張子から Content-Type を決める。分からないものは素のバイト列として返す。 */
export function paradisScreenshotContentType(path: string): string {
	const dot = path.lastIndexOf('.');
	const extension = dot < 0 ? '' : path.slice(dot).toLowerCase();
	return EXTENSION_CONTENT_TYPES.get(extension) ?? 'application/octet-stream';
}

/** 登録済みの保存先を読む。大きすぎるもの・消えているものは渡さない。 */
export async function paradisReadScreenshotFile(path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
	const stat = await fs.stat(path).catch(() => undefined);
	if (stat === undefined || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
		return undefined;
	}
	// クライアント切断時は signal 経由で読み込みを中断させる（呼び出し側の枠管理が解放を待つ）。
	return fs.readFile(path, { signal }).catch(() => undefined);
}
