/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ビューアが読むファイルを配るローカルサーバの、renderer / shared process / リモートサーバで
// 共有する定義。

/** workbench(renderer) ⇔ shared process / リモートサーバ のチャネル名。 */
export const PARADIS_HTML_PREVIEW_CHANNEL = 'paradisHtmlPreview';

/**
 * 載せたフォルダーの居場所。
 *
 * **URL ではなく port と token を返す。** リモートに載せた場合、webview から見える host は
 * リモートの port ではなく手元へ転送したポートになるため、URL の組み立ては呼び出し側でしか
 * 決められない。
 */
export interface IParadisPreviewMount {
	readonly port: number;
	readonly token: string;
	/**
	 * ファイルを1つだけ載せたとき、サーバがそのファイルを返す名前。シンボリックリンクを渡すと
	 * サーバはリンク先の実体を載せるので、リンク自身の名前ではなくこの名前で URL を作る。
	 */
	readonly file?: string;
}

export interface IParadisPreviewMountOptions {
	/**
	 * 古いものから外す対象にしない。ペインが一度だけ決めて覚え続ける URL（ビューアの同梱ライブラリ）に
	 * 使う。外すとそのペインの次の文書が白紙になり、開き直しても直らない。
	 */
	readonly pinned?: boolean;
}

export interface IParadisHtmlPreviewService {
	/**
	 * フォルダーをサーバに載せ、その居場所を返す。同じフォルダーを何度渡しても同じ token を返す。
	 */
	mount(directory: string, options?: IParadisPreviewMountOptions): Promise<IParadisPreviewMount>;
}

/**
 * 配信 URL を組み立てる。末尾は必ず `/`。
 *
 * @param segments 載せたフォルダーからの相対セグメント（無ければフォルダー直下を指す）
 */
export function paradisPreviewUrl(mount: IParadisPreviewMount, port: number, segments: readonly string[] = []): string {
	const suffix = segments.length > 0 ? `${segments.map(encodeURIComponent).join('/')}/` : '';
	return `http://127.0.0.1:${port}/${mount.token}/${suffix}`;
}
