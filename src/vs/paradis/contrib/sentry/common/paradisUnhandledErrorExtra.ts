/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ListenerLeakError } from '../../../../base/common/event.js';

// onUnexpectedError で拾った例外は、送る直前にメッセージも中身も捨てられる（名前とスタックだけが残る）。
// ListenerLeakError の原因の見当がつくよう、例外が持っている固定の値だけを `safe_` の欄に移す:
// リスナーの数・種類・Emitter の名前（名前は upstream のコードが付ける定数）。
// Node のエラーコードは、どの報告にも付く `paradisSafeErrorExtra` の `safe_errno` が拾う。

/** `[<emitter>] potential listener LEAK detected, <kind>` の <emitter>。 */
const leakEmitterName = /^\[(?<name>[A-Za-z][\w.-]{0,63})\] potential listener LEAK detected/;

/** 予期しない例外から Sentry に送ってよい値を取り出す。何も無ければ undefined。getter が投げても落ちない。 */
export function paradisUnhandledErrorSafeExtra(error: unknown): Record<string, string | number> | undefined {
	try {
		if (!ListenerLeakError.is(error)) {
			return undefined;
		}
		const extra: Record<string, string | number> = {};
		if (Number.isSafeInteger(error.listenerCount)) {
			extra.safe_listener_count = error.listenerCount;
		}
		if (error.kind === 'dominated' || error.kind === 'popular') {
			extra.safe_leak_kind = error.kind;
		}
		const emitter = leakEmitterName.exec(error.message)?.groups?.name;
		if (emitter !== undefined) {
			extra.safe_emitter_name = emitter;
		}
		return Object.keys(extra).length > 0 ? extra : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 拡張ホストから届いた例外か。拡張ホストの例外は `MainThreadErrors.$onUnexpectedError` から同期で
 * `onUnexpectedError` に入るので、ハンドラの中で取った呼び出し元のスタックにその名前が出る（RPC の
 * 名前なので圧縮されても変わらない）。upstream のファイルは触らずに済む。
 */
export function paradisIsExtensionHostRelay(callerStack: string | undefined): boolean {
	return callerStack !== undefined && /\$onUnexpectedError\b/.test(callerStack);
}

/**
 * インストールした拡張のフォルダー名（`<publisher>.<name>-<version>`、プラットフォーム別の版は末尾に
 * `-<target>`）。VS Code が付ける名前なので、識別子と版の形をしていないものは拾わない。
 */
const installedExtensionFolder = /^(?<id>[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,127})-\d+\.\d+\.\d+(?:-[a-z0-9.-]{1,64})?$/i;

/** 製品に同梱した拡張のフォルダー名（`resources/app/extensions/<name>`）。 */
const builtinExtensionFolder = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/**
 * スタックの中の `.../<親の親>/<親>/extensions/<フォルダー>/` の部分。区切りは `/` と `\`。`extensions` の直前も区切りに限る
 * （`file:///c%3A/...` の形も `/` で分かれる）。
 */
const extensionFolderInStack = /(?:(?<grandparent>[^\\/\s()]+)[\\/]+(?<parent>[^\\/\s()]+)[\\/]+)?(?<=[\\/])extensions[\\/]+(?<folder>[^\\/\s()]+)[\\/]/gi;

/** 照合する 1 行の長さの上限。`/` を含まない長い 1 語で正規表現の手間が長さの 2 乗に増えないようにする（paradisSentryDiagnostics.ts と同じ値）。 */
const MAX_STACK_LINE_LENGTH = 1_000;

/** スタックの文字列を読む。getter が投げても落ちない。 */
export function paradisErrorStack(error: unknown): string | undefined {
	try {
		const stack = typeof error === 'object' && error !== null ? (error as { stack?: unknown }).stack : undefined;
		return typeof stack === 'string' ? stack : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 拡張ホストから届いた例外のスタックから、例外を出した拡張の識別子を取り出す。いちばん上の拡張のフレームを使う。
 *
 * 拡張ホストが送るスタックには拡張のファイルの絶対パス（`/Users/<名前>/.para-code/extensions/<id>-<版>/...`）が
 * 入っているが、返すのはフォルダー名から取った公開の識別子（`github.vscode-pull-request-github`）だけで、
 * パスの他の部分は一切返さない。同梱の拡張は `builtin:<フォルダー名>`。拡張の開発中のフォルダーなど、
 * 決まった形をしていない場所のファイルからは何も返さない（そのフォルダー名は利用者のものなので送らない）。
 */
export function paradisExtensionIdFromStack(stack: string | undefined): string | undefined {
	if (stack === undefined) {
		return undefined;
	}
	// フレームの行（`    at ...`）だけを読む。例外の文に書かれたパスで別の拡張にしないため。
	// 先頭だけ読む（拡張ホストは 100 フレームまで送る。正規表現の手間を長さに比例させるため）
	const frames = stack.slice(0, 20_000).split('\n').filter(line => /^\s*at\s/.test(line)).map(line => line.slice(0, MAX_STACK_LINE_LENGTH)).join('\n');
	for (const match of frames.matchAll(extensionFolderInStack)) {
		const { grandparent, parent, folder } = match.groups ?? {};
		if (folder === undefined) {
			continue;
		}
		const installed = installedExtensionFolder.exec(folder)?.groups?.id;
		if (installed !== undefined) {
			return installed.toLowerCase();
		}
		// 同梱の拡張は `<製品>/resources/app/extensions/<name>/`（macOS は `Resources/app`）に限る
		if (grandparent !== undefined && /^resources$/i.test(grandparent) && parent === 'app' && builtinExtensionFolder.test(folder)) {
			return `builtin:${folder.toLowerCase()}`;
		}
	}
	return undefined;
}
