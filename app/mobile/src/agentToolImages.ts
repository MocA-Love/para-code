// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ツール結果に含まれていた画像（Readで読んだスクリーンショット、MCPのスクショ等）の
 * 取得済みキャッシュ。
 *
 * PC側は同じ画像をリクエストのたびに丸ごと送ってくるため、一度取れたものは端末側で使い回す。
 * サムネ（ファイルカード）と全画面ビューアは同じ実体を共有し、二度目の通信を発生させない。
 *
 * data URI をそのまま持つので1件が数百KB〜数MBになる。件数と合計バイトの両方に上限を置き、
 * 古いものから捨てる（PC側の画像キャッシュと同じ考え方）。
 */

export interface CachedToolImage {
	/** `data:image/png;base64,...`。<Image source={{ uri }} /> にそのまま渡せる。 */
	readonly uri: string;
	/** 会計用のおおよそのバイト数（base64の文字数）。 */
	readonly bytes: number;
}

/** 保持する画像の枚数上限。 */
const CACHE_ENTRIES = 8;
/** 保持する画像の合計バイト上限。 */
const CACHE_BYTES = 12 * 1024 * 1024;

/**
 * 画像1枚を一意に指すキー。epoch を含めるのは、セッションが張り直されると rev が
 * 振り直され、同じ rev が別の画像を指すようになるため。
 */
export function toolImageKey(terminalKey: string, epoch: string, rev: number, index: number): string {
	return `${terminalKey}\0${epoch}\0${rev}\0${index}`;
}

export class ToolImageCache {
	private readonly entries = new Map<string, CachedToolImage>();
	private bytes = 0;

	constructor(
		private readonly maxEntries: number = CACHE_ENTRIES,
		private readonly maxBytes: number = CACHE_BYTES,
	) { }

	get(key: string): CachedToolImage | undefined {
		return this.entries.get(key);
	}

	/** 取得済みの画像を登録する。単体で上限を超える画像は保持せず、その場限りの表示に任せる。 */
	set(key: string, image: CachedToolImage): void {
		if (image.bytes > this.maxBytes) {
			return;
		}
		const existing = this.entries.get(key);
		if (existing !== undefined) {
			this.bytes -= existing.bytes;
			this.entries.delete(key);
		}
		this.entries.set(key, image);
		this.bytes += image.bytes;
		while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.bytes -= this.entries.get(oldest.value)?.bytes ?? 0;
			this.entries.delete(oldest.value);
		}
	}

	/** サインアウト・ペアリング解除時に持ち越さないための全消去。 */
	clear(): void {
		this.entries.clear();
		this.bytes = 0;
	}

	/** テスト用の内部状態。 */
	stats(): { readonly count: number; readonly bytes: number } {
		return { count: this.entries.size, bytes: this.bytes };
	}
}

/** アプリ全体で共有する1個のキャッシュ。 */
export const toolImageCache = new ToolImageCache();

/**
 * 取得中の要求: キー → 進行中の Promise。同じ画像をサムネと全画面ビューアが相前後して
 * 求めたときに、PCへ二度取りに行かないための相乗り。完了したら（成否によらず）外す。
 */
const inFlight = new Map<string, Promise<CachedToolImage>>();

/**
 * 画像1枚を取り寄せる。取得済みならキャッシュを即返し、取得中なら同じ Promise に相乗りする。
 * `fetchImage` は実際の通信（store の requestAgentToolImage）を行う関数。
 */
export function loadToolImage(key: string, fetchImage: () => Promise<{ readonly mediaType: string; readonly data: string }>): Promise<CachedToolImage> {
	const cached = toolImageCache.get(key);
	if (cached !== undefined) {
		return Promise.resolve(cached);
	}
	const existing = inFlight.get(key);
	if (existing !== undefined) {
		return existing;
	}
	const request = fetchImage()
		.then(result => {
			const image: CachedToolImage = { uri: toolImageDataUri(result.mediaType, result.data), bytes: result.data.length };
			toolImageCache.set(key, image);
			return image;
		})
		.finally(() => { inFlight.delete(key); });
	inFlight.set(key, request);
	return request;
}

/** テスト用。取得中の件数。 */
export function toolImageInFlightCount(): number {
	return inFlight.size;
}

/** base64 と mediaType から <Image> へ渡す data URI を組み立てる。 */
export function toolImageDataUri(mediaType: string, base64: string): string {
	return `data:${mediaType};base64,${base64}`;
}

/** 「215 KB」のような容量表示。1KB未満はバイトのまま出す。 */
export function formatImageBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '';
	}
	if (bytes < 1024) {
		return `${Math.round(bytes)} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
