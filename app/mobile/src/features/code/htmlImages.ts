// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * HTML のプレビューで、PC が抜いた埋め込み画像を 1 枚ずつ取り寄せて戻す（fs.html-images.v1、q.html Q325 案 A）。
 * React に依存しない純粋な部品で、`htmlImages.test.ts` で固定している。
 *
 * PC は `<img src="data:...">` の中身を抜き、同じ縦横の空の SVG を仮の `src` に置き、`data-paradis-img="番号"` を付けて
 * 本文を送る。アプリは本文より先に {@link HTML_IMAGES_LOADER_SCRIPT} を入れておく。スクリプトは見えた画像から順に
 * 番号を `postMessage` で頼み、アプリは {@link HtmlImageQueue} で同時 {@link HTML_IMAGE_FETCH_CONCURRENCY} 枚まで取り寄せ、
 * 元の `data:` の文字列そのものを `injectJavaScript`（{@link buildHtmlImageDeliverScript}）で返す。
 *  - 仮の画像の `load` はページのスクリプトへ届けない（文書の捕捉の段階で止める）。仮の画像の読み込みが終わってから
 *    差し替えるので、ページから見た `load` は元と同じ 1 回になる
 *  - 届く前の画像を押したら、その操作を止めて最優先で取り寄せ、届いたら同じ画像へもう一度 `click()` を送る
 *  - 順番は 押した画像 → 見えている画像 → 上下 2 画面の中 → 残り（ページの読み込みが終わってから）
 *
 * ページ自身のスクリプトも同じ口で頼めるが、返すのはこの文書から抜いた画像だけなので害は無い。
 */

/** 同時に取り寄せる枚数。見えている画像を先に届けるため、少なめにする。 */
export const HTML_IMAGE_FETCH_CONCURRENCY = 2;
/** 1 枚の取り寄せをやり直す回数（通信の失敗など。PC が「中身が変わった」と返したらやり直さない）。 */
const HTML_IMAGE_FETCH_ATTEMPTS = 2;
/** PC が 1 つの文書から抜く画像の数の上限（PC の `PARADIS_MOBILE_HTML_IMAGE_MAX_COUNT` と同じ）。 */
export const HTML_IMAGE_MAX_COUNT = 2_000;

/** 取り寄せの順番。小さいほど先。 */
export type HtmlImagePriority = 'click' | 'visible' | 'near' | 'idle';
const PRIORITY_RANK: Readonly<Record<HtmlImagePriority, number>> = { click: 0, visible: 1, near: 2, idle: 3 };

/** ページの中のスクリプトがアプリへ送る、取り寄せの頼み。 */
const REQUEST_TYPE = 'paradisHtmlImage';

/**
 * 本文より先に入れるスクリプト（`injectedJavaScriptBeforeContentLoaded`）。大域の名前は `__paradis` で始まる 1 つだけ。
 */
export const HTML_IMAGES_LOADER_SCRIPT = `(function () {
	if (window.__paradisDeliverHtmlImage) { return; }
	var ATTRIBUTE = 'data-paradis-img';
	var RANK = { click: 0, visible: 1, near: 2, idle: 3 };
	var sent = {};
	var clicked = {};
	var waiting = new WeakMap();
	function request(id, priority) {
		if (id === null || (sent[id] !== undefined && sent[id] <= RANK[priority])) { return; }
		sent[id] = RANK[priority];
		window.ReactNativeWebView.postMessage(JSON.stringify({ type: '${REQUEST_TYPE}', index: Number(id), priority: priority }));
	}
	function swap(img, data) {
		var id = img.getAttribute(ATTRIBUTE);
		img.removeAttribute(ATTRIBUTE);
		img.src = data;
		if (clicked[id]) { delete clicked[id]; img.click(); }
	}
	window.__paradisDeliverHtmlImage = function (id, data) {
		var img = document.querySelector('img[' + ATTRIBUTE + '="' + id + '"]');
		if (!img) { return; }
		// 仮の画像の読み込みが終わってから差し替える（遅れて届いた仮の load を、本物の load と取り違えさせない）
		if (img.complete && img.naturalWidth > 0) { swap(img, data); } else { waiting.set(img, data); }
	};
	// 仮の画像の load・error はページのものではない。load は window へ届かないので、document の捕捉の段階で止める
	['load', 'error'].forEach(function (type) {
		document.addEventListener(type, function (event) {
			var img = event.target;
			if (!img || img.tagName !== 'IMG' || !img.hasAttribute(ATTRIBUTE)) { return; }
			event.stopImmediatePropagation();
			var data = waiting.get(img);
			if (data !== undefined) { waiting.delete(img); swap(img, data); }
		}, true);
	});
	// 届く前の画像を押したら、届いてから同じ画像へ押し直す
	window.addEventListener('click', function (event) {
		var img = event.target && event.target.closest ? event.target.closest('img[' + ATTRIBUTE + ']') : null;
		if (!img) { return; }
		event.stopImmediatePropagation();
		event.preventDefault();
		var id = img.getAttribute(ATTRIBUTE);
		clicked[id] = true;
		request(id, 'click');
	}, true);
	function watch(priority, rootMargin) {
		var observer = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (entry.isIntersecting) {
					observer.unobserve(entry.target);
					request(entry.target.getAttribute(ATTRIBUTE), priority);
				}
			});
		}, { rootMargin: rootMargin });
		document.querySelectorAll('img[' + ATTRIBUTE + ']').forEach(function (img) { observer.observe(img); });
	}
	function start() {
		watch('visible', '0px');
		watch('near', '200% 0px');
	}
	if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', start); } else { start(); }
	window.addEventListener('load', function () {
		setTimeout(function () {
			document.querySelectorAll('img[' + ATTRIBUTE + ']').forEach(function (img) { request(img.getAttribute(ATTRIBUTE), 'idle'); });
		}, 300);
	});
})();
true;`;

