// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 添付画像のパスと、発言の文字の行き来（純関数）。
 *
 * アプリは画像を PC の置き場（`<userData>/User/paraMobileUploads/`）へ上げ、その絶対パスを本文の先頭に並べて
 * エージェントへ送る（案 M1）。会話に戻ってくる発言には、そのパスが文字のまま残る（Claude Code 2.1.220 以降。
 * 2.1.207 は `[Image #1]` を前に付ける。Codex が画像として取り込んだときは `<image name=[Image #1] path="…">` の包み）。
 * 吹き出しではパスを隠し、札（「画像 1」）に置き換える（案 C2）。
 *
 * 「添付の画像」と見なすのは、置き場の直下の、アップロードが作った名前のファイルを指す絶対パスだけ
 * （`…/User/paraMobileUploads/attachment-<13 桁>-<乱数>.<拡張子>`。置き場は userData の `User` の下）。名前の形は PC の
 * `paradisMobileAttachment.ts` の `PARADIS_MOBILE_ATTACHMENT_NAME_PATTERN` と同じ（アプリは PC のコードを
 * 読めない層なので写している。片方を変えたらもう片方も直す）。
 */

/** 添付の名前（`attachment-<13 桁のミリ秒>-<乱数>.<拡張子>`）。 */
export const ATTACHMENT_NAME_PATTERN = /^attachment-\d{13}-[A-Za-z0-9]{1,12}(?:\.[A-Za-z0-9]{1,8})?$/;

/** 1 通に添付できる枚数。 */
export const ATTACHMENT_LIMIT = 5;

/** 文中で添付のパスの末尾（区切り・`User`・置き場の名前とファイル名）を探す。直後に英数字や「.英数字」が続くものは別の名前。 */
const ANCHOR = /[\\/]User[\\/]paraMobileUploads[\\/](attachment-\d{13}-[A-Za-z0-9]{1,12}(?:\.[A-Za-z0-9]{1,8})?)(?![A-Za-z0-9]|\.[A-Za-z0-9])/g;

