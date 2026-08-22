/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続先（そのリソースが実在するマシン）へ渡す「パス文字列」の綴り方を1箇所に集めたファイル。
//
// 規則はただ1つ: `scheme === file ? uri.fsPath : uri.path`。
// `uri.fsPath` は**このウィンドウが動いている OS** を見て区切りを付け替えるので、Windows から
// Linux の接続先へ繋いでいると `/home/u/proj` が `\home\u\proj` に化け、接続先の git もシェルも
// そのパスを受け取れない。この規則が各所に手書きで複製され、新しい呼び出し元がそれを通らな
// かったことが、実際に2件のバグ（コマンドプリセットの cd、PARACODE_PROJECT_ROOT_PATH）の
// 原因になった。
//
// チャネル越しにパスを渡す箇所は必ずここの関数を通すこと。戻り値の {@link ParadisHostPath} には
// 素の `string`（= `uri.fsPath` の戻り値）を代入できないので、規則を迂回するとコンパイルが通らない。
//
// ## 型で守れない口（把握した上で残しているもの）
//
// 型はあくまで「電文を組み立てる側」を守る仕組みで、次の2つは型では塞げない。ここを通す新しい
// コードを書くときは、目視で `paradisHostPathFor` / `paradisResolveHostPath` 由来かを確認すること。
//
// - `IChannel.call(command, arg?: any)`: 引数が `any` なので、リクエスト型に注釈を付けずに
//   オブジェクトリテラルを直書きすると素の string が素通りする。**チャネルへ渡すリクエストには
//   必ず型注釈を付ける**こと（`const req: IParadisAddWorktreeRequest = { ... }` の形）。
// - `ProxyChannel.toService<T>()`: 呼ぶ側が `T` を自分で指定するので、素の string を受ける形の
//   インターフェースを渡せば検査をすり抜けられる。共有の service 型（`IParadisSpaceDiskService`
//   等）を使い、その場限りの型を書かないこと。
//
// ## ここに集約してはいけないもの
//
// `terminalPresets/browser/paradisPresetService.ts` の `_pathForShell` は**集約対象外**。あれは
// 「そのリソースがどのマシンにあるか」ではなく「そのシェルがどの OS か」（`instance.os`）を見て
// おり、別の問いを解いている。見た目が似ているからといって、後からここへ統合しないこと。

import { Schemas } from '../../base/common/network.js';
import { URI } from '../../base/common/uri.js';

declare const paradisHostPathBrand: unique symbol;

/**
 * 接続先へ渡してよいパス文字列。
 *
 * 実体はただの `string` なので、受け取った側は普通の文字列として扱える。一方で `string` から
 * この型への代入はできないため、`uri.fsPath` を直接渡そうとすると型エラーになる。
 * この型の値を作れるのは {@link paradisHostPathFor} と {@link paradisResolveHostPath} だけ。
 */
export type ParadisHostPath = string & { readonly [paradisHostPathBrand]: true };

/** パス文字列を渡す先のマシン。 */
export type ParadisHostKind = 'local' | 'remote';

/**
 * 接続先の識別に要る情報だけを取り出したもの。`IRemoteAgentConnection` をそのまま渡せる。
 *
 * `remoteAuthority` の**大文字小文字は揃えなくてよい**。{@link paradisResolveHostPath} が比較時に
 * 両辺を小さくするので、呼び出し側で `toLowerCase()` を掛ける必要はない（掛けても無害）。
 */
export interface IParadisHostConnection {
	readonly remoteAuthority: string;
}

/** {@link paradisResolveHostPath} の結果。どのマシンへ渡すパスなのかと、その綴り。 */
export interface IParadisResolvedHostPath {
	readonly host: ParadisHostKind;
	readonly path: ParadisHostPath;
}

/**
 * 綴りの規則そのもの。**この fork で `uri.fsPath` と `uri.path` を選び分けてよいのはここだけ**。
 *
 * `host` は「どのマシンへ渡すか」であって URI の scheme ではない。解決できない URI を承知の上で
 * 手元へ流す縮退運用（読み取り専用の呼び出し）でも、手元へ渡す以上は `'local'` の綴りになる。
 *
 * 行き先が URI 自体から決まる場合は、この関数ではなく {@link paradisResolveHostPath} を使うこと。
 */
export function paradisHostPathFor(resource: URI, host: ParadisHostKind): ParadisHostPath {
	return (host === 'remote' ? resource.path : resource.fsPath) as ParadisHostPath;
}

/**
 * URI から「そのリソースがあるマシン」を決め、そのマシンへ渡すパス文字列を作る。
 *
 * どのマシンのものとも確証が持てないもの — 別ホストの `vscode-remote:`、未接続なのに
 * `vscode-remote:`、`file:`/`vscode-remote:` 以外のスキーム（`vscode-vfs:`・`untitled:` 等）— は
 * `undefined` を返す。手元へ倒さないのは、絶対パスが一致する構成（mac→mac の SSH、同名ユーザーの
 * Linux→Linux 等）で無関係な手元のリソースを読み書きしてしまうため。
 */
export function paradisResolveHostPath(resource: URI, connection: IParadisHostConnection | undefined): IParadisResolvedHostPath | undefined {
	if (resource.scheme === Schemas.file) {
		return { host: 'local', path: paradisHostPathFor(resource, 'local') };
	}
	if (connection !== undefined
		&& resource.scheme === Schemas.vscodeRemote
		&& resource.authority.toLowerCase() === connection.remoteAuthority.toLowerCase()) {
		return { host: 'remote', path: paradisHostPathFor(resource, 'remote') };
	}
	return undefined;
}

/** `ssh-remote+<host>` から ssh のホスト名を取り出す。他の種類の authority は扱わない。 */
export function paradisSshHostFromAuthority(remoteAuthority: string | undefined): string | undefined {
	if (!remoteAuthority) {
		return undefined;
	}
	const separator = remoteAuthority.indexOf('+');
	if (separator < 0) {
		return undefined;
	}
	const kind = remoteAuthority.slice(0, separator);
	const host = remoteAuthority.slice(separator + 1);
	if (kind !== 'ssh-remote' || host.length === 0) {
		return undefined;
	}
	// ssh の引数に渡すので、ホスト名として妥当な文字だけを通す（オプション注入を防ぐ）
	if (host.startsWith('-') || !/^[A-Za-z0-9._@%:\-[\]]+$/.test(host)) {
		return undefined;
	}
	return host;
}
