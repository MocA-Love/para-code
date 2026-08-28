/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Markdown ビューアが表示する HTML の中で、ローカルのファイルを指している画像を data: URI へ
// 埋め込み直す。
//
// なぜ必要か:
// ビューアの webview は service worker を無効にしている。webview の `vscode-resource` URL は
// service worker が解決しているので、無効にすると相対パスの画像が読めなくなる。読み込みの時点で
// こちらが埋め込んでしまえば、書く側は今までどおり `![図](./a.png)` と書くだけでよく、記法も
// ファイルの置き方も何も変わらない。
//
// service worker を切っている理由:
// webview の origin に service worker の登録があると、その scope へのナビゲーションが worker の
// 起動完了を待たされる。実機で `index.html` / `fake.html`（188バイトの静的ファイル）の読み込みが
// 60 秒止まるのを3回観測しており、ビューアの白紙はこれが原因だった。upstream も「文書を見せる
// だけ」の webview（拡張機能の README、リリースノート、ウォークスルー、画像プレビュー）では
// 同じく `disableServiceWorker: true` にしている。
//
// なぜ DOMParser なのか:
// 出来上がる document はブラウジングコンテキストを持たないので、**走査中にワークベンチ側が
// 画像を読みにいくことがない**。upstream も webview の `toContentHtml` で同じ手を使っている。
//
// **`parseFromString` は Trusted Types のシンクである。** ワークベンチのページは
// `require-trusted-types-for 'script'` を要求するので、素の文字列を渡すと
// 「This document requires 'TrustedHTML' assignment」で落ちる（paracode-121 で実際に落ちた）。
// `renderMarkdownDocument` が返す `TrustedHTML` を **そのまま** 渡すこと。`String()` などで
// 文字列へ落としてはいけない。ここを緩める新しいポリシーを足すには workbench.html の
// `trusted-types` 許可リストに名前を足す必要があり、そこまでする理由が無い。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { getMediaMime } from '../../../../base/common/mime.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname, resolvePath, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/** 埋め込みを諦める大きさ。data: は元の約1.33倍に膨らむので、無制限に流すと描画自体が重くなる。 */
export interface IParadisInlineMediaLimits {
	/** 1ファイルあたりの上限（バイト）。 */
	readonly maxBytesPerFile: number;
	/** 1文書あたりの合計の上限（バイト）。 */
	readonly maxBytesTotal: number;
}

/**
 * 既定の上限。Markdown に貼る図やスクリーンショットは通常 1MB に満たないので、実用上ここに
 * 当たるのは「動画のような大きなファイルを貼っている」場合だけになる。
 */
export const PARADIS_INLINE_MEDIA_LIMITS: IParadisInlineMediaLimits = {
	maxBytesPerFile: 8 * 1024 * 1024,
	maxBytesTotal: 32 * 1024 * 1024,
};

/** 埋め込めなかったものの理由。表示する文言を決めるためだけに使う。 */
type ParadisMediaFailure = 'missing' | 'too-large';

export interface IParadisInlineMediaResult {
	/** 埋め込み後の HTML（body の中身）。 */
	readonly html: string;
	/** data: へ埋め込んだ数。 */
	readonly inlined: number;
	/** 読めなかった・大きすぎて見送った数。 */
	readonly skipped: number;
}

/** 埋め込めなかった箇所に差し込む短い断り書きの見た目。 */
export const PARADIS_INLINE_MEDIA_STYLES = `
.paradis-media-unavailable {
	display: inline-block;
	padding: 2px 8px;
	border: 1px dashed var(--vscode-widget-border, rgba(127, 127, 127, 0.35));
	border-radius: 4px;
	color: var(--vscode-descriptionForeground, #8b8b8b);
	font-size: 0.9em;
	vertical-align: middle;
}
`;

/**
 * そのままにしておく参照かどうか。
 *
 * `data:` は既に埋め込み済み、`http(s):` と `blob:` は webview がそのまま読めるので触らない
 * （Markdown ビューアの CSP は `img-src https: data:` を許可している）。
 */
function isAlreadyLoadable(src: string): boolean {
	return /^(data|https|http|blob):/i.test(src);
}

/**
 * `src` の文字列を読み取るべきファイルの URI に直す。解決できないものは `undefined`。
 *
 * - スキーム付き（`file:` / `vscode-remote:`）はそのまま
 * - `/` 始まりは、標準の Markdown プレビューと同じくワークスペースフォルダーの直下として扱う
 * - それ以外は文書のあるディレクトリからの相対
 */
