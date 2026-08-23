/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main プロセスが「誰も読まないターミナル出力」を溜め続けるのを止める。
//
// 何が起きていたか（実機の main プロセスのヒープスナップショットで確認、2026-08-08）:
// 稼働19.8時間のヒープ 642MB のうち **602MB(94%) が単一の未消費イベントバッファ**だった。
// 中身は `{ id, event }` が 253,359 件で、`event` はターミナルの生出力そのもの。
//
// 成立条件は4つで、いずれも upstream 側にある:
//  1. `PtyHostService` が pty host の `onProcessData` を購読し、main 側の Emitter へ再発火する
//     (`platform/terminal/node/ptyHostService.ts`)。データ経路が MessagePort 直結へ移った後も
//     この購読だけが残っている
//  2. `ProxyChannel.fromService` は既定で **サービスの全イベントを `Event.buffer()` で包む**
//     (`base/parts/ipc/common/ipc.ts`)。`LocalPty` チャネルの登録時に onProcessData も対象になる
//  3. `Event.buffer` は最初のリスナーが付くまで溜め、上限が無い（警告は開発ビルド限定）
//  4. **その最初のリスナーが永久に来ない**。renderer は per-process のイベントを
//     MessagePort 直結の proxy から購読しており（`localTerminalBackend.ts`）、
//     `LocalPty` 経由では pty host のライフサイクル系しか購読しない
//     （`baseTerminalBackend.ts` が購読するのは onPtyHost* の5つだけ）
//
// つまり main は使いもしないデータを受け取り、一切捨てずに積み上げていた。
//
// 直し方: `fromService` の `unbufferedEvents` に渡す。**upstream が用意している口**で
// (`ICreateServiceChannelOptions`)、渡したイベントは先回りで包まれず、`listen` されるまで
// 元のイベントを購読すらしない。誰も聞いていない間、main 側の Emitter は購読者ゼロなので
// 発火は素通りする。
//
// **イベントを消すわけではない**。`listen('onProcessData')` を呼べば、その時点で元のイベントを
// 購読し、以後の発火は**そのまま同期で**届く（間に `Event.buffer` を挟まないので、最初の1回が
// タイマーまで遅れることも無い）。
//
// **直るのは「保持」だけで「転送」は残る**。`ptyHostService.ts` の購読は残るので、pty host は
// 今後も全出力を main へ送り続け、main は毎回デシリアライズして即捨てる（CPU/GC は変わらない）。
// その購読を消すと、今度は pty host 側チャネルのバッファに最初の購読者が居なくなり、
// 同じリークが pty host プロセスへ引っ越すだけなので、単独では触らないこと。
//
// 以前はサービスインスタンスのプロパティ記述子を書き換えて列挙から外していた（`unbufferedEvents`
// が入る前の upstream に対する回避策）。DI シングルトンを書き換えるうえ、`listen` した最初の
// 1回がタイマーまで遅れる差も残っていたので、正規の口へ寄せた。

import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILocalPtyService } from '../../../../platform/terminal/common/terminal.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

/**
 * `LocalPty` チャネルで先回りバッファを作らせないイベント。
 *
 * ここに並ぶのは **renderer が MessagePort 直結の proxy から購読しているもの** だけ
 * （`localTerminalBackend.ts` の "Attach process listeners" と1対1で対応する）。
 * つまり `LocalPty` 経由では誰も購読しないと分かっているものに限る。
 *
 * `onPtyHostExit` / `onPtyHostStart` / `onPtyHostUnresponsive` / `onPtyHostResponsive` /
 * `onPtyHostRequestResolveVariables` は **意図的に外してある**。こちらは `LocalPty` 経由で
 * `baseTerminalBackend` が購読する本来の用途で、量も接続あたり数回なので従来どおりでよい。
 *
 * upstream を取り込んで `localTerminalBackend` の購読先が変わったら、この表も合わせること。
 */
const PARADIS_DIRECT_PTY_EVENTS: readonly (keyof ILocalPtyService)[] = [
	'onProcessData',
	'onProcessReady',
	'onProcessReplay',
	'onProcessOrphanQuestion',
	'onDidRequestDetach',
	'onDidChangeProperty',
	'onProcessExit',
];

/**
 * 先回りバッファを残してよいイベント。{@link PARADIS_DIRECT_PTY_EVENTS} の補集合で、
 * `LocalPty` 経由で `baseTerminalBackend` が購読する pty host のライフサイクル系。
 *
 * これを別に持つのは、**upstream が高頻度イベントを「増やした」場合も検知するため**。
 * 除外リストの取りこぼしだけ見ていると、名前の違う同じリークが黙って戻ってくる。
 */
const PARADIS_BUFFERED_PTY_EVENTS: readonly (keyof ILocalPtyService)[] = [
	'onPtyHostExit',
	'onPtyHostStart',
	'onPtyHostUnresponsive',
	'onPtyHostResponsive',
	'onPtyHostRequestResolveVariables',
];

/** `ProxyChannel.fromService` がイベントと見なす条件（`ipc.ts` の `propertyIsEvent` と同じ判定）。 */
function isEventName(name: string): boolean {
	const third = name.charCodeAt(2);
	return name[0] === 'o' && name[1] === 'n' && third >= 65 && third <= 90;
}

/**
 * `LocalPty` チャネルを作る。`ProxyChannel.fromService` の置き換え。
 *
 * 知らないイベントが増えていたら `error` で残す。**握り潰すと、戻る先は「20時間で600MB 溜まる」
 * 状態**なので黙って通さない。ここがログに出たら upstream が高頻度イベントを追加した合図で、
 * {@link PARADIS_DIRECT_PTY_EVENTS} に足すか、バッファしてよい理由を確かめること。
 */
export function paradisCreateLocalPtyChannel(
	service: ILocalPtyService,
	disposables: DisposableStore,
	logService: ILogService,
): IServerChannel<string> {
	const known = new Set<string>([...PARADIS_DIRECT_PTY_EVENTS, ...PARADIS_BUFFERED_PTY_EVENTS]);
	const unexpected: string[] = [];
	// `fromService` が先回りで包む対象と同じ見方をする（`for...in` ＝ 列挙可能なプロパティ）。
	for (const key in service as object) {
		if (isEventName(key) && !known.has(key)) {
			unexpected.push(key);
		}
	}
	if (unexpected.length > 0) {
		logService.error(`[ParadisLocalPtyChannel] unexpected eagerly buffered pty events: ${unexpected.join(', ')}`);
		reportParadisDiagnosticError('owned', 'pty-channel', 'unexpected-eager-buffer', new Error('unexpected eagerly buffered pty events'), {
			safe_unexpected_count: unexpected.length,
		});
	}

	return ProxyChannel.fromService<string>(service, disposables, { unbufferedEvents: PARADIS_DIRECT_PTY_EVENTS });
}
