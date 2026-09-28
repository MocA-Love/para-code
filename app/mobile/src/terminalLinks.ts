// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { parseLocalFileTarget, type LocalFileTarget } from './localFileTarget.js';

/**
 * スマホのターミナルに出た URL とファイルパスを見つける（W2-31）。
 *
 * WebView の中の xterm は、押された位置の「論理行」（折り返しでつながった行を 1 本にしたもの）と、
 * その中の文字の位置だけを渡してくる。ここで URL とパスを探し、押された位置を含むものを返す。
 * iPad のポインタのホバーでは、その行のリンクを全部返して下線を引かせる。
 *
 * - URL は http(s)。`localhost` やプライベートアドレスは PC の内蔵ブラウザ、それ以外は Safari で開く
 *   （{@link terminalUrlDestination}。Q123 A、確認は挟まない）
 * - ファイルは、`/` を含むパスか拡張子付きの名前。行と桁（`:42:7` / `#L42`）はチャットと同じ規則で読む
 *   （`parseLocalFileTarget`）。存在するか・ワークスペースの中かは PC が確かめる
 *
 * 依存は持たない（テストで WebView を立てずに確かめるため）。
 */

/** リンクの行き先（押されたときに開くもの）。 */
export type TerminalLinkTarget =
	| { readonly kind: 'url'; readonly url: string }
	| { readonly kind: 'file'; readonly target: LocalFileTarget };

/** 論理行の中のリンクと、その文字の範囲（`start` から `end` の手前まで）。 */
export type TerminalLink =
	| { readonly kind: 'url'; readonly url: string; readonly start: number; readonly end: number }
	| { readonly kind: 'file'; readonly target: LocalFileTarget; readonly start: number; readonly end: number };

/** URL の本体として受ける文字。空白・引用符・山括弧・制御文字・全角の句読点と括弧で切る。 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`\u0000-\u001f\u007f、。，．「」『』（）【】〈〉《》]+/gi;
/**
 * パスの候補。区切り（`/` `\`）で始まるか途中に含むもの、`~/` `./` `../` `C:\`、または拡張子付きの名前。
 * 後ろに `:行` `:行:桁` `#L行` `(行,桁)` が付いてよい。括弧は Next.js のルートグループ（`app/(group)/page.tsx`）のために受ける。
 */