export function resolveParadisMediaUri(src: string, documentUri: URI, workspaceFolder: URI | undefined): URI | undefined {
	// 断片やクエリはファイル名の一部ではない。`?raw=true` 付きのリンクも読めるようにする。
	const withoutQuery = src.replace(/[?#].*$/, '').trim();
	if (!withoutQuery) {
		return undefined;
	}

	if (/^[a-z][a-z0-9+.-]*:/i.test(withoutQuery)) {
		try {
			const parsed = URI.parse(withoutQuery);
			return parsed.scheme === Schemas.file || parsed.scheme === Schemas.vscodeRemote ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(withoutQuery);
	} catch {
		// 壊れたパーセントエンコードはそのまま素のパスとして扱う（読めなければ後段で諦める）。
		decoded = withoutQuery;
	}

	if (decoded.startsWith('/')) {
		return workspaceFolder ? joinPath(workspaceFolder, decoded) : undefined;
	}
	return resolvePath(dirname(documentUri), decoded);
}

/**
 * 走査対象にするタグ。Markdown のサニタイザが通すのは `img` と `source` だが、拡張の
 * プラグインが増やす場合に備えて素直な候補も見ておく。
 */
const MEDIA_TAG_NAMES: ReadonlySet<string> = new Set(['IMG', 'SOURCE', 'VIDEO', 'AUDIO']);

/**
 * 木を辿ってメディア要素を集める。
 *
 * セレクタ（`querySelectorAll` 等）はこのリポジトリでは使わない決まりなので自前で降りる。
 * 集めた要素はこの後で差し替え・削除されるため、**走査を終えてから配列で返す**
 * （生きたコレクションを回しながら木を触ると取りこぼす）。
 */
function collectMediaElements(root: Element): Element[] {
	const found: Element[] = [];
	const stack: Element[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node !== root && MEDIA_TAG_NAMES.has(node.tagName)) {
			found.push(node);
		}
		const children = node.children;
		for (let index = children.length - 1; index >= 0; index--) {
			stack.push(children[index]);
		}
	}
	return found;
}

/** 読めなかった箇所に置く、短い断り書きの要素を作る。 */
function createUnavailableNode(doc: Document, src: string, reason: ParadisMediaFailure): HTMLElement {
	const node = doc.createElement('span');
	node.className = 'paradis-media-unavailable';
	node.textContent = reason === 'too-large'
		? localize('paradis.markdown.mediaTooLarge', "画像が大きすぎるためここには表示できません: {0}", src)
		: localize('paradis.markdown.mediaMissing', "画像が見つかりませんでした: {0}", src);
	return node;
}

/**
 * レンダリング済みの Markdown HTML を走査し、ローカルの画像を data: URI に置き換える。
 *
 * 呼び出し側はサニタイズ済みの HTML を渡すこと。ここは属性値の差し替えしかしないので、
 * サニタイズの結果を緩めることはない（新しいタグも属性も足さない。断り書きの `span` だけ）。
 */
export async function inlineParadisMarkdownMedia(
	rendered: TrustedHTML | string,
	documentUri: URI,
	workspaceFolder: URI | undefined,
	fileService: IFileService,
	token: CancellationToken,
	limits: IParadisInlineMediaLimits = PARADIS_INLINE_MEDIA_LIMITS,
): Promise<IParadisInlineMediaResult> {
	// TrustedHTML はそのまま渡す（文字列化すると Trusted Types に弾かれる）。
	// 型定義は string しか受け付けないので、その1点だけキャストする。
	const doc = new DOMParser().parseFromString(rendered as string, 'text/html');
	const elements = collectMediaElements(doc.body);

	// 先に「どの要素がどのファイルを指すか」を出し切ってから、まとめて読む。
	// 1枚ずつ順番に読むと、SSH 越しでは画像の枚数だけ往復が積み上がり、そのぶん最初の描画が
	// 遅れる（ローカルでは誤差だが、遠いほど効く）。
	const wanted: { readonly element: Element; readonly src: string; readonly target: URI }[] = [];
	for (const element of elements) {
		const src = element.getAttribute('src');
		if (!src || isAlreadyLoadable(src)) {
			continue;
		}
		const target = resolveParadisMediaUri(src, documentUri, workspaceFolder);
		if (target) {
			wanted.push({ element, src, target });
		}
	}

	// 同じ画像を何度も貼っている文書でも、読み込みと base64 化は1回で済ませる。
	const cache = await readMediaInParallel(wanted.map(item => item.target), fileService, limits, token);

	let inlined = 0;
	let skipped = 0;
	let totalBytes = 0;

	for (const { element, src, target } of wanted) {
		if (token.isCancellationRequested) {
			break;
		}
		let resolved = cache.get(target.toString());
		if (resolved === undefined) {
			// 予算切れで読まなかった、またはキャンセルされた。どちらも埋め込まない扱いにする。
			resolved = 'too-large';
		}

		// 予算は「読んだ量」ではなく「埋め込んだ量」で数える。同じ画像を何度も貼っている文書では
		// 読み込みは1回で済むが、webview へ送る HTML は貼った回数ぶん膨らむため。
		if (resolved !== 'missing' && resolved !== 'too-large') {
			if (totalBytes + resolved.length > limits.maxBytesTotal) {
				resolved = 'too-large';
			} else {
				totalBytes += resolved.length;
			}
		}

		if (resolved === 'missing' || resolved === 'too-large') {
			skipped++;
			// `source` は単体で意味を持たないので、断り書きに置き換えず取り除くだけにする。
			if (element.tagName === 'IMG') {
				element.replaceWith(createUnavailableNode(doc, src, resolved));
			} else {
				element.remove();
			}
			continue;
		}

		element.setAttribute('src', resolved);
		inlined++;
	}

	return { html: doc.body.innerHTML, inlined, skipped };
}

/** 一度に走らせる読み込みの数。遠いファイルシステムで往復を重ねないための並列度。 */
const PARADIS_INLINE_MEDIA_CONCURRENCY = 8;

/**
 * 重複を除いた対象をまとめて読み、URI 文字列で引ける表にして返す。
 *
 * 並列度を上げると往復は隠れるが、無制限に投げるとリモートのファイルシステムを詰まらせるので
 * 上限を設ける。読み込み自体は失敗しても投げない（結果に理由が入る）。
 */
async function readMediaInParallel(
	targets: readonly URI[],
	fileService: IFileService,
	limits: IParadisInlineMediaLimits,
	token: CancellationToken,
): Promise<Map<string, string | ParadisMediaFailure>> {
	const unique = [...new Set(targets.map(target => target.toString()))];
	const results = new Map<string, string | ParadisMediaFailure>();
	let next = 0;
	// 読んだ量。**予算を超えたら読むのをやめる。** 並列にしたぶん、止めないと予算外の画像まで
	// 全部メモリに載せてしまう（1枚の上限が 8MiB なので、枚数次第で数百MBになる）。
	let readBytes = 0;

	const worker = async () => {
		while (next < unique.length && !token.isCancellationRequested && readBytes < limits.maxBytesTotal) {
			const key = unique[next++];
			const resolved = await readAsDataUri(URI.parse(key), fileService, limits);
			if (resolved !== 'missing' && resolved !== 'too-large') {
				readBytes += resolved.length;
			}
			results.set(key, resolved);
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(PARADIS_INLINE_MEDIA_CONCURRENCY, unique.length) }, () => worker()));
	return results;
}

/** 1ファイルを読んで data: URI にする。読めない・大きすぎるときは理由を返す。 */
async function readAsDataUri(
	target: URI,
	fileService: IFileService,
	limits: IParadisInlineMediaLimits,
): Promise<string | ParadisMediaFailure> {
	try {
		// 読む前に大きさを見て、巨大なファイルをメモリに載せること自体を避ける。
		const stat = await fileService.stat(target);
		if (typeof stat.size === 'number' && stat.size > limits.maxBytesPerFile) {
			return 'too-large';
		}
		const content = await fileService.readFile(target);
		if (content.value.byteLength > limits.maxBytesPerFile) {
			return 'too-large';
		}
		const encoded = encodeBase64(content.value);
		const mime = getMediaMime(target.path) ?? 'application/octet-stream';
		return `data:${mime};base64,${encoded}`;
	} catch {
		// 消えている・権限が無い・そもそもファイルではない。どれも利用者から見れば「出ない」なので同じ扱い。
		return 'missing';
	}
}