/** 取り寄せた画像をページへ返すスクリプト（`injectJavaScript`）。 */
export function buildHtmlImageDeliverScript(index: number, data: string): string {
	return `window.__paradisDeliverHtmlImage && window.__paradisDeliverHtmlImage(${JSON.stringify(String(index))}, ${JSON.stringify(data)});\ntrue;`;
}

/** WebView のメッセージが取り寄せの頼みなら、番号と順番を返す（形が違えば `undefined`）。 */
export function parseHtmlImageRequest(data: string, count: number): { readonly index: number; readonly priority: HtmlImagePriority } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const { type, index, priority } = parsed as { type?: unknown; index?: unknown; priority?: unknown };
	if (type !== REQUEST_TYPE || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= count
		|| !isPriority(priority)) {
		return undefined;
	}
	return { index, priority };
}

function isPriority(value: unknown): value is HtmlImagePriority {
	return value === 'click' || value === 'visible' || value === 'near' || value === 'idle';
}

/** {@link HtmlImageQueue} が使う口。 */
export interface HtmlImageQueueHost {
	/** 抜いた画像の数（PC の応答の `htmlImages.count`）。 */
	readonly count: number;
	/** 1 枚取り寄せる（元の `data:` の文字列）。 */
	fetch(index: number): Promise<string>;
	/** 取り寄せた画像をページへ返す。 */
	deliver(index: number, data: string): void;
	/** PC が「中身が変わった」と返したか。 */
	isStale(error: unknown): boolean;
	/** 中身が変わっていた。本文から読み直す（1 つのキューで 1 回だけ呼ぶ）。 */
	onStale(): void;
}

/**
 * 取り寄せの順番待ち。同時 {@link HTML_IMAGE_FETCH_CONCURRENCY} 枚まで、順番の小さいものから取り寄せる。
 * 同じ画像を頼み直したら、順番が上がるときだけ繰り上げる。{@link dispose}（画面を閉じた・本文が替わった）の後は、
 * 待っている分を捨て、取り寄せ中の結果も返さない。
 */
export class HtmlImageQueue {
	private readonly pending = new Map<number, number>();
	private readonly settled = new Set<number>();
	private readonly attempts = new Map<number, number>();
	private running = 0;
	private disposed = false;

	constructor(private readonly host: HtmlImageQueueHost) { }

	/** WebView のメッセージを受ける。取り寄せの頼みだったら true（検索など、ほかの受け手へ回さない）。 */
	handleMessage(data: string): boolean {
		const parsed = parseHtmlImageRequest(data, Math.min(this.host.count, HTML_IMAGE_MAX_COUNT));
		if (parsed === undefined) {
			return false;
		}
		this.request(parsed.index, parsed.priority);
		return true;
	}

	request(index: number, priority: HtmlImagePriority): void {
		if (this.disposed || this.settled.has(index)) {
			return;
		}
		const rank = PRIORITY_RANK[priority];
		const queued = this.pending.get(index);
		if (queued === undefined || rank < queued) {
			this.pending.set(index, rank);
		}
		this.pump();
	}

	dispose(): void {
		this.disposed = true;
		this.pending.clear();
	}

	private pump(): void {
		while (!this.disposed && this.running < HTML_IMAGE_FETCH_CONCURRENCY && this.pending.size > 0) {
			let next: number | undefined;
			let nextRank = Infinity;
			for (const [index, rank] of this.pending) {
				if (rank < nextRank) {
					next = index;
					nextRank = rank;
				}
			}
			if (next === undefined) {
				return;
			}
			this.pending.delete(next);
			this.settled.add(next);
			this.running++;
			void this.run(next, nextRank);
		}
	}

	private async run(index: number, rank: number): Promise<void> {
		try {
			const data = await this.host.fetch(index);
			if (!this.disposed && data.startsWith('data:image/')) {
				this.host.deliver(index, data);
			}
		} catch (error) {
			if (this.disposed) {
				return;
			}
			if (this.host.isStale(error)) {
				this.dispose();
				this.host.onStale();
				return;
			}
			const tried = (this.attempts.get(index) ?? 0) + 1;
			this.attempts.set(index, tried);
			if (tried < HTML_IMAGE_FETCH_ATTEMPTS) {
				// やり直しは後回しにする（押した画像なら順番はそのまま）
				this.settled.delete(index);
				this.pending.set(index, rank === PRIORITY_RANK.click ? rank : Math.max(rank, PRIORITY_RANK.near));
			}
		} finally {
			this.running--;
			this.pump();
		}
	}
}