const PATH_PATTERN = /(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/]|[A-Za-z0-9._@+-]+[\\/]|(?=[A-Za-z0-9._@+-]*\.[A-Za-z]))(?:[A-Za-z0-9._~@+%\-\\/)]|\((?!\d+(?:,\d+)?\)))*(?:\(\d+(?:,\d+)?\))?(?:#L\d+(?:C\d+)?)?(?::\d+)?(?::\d+)?/g;
const LEADING_TRIM = new Set(['(', '[', '{', '"', '\'', '<', '`']);
const TRAILING_TRIM = new Set([')', ']', '}', '"', '\'', '>', '`', ',', ';', '.', ':', '!', '?']);
/** 1 行から探す上限。とても長い行（1 行に詰めた JSON など）で固まらないように。 */
const MAX_LINE_CHARS = 8_000;

/** 前後の括弧・引用符・句読点を外した範囲。括弧は中に対になるものがあれば残す（`app/(group)` など）。 */
function trimToken(text: string, start: number): { text: string; start: number; end: number } | undefined {
	let from = 0;
	let to = text.length;
	while (from < to && LEADING_TRIM.has(text.charAt(from))) {
		from++;
	}
	while (to > from && TRAILING_TRIM.has(text.charAt(to - 1))) {
		const closing = text.charAt(to - 1);
		const opening = closing === ')' ? '(' : closing === ']' ? '[' : closing === '}' ? '{' : undefined;
		if (opening !== undefined && count(text.slice(from, to), opening) >= count(text.slice(from, to), closing)) {
			break;
		}
		to--;
	}
	return from < to ? { text: text.slice(from, to), start: start + from, end: start + to } : undefined;
}

function count(text: string, char: string): number {
	let n = 0;
	for (const c of text) {
		if (c === char) {
			n++;
		}
	}
	return n;
}

/** TypeScript のエラー表記 `src/a.ts(12,5)` の行・桁を、チャットと同じ `:行:桁` に直す。 */
function normalizeParenLocation(text: string): string {
	const match = /^(?<path>.+?)\((?<line>\d+)(?:,(?<column>\d+))?\)?$/.exec(text);
	if (match?.groups?.path === undefined || !/\.[A-Za-z]/.test(match.groups.path)) {
		return text;
	}
	return `${match.groups.path}:${match.groups.line}${match.groups.column !== undefined ? `:${match.groups.column}` : ''}`;
}

/** パスとして扱ってよい見た目か。数字だけの版番号（`1.2.3`）や、区切りも拡張子も無い単語は外す。 */
function looksLikePath(text: string): boolean {
	const bare = text.replace(/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/, '');
	if (bare.length === 0 || /^[\\/]+$/.test(bare) || /^\.{1,2}$/.test(bare)) {
		return false;
	}
	if (/[\\/]/.test(bare)) {
		// `and/or` のような単語の組も候補になるが、存在の確認は PC がする（無ければ何も起きない）。
		return /[A-Za-z0-9_]/.test(bare);
	}
	// 区切りの無い名前は、英字で始まる拡張子が要る（`README.md` は通し、`v1.2` や `3.14` は外す）。
	return /\.[A-Za-z][A-Za-z0-9]*$/.test(bare) && /[A-Za-z_]/.test(bare.slice(0, bare.lastIndexOf('.')));
}

/** 論理行 1 本の中の URL とファイルパスを、出てくる順に返す（重なるものは URL を優先）。 */
export function findTerminalLinks(text: string): TerminalLink[] {
	if (text.length === 0 || text.length > MAX_LINE_CHARS) {
		return [];
	}
	const links: TerminalLink[] = [];
	for (const match of text.matchAll(URL_PATTERN)) {
		const token = trimToken(match[0], match.index ?? 0);
		if (token !== undefined && /^https?:\/\/[^/?#\s]+/i.test(token.text)) {
			links.push({ kind: 'url', url: token.text, start: token.start, end: token.end });
		}
	}
	const urls = [...links];
	for (const match of text.matchAll(PATH_PATTERN)) {
		if (match[0].length === 0) {
			continue;
		}
		const index = match.index ?? 0;
		// URL の中身（`https://host/src/a.ts` の `/src/a.ts` など）はパスとして拾わない。
		if (urls.some(url => index < url.end && index + match[0].length > url.start)) {
			continue;
		}
		// 直前が英数字なら単語の途中から始まっている（`foo:bar/baz` の `bar/baz` など）。
		if (index > 0 && /[A-Za-z0-9:]/.test(text.charAt(index - 1)) && !/[\\/]/.test(match[0].charAt(0))) {
			continue;
		}
		const token = trimToken(match[0], index);
		if (token === undefined) {
			continue;
		}
		const candidate = normalizeParenLocation(token.text);
		if (!looksLikePath(candidate)) {
			continue;
		}
		const target = parseLocalFileTarget(candidate);
		if (target !== undefined) {
			links.push({ kind: 'file', target, start: token.start, end: token.end });
		}
	}
	return links.sort((a, b) => a.start - b.start);
}

/** 論理行の `index` 文字目を含むリンク。 */
export function findTerminalLinkAt(text: string, index: number): TerminalLink | undefined {
	if (index < 0 || index >= text.length) {
		return undefined;
	}
	return findTerminalLinks(text).find(link => index >= link.start && index < link.end);
}

/**
 * OSC 8（ターミナルのハイパーリンク）の行き先。http(s) は URL、`file://` はファイルとして扱う。
 * それ以外のスキーム（`javascript:` など）は開かない。
 */
export function terminalOsc8Link(uri: string): TerminalLinkTarget | undefined {
	const trimmed = uri.trim();
	if (/^https?:\/\/[^/?#\s]+/i.test(trimmed)) {
		return { kind: 'url', url: trimmed };
	}
	if (/^file:\/\//i.test(trimmed)) {
		const target = parseLocalFileTarget(trimmed);
		return target !== undefined ? { kind: 'file', target } : undefined;
	}
	return undefined;
}

/**
 * URL をどこで開くか。PC の中でしか見られない行き先（`localhost`、ループバック、プライベートアドレス、
 * リンクローカル、`.local`、ドットの無いホスト名）は `'pc'`（PC の内蔵ブラウザ）、それ以外は `'external'`（Safari）。
 * http(s) でなければ `undefined`（開かない）。
 *
 * RN の `URL` はホスト名の取り出しが実装されていない版があるので、正規表現で読む。
 */
export function terminalUrlDestination(url: string): 'pc' | 'external' | undefined {
	const match = /^https?:\/\/(?:[^@/?#\s]*@)?(?<host>\[[^\]]*\]|[^:/?#\s]+)/i.exec(url.trim());
	const host = match?.groups?.host?.toLowerCase();
	if (host === undefined || host.length === 0) {
		return undefined;
	}
	return isPcOnlyHost(host) ? 'pc' : 'external';
}

function isPcOnlyHost(host: string): boolean {
	if (host.startsWith('[')) {
		const v6 = host.slice(1, -1);
		return v6 === '::1' || v6 === '::' || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6) || /^::ffff:(?:127|10|192\.168)\./.test(v6);
	}
	const name = host.replace(/\.$/, '');
	if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal') || name.endsWith('.lan') || name.endsWith('.home.arpa')) {
		return true;
	}
	const ipv4 = /^(?<a>\d{1,3})\.(?<b>\d{1,3})\.(?<c>\d{1,3})\.(?<d>\d{1,3})$/.exec(name);
	if (ipv4?.groups !== undefined) {
		const a = Number(ipv4.groups.a);
		const b = Number(ipv4.groups.b);
		return a === 127 || a === 10 || a === 0
			|| (a === 172 && b >= 16 && b <= 31)
			|| (a === 192 && b === 168)
			|| (a === 169 && b === 254)
			|| (a === 100 && b >= 64 && b <= 127);
	}
	// ドットの無い名前（`devbox` など）は社内・手元のホスト名とみなす。
	return !name.includes('.');
}
