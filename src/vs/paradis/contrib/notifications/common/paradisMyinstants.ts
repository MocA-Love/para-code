/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Myinstants の mp3 を通知音に取り込むときの判定（renderer のダイアログと shared process の取得の両方が使う）。
// Myinstants の規約は自動の検索・リクエストを禁じているため、アプリは検索も一覧化もしない。利用者が自分で
// 選んだ 1 件の mp3 の直リンクだけを、利用者の操作 1 回につき 1 回取りに行く。

/** 取得を許すホスト。ここに無いホストは、貼られた URL でもリダイレクト先でも取りに行かない。 */
const PARADIS_MYINSTANTS_HOSTS: ReadonlySet<string> = new Set(['www.myinstants.com', 'myinstants.com']);

/** 利用者に案内するサイトの入口（ダイアログの「Myinstants を開く」）。 */
export const PARADIS_MYINSTANTS_HOME_URL = 'https://www.myinstants.com/';

/** mp3 の直リンクの形（`/media/sounds/<名前>.mp3`）。名前にはスラッシュを含めない。 */
const MP3_PATH = /^\/media\/sounds\/(?<name>[^/\\]+)\.mp3$/i;

/** 音のページの形（`/instant/<slug>/`。`/ja/instant/...` のような言語つきも含む）。 */
const INSTANT_PAGE_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?instant\/[^/]+\/?$/i;

export type ParadisMyinstantsUrlCheck =
	/** 取得してよい mp3 の直リンク。`url` は正規化したもの、`fileName` はデコードした拡張子つきの名前。 */
	| { readonly kind: 'mp3'; readonly url: string; readonly fileName: string }
	/** 音のページ。mp3 のリンクをコピーし直すよう案内する。 */
	| { readonly kind: 'page' }
	| { readonly kind: 'empty' }
	| { readonly kind: 'invalid' };

/**
 * 貼られた文字列が、取得してよい Myinstants の mp3 の直リンクかを判定する。https、ホストは
 * www.myinstants.com と myinstants.com、パスは `/media/sounds/` 直下の `.mp3` に限り、クエリ・
 * フラグメント・認証情報・既定以外のポートを含むものは拒む。リダイレクト先の確認にも同じ判定を使う。
 */
export function paradisCheckMyinstantsUrl(input: string): ParadisMyinstantsUrlCheck {
	const trimmed = input.trim();
	if (!trimmed) {
		return { kind: 'empty' };
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { kind: 'invalid' };
	}
	if (!PARADIS_MYINSTANTS_HOSTS.has(parsed.hostname.toLowerCase())) {
		return { kind: 'invalid' };
	}
	if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && INSTANT_PAGE_PATH.test(parsed.pathname)) {
		return { kind: 'page' };
	}
	if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
		return { kind: 'invalid' };
	}
	// `?` や `#` だけが付いた URL は search / hash が空になるため、元の文字列でも確かめる。
	if (/[?#]/.test(trimmed)) {
		return { kind: 'invalid' };
	}
	const match = MP3_PATH.exec(parsed.pathname);
	const encodedName = match?.groups?.name;
	if (!encodedName) {
		return { kind: 'invalid' };
	}
	let name: string;
	try {
		name = decodeURIComponent(encodedName);
	} catch {
		return { kind: 'invalid' };
	}
	// デコードして初めて現れる区切り・制御文字・相対指定は受け付けない。
	if (!name.trim() || name === '.' || name === '..' || hasSeparatorOrControl(name)) {
		return { kind: 'invalid' };
	}
	return { kind: 'mp3', url: parsed.toString(), fileName: `${name}.mp3` };
}

function hasSeparatorOrControl(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f || code === 0x2f /* / */ || code === 0x5c /* \ */) {
			return true;
		}
	}
	return false;
}

/** mp3 として受け付ける Content-Type（パラメータは無視する）。 */
const MP3_CONTENT_TYPES: ReadonlySet<string> = new Set(['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg', 'audio/x-mp3', 'audio/x-mpeg-3']);

export function paradisIsMp3ContentType(contentType: string | null | undefined): boolean {
	if (!contentType) {
		return false;
	}
	return MP3_CONTENT_TYPES.has(contentType.split(';')[0].trim().toLowerCase());
}

/**
 * 先頭のバイト列が mp3 に見えるか。ID3v2 タグ（`ID3` + 版 2〜4）か、MPEG Audio Layer III のフレームヘッダー
 * （同期 11 ビット、予約値でない版・ビットレート・サンプリング周波数）で始まるものだけを mp3 とみなす。
 */
export function paradisLooksLikeMp3(bytes: Uint8Array): boolean {
	if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
		const major = bytes[3];
		return major >= 2 && major <= 4 && bytes[4] !== 0xff;
	}
	if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) {
		return false;
	}
	const version = (bytes[1] >> 3) & 0x03;
	const layer = (bytes[1] >> 1) & 0x03;
	const bitrateIndex = (bytes[2] >> 4) & 0x0f;
	const sampleRateIndex = (bytes[2] >> 2) & 0x03;
	return version !== 0x01 && layer === 0x01 && bitrateIndex !== 0x0f && sampleRateIndex !== 0x03;
}

/**
 * mp3 のファイル名から表示名の初期値を作る。Myinstants はファイル名の末尾に `_` + 英数字 7 文字のランダムな
 * 接尾辞を付けるので取り除き、`_` `-` を空白にする（例: `fahhh_KcgAXfs.mp3` → `Fahhh`）。
 */
export function paradisMyinstantsDisplayName(fileName: string): string {
	const stem = fileName.replace(/\.mp3$/i, '');
	const readable = stem.replace(/_[A-Za-z0-9]{7}$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	const name = (readable || stem.trim()).slice(0, 80);
	return name.replace(/^[a-z]/, c => c.toUpperCase());
}

/** {@link IParadisMyinstantsDownloadResult} の失敗の理由。renderer が文言に変える。 */
export type ParadisMyinstantsDownloadFailure =
	/** 判定で mp3 の直リンクではなかった。 */
	| 'invalidUrl'
	/** 音のページが渡された。 */
	| 'pageUrl'
	/** リダイレクト先が許す形でなかった、または回数が多すぎた。 */
	| 'redirect'
	/** 404 / 410。音が削除された可能性がある。 */
	| 'notFound'
	/** 403。Myinstants（Cloudflare）が取得を止めた。 */
	| 'blocked'
	/** そのほかの HTTP エラー。 */
	| 'http'
	/** Content-Type か先頭のバイト列が mp3 でなかった。 */
	| 'notMp3'
	| 'tooLarge'
	| 'timeout'
	| 'network';

export type IParadisMyinstantsDownloadResult =
	| {
		readonly ok: true;
		/** readTempAudioFile / cleanupTempAudio / importMyinstantsAudio に渡す一時 ID。 */
		readonly tempId: string;
		/** 最終的に取得した mp3 の URL（出典として保存する）。 */
		readonly sourceUrl: string;
		readonly fileName: string;
		readonly sizeBytes: number;
		readonly suggestedName: string;
	}
	| {
		readonly ok: false;
		readonly reason: ParadisMyinstantsDownloadFailure;
		readonly status?: number;
	};
