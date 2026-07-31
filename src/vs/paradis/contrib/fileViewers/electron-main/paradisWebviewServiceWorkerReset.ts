/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 前回までの起動が残した webview の service worker 登録を、最初のウィンドウを開く前に落とす。
//
// 何を直しているのか:
// fork独自ビューアが `createWebviewOverlay` に origin を渡していなかった時期、webview を開くたびに
// 新しい origin ＝ 新しい service worker の登録スコープが1つ増え、二度と消えなかった
// （実機のプロファイルで382件）。`paradisWebviewOriginPool` を入れて増加は止めたが、**既に溜まった
// 登録を消す経路が無い**。登録が溜まった状態では新しい origin の worker が activate まで到達できず、
// `navigator.serviceWorker.controller` が付かないため、webview/pre/index.html は中身の iframe を
// 作らないまま待ち続ける（例外もコンソールエラーも出ない＝真っ白）。実機で382件を消したところ、
// 同じプロファイル・同じビルドで即座にレンダリングが復帰することを確認している。
//
// なぜ新しい `clearData` ではなく `clearStorageData` なのか（Electron 42.6.0 で実測、思い込み厳禁）:
// `vscode-webview` は `registerSchemesAsPrivileged` で登録したカスタムスキームで、**origin を解決する
// 経路の削除APIはこれを消せない**。実機と同じ条件（同じ Electron、同じスキーム特権、
// `--service-worker-schemes=vscode-webview`）を再現して8件登録し、各手段の結果を確かめた:
//
//   clearData({ dataTypes: ['serviceWorkers'] })  → 42ms で成功を返すが 8件そのまま残る
//   clearData()（引数なし・全データ型）           → 成功を返すが 8件そのまま残る（再起動後も）
//   clearStorageData({ storages: ['serviceworkers'] }) → 8件すべて消え、再起動後も復活しない
//
// CDP の `Storage.clearDataForOrigin` も同様に、383件へ実行して全件成功を返しながら1件も減らなかった。
// **成功の戻り値を削除の証拠として扱わないこと**。消えたかどうかは必ず登録数で確かめる。
//
// なぜ origin を絞らないのか:
// 溜まった origin は使い捨てで生成されたもので、**どこにも記録が残っておらず列挙できない**
// （`session.serviceWorkers` は実行中のものしか返さない）。絞らずに消しても巻き添えは出ない:
// このセッションで service worker を登録できるスキームは `--service-worker-schemes=vscode-webview`
// の1つだけで、内蔵ブラウザは `session.fromPartition('persist:vscode-browser')` と別パーティション。
// 実測でも default session の登録は382件すべてが `vscode-webview://` だった。`storages` を
// service worker だけに絞っているので、同じ origin の localStorage 等は残る（これも実測で確認）。
//
// なぜ「起動ごとに1回」で、しかも最初のウィンドウより前なのか:
// 消してよいのは「まだ誰も使っていない登録」だけ。ウィンドウが開いたあとに消すと、復元された
// タブが登録したばかりの worker を巻き込み、直そうとしている白紙を自分で作ってしまう。
// 起動直後なら生きている webview は1つも無い。webview 側は次に開かれたときに登録し直すので、
// 失うのは配信キャッシュだけで機能的な影響は無い。

import { raceTimeout } from '../../../../base/common/async.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * 掃除に許す時間。起動シーケンスを止めて待つ以上、無制限には待てない。溜まった登録が
 * 消えないままでも起動は続行する（白紙になるだけで、起動できないよりはるかにましなため）。
 */
const PARADIS_SERVICE_WORKER_RESET_TIMEOUT_MS = 5000;

/**
 * webview の service worker 登録をすべて捨てる。最初のウィンドウを開く前に一度だけ呼ぶこと。
 *
 * 掃除が失敗しても投げない: ここで起動を止める価値は無く、最悪でも「これまでどおり」に戻るだけ。
 *
 * @param targetSession ワークベンチのウィンドウが使うセッション（`session.defaultSession`）
 */
export async function paradisResetWebviewServiceWorkers(targetSession: Electron.Session, logService: ILogService): Promise<void> {
	try {
		// `clearStorageData` は `Promise<void>` なので、そのまま渡すと解決値もタイムアウトも
		// `undefined` になって区別できない。完了を真値に写してから渡す。
		const cleared = await raceTimeout(
			targetSession.clearStorageData({ storages: ['serviceworkers'] }).then(() => true),
			PARADIS_SERVICE_WORKER_RESET_TIMEOUT_MS,
			() => logService.warn(`[ParadisWebviewServiceWorkerReset] clearing webview service worker registrations did not finish within ${PARADIS_SERVICE_WORKER_RESET_TIMEOUT_MS}ms, continuing startup`)
		);
		if (cleared) {
			logService.trace('[ParadisWebviewServiceWorkerReset] cleared the webview service worker registrations left over from previous runs');
		}
	} catch (error) {
		logService.warn(`[ParadisWebviewServiceWorkerReset] could not clear the webview service worker registrations: ${error}`);
	}
}
