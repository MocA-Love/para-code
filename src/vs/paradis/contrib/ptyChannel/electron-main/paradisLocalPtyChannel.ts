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
// 成立条件は4つで、いずれも upstream 側にある（1.130 / 1.132 / main で同一なのを確認済み）:
//  1. `PtyHostService` が pty host の `onProcessData` を購読し、main 側の Emitter へ再発火する
//     (`platform/terminal/node/ptyHostService.ts`)。データ経路が MessagePort 直結へ移った後も
//     この購読だけが残っている
//  2. `ProxyChannel.fromService` は **サービスの全イベントを無条件に `Event.buffer()` で包む**
//     (`base/parts/ipc/common/ipc.ts`)。`LocalPty` チャネルの登録時に onProcessData も対象になる
//  3. `Event.buffer` は最初のリスナーが付くまで溜め、上限が無い（警告は `VSCODE_DEV` 限定）
//  4. **その最初のリスナーが永久に来ない**。renderer は per-process のイベントを
//     MessagePort 直結の proxy から購読しており（`localTerminalBackend.ts`）、
//     `LocalPty` 経由では pty host のライフサイクル系しか購読しない
//     （`baseTerminalBackend.ts` が購読するのは onPtyHost* の5つだけ）
//
// つまり main は使いもしないデータを受け取り、一切捨てずに積み上げていた。
//
// 直し方: 列挙から外して「先回りのバッファ」を作らせない。`fromService` は
// `for (const key in handler)` で列挙したイベントだけを先に包むので、非列挙にすれば対象から外れる。
// **イベントを消すわけではない**。誰かが `listen('onProcessData')` を呼んだ場合は
// `fromService` の遅延経路が同じ `Event.buffer` をその場で作るので、機能は今までどおり動く
// （その時点で購読者が居るため、溜まらずに素通りする）。
//
// **この関数はサービスインスタンスのプロパティ記述子を書き換える**（`enumerable` だけ）。
// `Object.create` のシムに逃がす手も考えたが、`fromService` の `call()` が
// `target.apply(handler, args)` で `this` をシムにしてしまい、`_lastPtyId` のような内部状態が
// シム側へ書き込まれて実体と分裂する。DI シングルトン自体を直すほうが安全。
//
// **直るのは「保持」だけで「転送」は残る**。`ptyHostService.ts` の購読は残るので、pty host は
// 今後も全出力を main へ送り続け、main は毎回デシリアライズして即捨てる（CPU/GC は変わらない）。
// その購読を消すと、今度は pty host 側チャネルのバッファに最初の購読者が居なくなり、
// 同じリークが pty host プロセスへ引っ越すだけなので、単独では触らないこと。

import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILocalPtyService } from '../../../../platform/terminal/common/terminal.js';

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
 * 想定の own property が見つからない場合は**何もしない**。機能は壊れないが、
 * **戻る先は「20時間で600MB 溜まる」状態**なので安全ではない。だから握り潰さず
 * `error` で残す。ここがログに出たら upstream の形が変わった合図なので、必ず追随すること。
 */
export function paradisCreateLocalPtyChannel(
	service: ILocalPtyService,
	disposables: DisposableStore,
	logService: ILogService,
): IServerChannel<string> {
	for (const name of PARADIS_DIRECT_PTY_EVENTS) {
		const descriptor = Object.getOwnPropertyDescriptor(service, name);
		if (!descriptor) {
			logService.error(`[ParadisLocalPtyChannel] ${name} is not an own property; terminal output will accumulate in the main process again`);
			continue;
		}
		if (!descriptor.enumerable) {
			continue;
		}
		if (!descriptor.configurable) {
			logService.error(`[ParadisLocalPtyChannel] ${name} is not configurable; terminal output will accumulate in the main process again`);
			continue;
		}
		Object.defineProperty(service, name, { ...descriptor, enumerable: false });
	}

	// 「増えた側」の検知。まだ列挙に残っているイベントが、バッファしてよいと分かっている
	// ものだけかを確かめる。upstream が高頻度イベントを追加した場合はここで気づける。
	const stillBuffered: string[] = [];
	for (const key in service as object) {
		if (isEventName(key) && !(PARADIS_BUFFERED_PTY_EVENTS as readonly string[]).includes(key)) {
			stillBuffered.push(key);
		}
	}
	if (stillBuffered.length > 0) {
		logService.error(`[ParadisLocalPtyChannel] unexpected eagerly buffered pty events: ${stillBuffered.join(', ')}`);
	}

	return ProxyChannel.fromService<string>(service, disposables);
}