/** パスの始まりの直前に来てよい文字（行頭のほか、空白・括弧・引用符・Claude の `[Image #1]` の `]`）。 */
const PATH_BOUNDARY = /[\s"'`(<[\]=]/;

/** Codex が貼られた画像を包む形（`<image name=[Image #1] path="…">`、`[image]`、`</image>`）。 */
const CODEX_IMAGE_WRAPPER = /<image name=\[Image #(\d+)\] path="([^"\n]*)">\s*(?:\[image\]\s*)?<\/image>[ \t]*\n?/g;

export interface MessageAttachment {
	/** 置き場の中の名前（`attachment-…`）。端末の控え・PC からの取り寄せの鍵。 */
	readonly name: string;
	/** 本文に書かれていた絶対パス（長押しの「パスをコピー」で渡す）。 */
	readonly path: string;
}

export interface ParsedAttachmentMessage {
	/** 札に置き換える添付（書かれていた順。同じ名前は 1 つにまとめる）。 */
	readonly attachments: readonly MessageAttachment[];
	/** パスを除いた本文。添付が無ければ元の文字のまま。 */
	readonly body: string;
}

/** パスの名前の部分（区切りは `/` と `\` のどちらでも）。 */
export function attachmentNameOf(path: string): string | undefined {
	const name = path.split(/[\\/]/).pop() ?? '';
	return ATTACHMENT_NAME_PATTERN.test(name) && /[\\/]User[\\/]paraMobileUploads[\\/]attachment-[^\\/]*$/.test(path) ? name : undefined;
}

/** `index` の位置の文字が、パスの始まりの直前として通るか。 */
function isBoundary(text: string, index: number): boolean {
	return index <= 0 || PATH_BOUNDARY.test(text.charAt(index - 1));
}

/**
 * 置き場の名前（`paraMobileUploads`）の位置から、同じ行の中で後ろへさかのぼってパスの始まりを探す。
 * パスは空白を含みうる（`Application Support`）ので、空白では切らない。始まりは「区切りの後の `/`」か
 * 「区切りの後の `C:\`」。中のディレクトリ名は空白の後に `/` が来ない限り始まりと取り違えない。
 */
function findPathStart(text: string, anchor: number, floor: number): number | undefined {
	for (let index = anchor; index >= floor; index--) {
		const char = text.charAt(index);
		if (char === '\n' || char === '\r') {
			return undefined;
		}
		if (char === '/' && isBoundary(text, index)) {
			return index;
		}
		if (/[A-Za-z]/.test(char) && text.charAt(index + 1) === ':' && (text.charAt(index + 2) === '\\' || text.charAt(index + 2) === '/') && isBoundary(text, index)) {
			return index;
		}
	}
	return undefined;
}

interface Removal {
	readonly start: number;
	readonly end: number;
}

/**
 * 発言の文字から添付のパスを抜き出し、札に置き換える準備をする。
 *
 * - 添付のパスは場所によらず全部抜く（今は先頭にまとめて送るが、以前のアプリは本文の後ろへ足していた）
 * - パスの直前の `[Image #N]`（Claude 2.1.207）、Codex の包みとそれを指す本文中の `[Image #N]` も外す
 * - 添付があった発言では、画像の置き場所の印 `[image]` だけの行も外す（PC が transcript の画像のブロックを書き換えた印）
 * - 外した後に残る前後の空白は詰める。本文の中の改行や字下げはそのまま
 */
export function parseAttachmentMessage(text: string): ParsedAttachmentMessage {
	if (!text.includes('paraMobileUploads')) {
		return { attachments: [], body: text };
	}
	const attachments: MessageAttachment[] = [];
	const add = (name: string, path: string) => {
		if (!attachments.some(attachment => attachment.name === name)) {
			attachments.push({ name, path });
		}
	};
	// Codex の包みは包みごと外し、本文中の同じ番号の `[Image #N]` も外す
	const codexNumbers = new Set<string>();
	let working = text.replace(CODEX_IMAGE_WRAPPER, (whole: string, number: string, path: string) => {
		const name = attachmentNameOf(path);
		if (name === undefined) {
			return whole;
		}
		add(name, path);
		codexNumbers.add(number);
		return '';
	});
	if (codexNumbers.size > 0) {
		working = working.replace(/\[Image #(\d+)\][ \t]?/g, (whole: string, number: string) => codexNumbers.has(number) ? '' : whole);
	}

	const removals: Removal[] = [];
	let floor = 0;
	for (const match of working.matchAll(ANCHOR)) {
		const anchor = match.index ?? 0;
		const start = findPathStart(working, anchor, floor);
		const end = anchor + match[0].length;
		if (start === undefined) {
			continue;
		}
		let removeStart = start;
		// Claude 2.1.207 の `[Image #1]/Users/…` は番号ごと外す
		const before = /\[Image #\d+\][ \t]*$/.exec(working.slice(floor, start));
		if (before !== undefined && before !== null) {
			removeStart = start - before[0].length;
		}
		// パスの後の空白（行の中だけ）も一緒に外す
		let removeEnd = end;
		while (removeEnd < working.length && (working[removeEnd] === ' ' || working[removeEnd] === '\t')) {
			removeEnd++;
		}
		add(match[1] ?? '', working.slice(start, end));
		removals.push({ start: removeStart, end: removeEnd });
		floor = end;
	}
	if (attachments.length === 0) {
		return { attachments: [], body: text };
	}
	let body = '';
	let cursor = 0;
	for (const removal of removals) {
		body += working.slice(cursor, removal.start);
		cursor = removal.end;
	}
	body += working.slice(cursor);
	body = body
		.split('\n')
		.filter(line => line.trim() !== '[image]')
		.join('\n')
		.replace(/^\s+/, '')
		.replace(/\s+$/, '');
	return { attachments, body };
}

/**
 * 送る文字を組み立てる（案 M1）: 添付のパスを選んだ順に空白で並べ、本文があれば改行して続ける。
 * 質問への回答（1 行に平坦化される）では改行の代わりに空白でつなぐ。
 */
/**
 * 本文の上限から、先頭に付く添付のパス（{@link composeAttachmentMessage} の形。パスを空白でつなぎ、本文との間に 1 文字）の
 * 分を引いた、入力欄に打てる長さ。
 */
export function attachmentTextBudget(limit: number, paths: readonly string[]): number {
	return paths.length === 0 ? limit : Math.max(0, limit - paths.join(' ').length - 1);
}

export function composeAttachmentMessage(paths: readonly string[], text: string, singleLine = false): string {
	if (paths.length === 0) {
		return text;
	}
	const head = paths.join(' ');
	return text.trim().length > 0 ? `${head}${singleLine ? ' ' : '\n'}${text}` : head;
}

/** 端末に書くときのファイル名。名前に拡張子が無ければ種類から付ける（写真への保存は拡張子が要る）。 */
export function attachmentFileName(name: string, mediaType?: string): string {
	if (/\.[A-Za-z0-9]{1,8}$/.test(name)) {
		return name;
	}
	const extension = mediaType === 'image/png' ? 'png' : mediaType === 'image/gif' ? 'gif' : mediaType === 'image/webp' ? 'webp' : mediaType === 'image/heic' ? 'heic' : 'jpg';
	return `${name}.${extension}`;
}

/** base64 の先頭から画像の種類を当てる（PC のバイナリ応答は種類を持たない）。 */
export function attachmentMediaTypeOfBase64(base64: string): string | undefined {
	if (base64.startsWith('/9j/')) {
		return 'image/jpeg';
	}
	if (base64.startsWith('iVBORw0KGgo')) {
		return 'image/png';
	}
	if (base64.startsWith('R0lGOD')) {
		return 'image/gif';
	}
	if (base64.startsWith('UklGR')) {
		return 'image/webp';
	}
	return undefined;
}
