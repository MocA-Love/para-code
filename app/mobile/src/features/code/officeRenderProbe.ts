// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** 描いている途中の Office 文書を「空」と決めるまで待ち足す上限（ms。2 秒の後に足す分）。 */
const OFFICE_RENDER_MAX_WAIT_MS = 60_000;

/**
 * 描いている途中の印があっても、`#content` が最初に変わった後に、この間（ms）変わらなければ描画が止まったとみなす。
 * 最初の変化までは止まったと数えない（展開・解析・画像の変換の間は DOM が変わらないまま忙しいため）。
 */
const OFFICE_RENDER_STALL_MS = 5_000;

/** 待ち足しの tick の間隔（ms）。 */
const OFFICE_RENDER_TICK_MS = 1_000;

/**
 * tick が予定よりこれ以上（ms）遅れたら、ページの同期の処理でタイマーが止まっていたとみなす。前の tick から
 * 2 秒以上空いたときに当たる。その間に DOM が変わらなかったのは止まったからではないので、変化の時刻を今にする。
 */
const OFFICE_RENDER_TIMER_LAG_MS = 1_000;

/**
 * Office の WebView に差し込む、描画が済んだか（期待する要素があるか）をアプリ側の復旧の判定（`completeRender`）へ知らせるスクリプト。
 * 2 秒で決めるが、文書が描いている途中（印 `__paradisOfficeBusy`）なら上限まで待ち足す。ただし `#content` が
 * 変わり始めてから {@link OFFICE_RENDER_STALL_MS} の間変わらなければ、止まったとみなして待ち足さない。
 */
export function buildOfficeRenderProbe(generation: number, expectedSelector: string): string {
	const selector = JSON.stringify(expectedSelector);
	return `(function () {
		var sent = false;
		var finish = function (present) {
			if (sent) { return; }
			sent = true;
			observer.disconnect();
			window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'paradisOfficeRecovery', generation: ${generation}, hasExpectedRoot: present }));
		};
		var check = function () { if (document.querySelector(${selector})) { finish(true); } };
		// #content が最後に変わった時刻。最初に変わるまでは null（止まったと数えない）
		var lastChange = null;
		var observer = new MutationObserver(function (records) {
			var content = document.getElementById('content');
			if (content) {
				for (var i = 0; i < records.length; i++) {
					if (content.contains(records[i].target)) { lastChange = Date.now(); break; }
				}
			}
			check();
		});
		observer.observe(document.documentElement, { childList: true, subtree: true });
		check();
		var waited = 0;
		var dueAt = Date.now() + 2000;
		var schedule = function (delay) { dueAt = Date.now() + delay; setTimeout(decide, delay); };
		var decide = function () {
			var now = Date.now();
			if (lastChange !== null && now - dueAt >= ${OFFICE_RENDER_TIMER_LAG_MS}) { lastChange = now; }
			if (!sent && window.__paradisOfficeBusy === true && waited < ${OFFICE_RENDER_MAX_WAIT_MS} && (lastChange === null || now - lastChange < ${OFFICE_RENDER_STALL_MS})) {
				waited += ${OFFICE_RENDER_TICK_MS};
				schedule(${OFFICE_RENDER_TICK_MS});
				return;
			}
			finish(!!document.querySelector(${selector}));
		};
		schedule(2000);
		true;
	})();`;
}
