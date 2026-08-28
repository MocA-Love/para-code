/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// react-dropzone 等、クリック起点のファイル選択（<input type=file> への直接注入や、クリックで
// 開くネイティブファイル選択ダイアログへの応答）を受け付けない、ドロップ専用UIへ向けた
// 「信頼済みHTML5ドラッグ&ドロップ」によるファイルアップロードの実装本体。
//
// なぜ vendored chrome-devtools-mcp の upload_file だけでは足りないか:
//   同ツールは <input type=file> への直接注入 (ElementHandle.uploadFile)、またはクリックで
//   開くファイル選択ダイアログの自動応答 (waitForFileChooser) にしか対応しない。
//   react-dropzone を noClick/noKeyboard で使う実装や、input要素を持たず `drop` DOM イベント
//   だけを listen する自前実装は、どちらの経路でも反応しない。本物のOSドラッグ&ドロップに近い
//   dragenter → dragover → drop の DataTransfer 付きイベント列を CDP Input.dispatchDragEvent で
//   流し込むことで、こうしたUIも同じ経路で操作できる（ベンダー物は改造しない）。
//
// 座標解決: ドロップ先は take_snapshot の uid で指定させる。uid → 要素のマッピングは
// chrome-devtools-mcp 内部の状態でしかなく、こちらから直接は触れない。そこで同じくベンダー済み
// evaluate_script ツール（uidを渡すと解決済み要素をコールバック引数へ渡してくれる仕様）へ
// 委譲し、ビューポート座標 (getBoundingClientRect) を取得する。呼び出し側 (paradisAgentBrowserService)
// が既存の `_callDevtoolsTool('evaluate_script', ...)` 経由でこれを行い、ここでは応答テキストの
// 解析だけを引き受ける。評価関数は要素をスクロールで可視化し、メインフレーム内かどうか・
// ビューポート内に収まっているかを一緒に返す前提（呼び出し側がそれを検証する）。座標系は
// `Input.dispatchDragEvent` の x/y と同じ「メインフレームのビューポートに対するCSS px」。
//
// ファイル本体: CDPの `data.files` はローカルファイルパスを取る（ブラウザ側がその場で読む）ため、
// 渡されたbase64を一時ファイルへ書き出してからパスを渡す。書き込み先はOSの一時ディレクトリ
// 配下・アップロードごとの使い捨てサブディレクトリ（ファイル名の衝突・トラバーサルを避けるため）。
// ページ側の非同期読み取り（FileReaderやXHR送出など）に猶予を持たせるため即座には消さず、
// 一定時間後にディレクトリごと掃除する（サービスdispose時は即時掃除）。件数・総バイト数にも
// 上限を設け、超過時は最も古いステージング済みディレクトリから即時に掃除する。
//
// サイズ上限: base64本文はMCPのJSON-RPCリクエストボディそのものに載る。shim側の1リクエスト
// 上限 (`PARADIS_MCP_MAX_REQUEST_BYTES` = 4MiB、paradisBrowserMcpShimCore.ts) と、shared process
// 側の同等の上限 (`PARADIS_AGENT_HOOK_MAX_BODY_BYTES` を流用、paradisAgentHooks.ts) を超えると、
// シムが行バッファのオーバーフローで丸ごとプロセス終了する（そのペインの他ツールも巻き添えに
// なる）。base64は元データの約4/3に膨らむ上、JSON-RPCのエンベロープ・ツール名・uid等のオーバー
// ヘッドも載るため、4MiBぴったりではなく余裕を持たせた値をここで宣言する。

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import type { ParadisCdpInputMethod } from '../common/paradisAgentBrowser.js';

/**
 * ステージング用ファイル名として許可する文字集合。区切り文字・制御文字・NULに加え、
 * Windowsの予約文字 `<>:"|?*` も拒否する（`:` はNTFSの代替データストリーム(ADS)記法
 * `name:stream` に使われうるため、他プラットフォームでも一律禁止にしている）。
 */
const SAFE_FILE_NAME_PATTERN = /^[^\x00-\x1f/\\<>:"|?*]{1,200}$/;

/**
 * base64本文のデコード後の上限。4MiBのtransport上限（shim/shared processどちらも同じ枠）から、
 * base64膨張(4/3)・JSON-RPCエンベロープ・そして `paradisDecodeFileDropContent` が許容する
 * 折り返し改行（エージェント側が生成するbase64に入り得る `\n`）ぶんの余裕を大きめに差し引いた値。
 * 3MiB台まで許すと、76桁折り返しの改行だけで実効サイズが4MiBを再び超えてしまう実測があったため、
 * 2MiBという十分に保守的な値にしている（実運用ではLLMの出力トークン上限の方が先に効くため、
 * 数百KB程度が現実的な上限であり、実用上の制約にはならない）。これより大きくすると、送信時点で
 * シムの行バッファ上限に達してプロセスごと落ちてしまう（そのペインの他ツールも巻き添えになる。
 * 詳細はファイル冒頭のコメント参照）。
 */
export const PARADIS_FILE_DROP_MAX_BYTES = 2 * 1024 * 1024;
/** 上の上限をMiB表記にした、ツール説明文向けの文字列。 */
export const PARADIS_FILE_DROP_MAX_BYTES_LABEL = `${(PARADIS_FILE_DROP_MAX_BYTES / (1024 * 1024)).toFixed(1)} MiB`;
/** base64文字列自体の長さ上限（デコード後上限からの見積り、余裕を持たせてある）。 */
const MAX_BASE64_LENGTH = Math.ceil(PARADIS_FILE_DROP_MAX_BYTES / 3) * 4 + 4;

/** 一時ファイルを消すまでの猶予。ページ側の非同期読み取り（FileReader等）に猶予を残す。 */
const DEFAULT_STAGING_TTL_MS = 10 * 60_000;
/** 同時に保持できるステージング済みアップロードの件数上限。超過分は最古から即時掃除する。 */
const DEFAULT_MAX_STAGING_ENTRIES = 32;
/** ステージング済みアップロードの合計バイト数上限（掃除待ちの一時ファイル総量の保険）。 */
const DEFAULT_MAX_STAGING_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * ドロップ先要素の中心座標（メインフレームのビューポートに対するCSS px、
 * `Input.dispatchDragEvent` の x/y と同じ座標系）と、それを安全に使ってよいかの判定材料。
 */
export interface IParadisResolvedDropTarget {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** 要素がページのメインフレーム（トップレベルのdocument）に属しているか。 */
	readonly inMainFrame: boolean;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
	/**
	 * 中心座標に対して `document.elementFromPoint` した実際の最前面要素が、ドロップ先要素
	 * 自身でも、その祖先・子孫でもない（＝stickyヘッダーやモーダル等に覆われている）か。
	 */
	readonly occluded: boolean;
}

/**
 * `evaluate_script`（vendored、uid引数付き）の呼び出し結果から、ドロップ先の中心座標を取り出す。
 *
 * 期待する形は、evaluate_script が本文へ埋め込む ```json フェンス内の
 * `{"x":..,"y":..,"width":..,"height":..,"inMainFrame":..,"viewW":..,"viewH":..,"occluded":..}`。
 * 呼び出し側は関数本体として、要素を可視化してから自身の座標系（メインフレームか否か・
 * ビューポート寸法・遮蔽の有無）を一緒に返すもの（例:
 * `(el) => { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
 *   const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
 *   const hit = document.elementFromPoint(cx, cy);
 *   return { x: cx, y: cy, width: r.width, height: r.height,
 *     inMainFrame: window.top === window, viewW: innerWidth, viewH: innerHeight,
 *     occluded: !(hit && (el === hit || el.contains(hit) || hit.contains(el))) }; }`）
 * を渡す想定（座標の意味づけまでは本関数の責務ではなく、呼び出し側が決める）。
 */
export function paradisParseResolvedDropTarget(evaluateScriptResult: unknown): IParadisResolvedDropTarget | undefined {
	const content = (evaluateScriptResult as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	for (const entry of content) {
		const text = (entry as { type?: unknown; text?: unknown } | undefined)?.text;
		if ((entry as { type?: unknown } | undefined)?.type !== 'text' || typeof text !== 'string') {
			continue;
		}
		const match = /```json\r?\n([\s\S]*?)\r?\n```/.exec(text);
		if (match === null) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(match[1]);
			if (typeof parsed !== 'object' || parsed === null) {
				continue;
			}
			const { x, y, width, height, inMainFrame, viewW, viewH, occluded } = parsed as {
				x?: unknown; y?: unknown; width?: unknown; height?: unknown;
				inMainFrame?: unknown; viewW?: unknown; viewH?: unknown; occluded?: unknown;
			};
			if (typeof x === 'number' && Number.isFinite(x)
				&& typeof y === 'number' && Number.isFinite(y)
				&& typeof width === 'number' && Number.isFinite(width)
				&& typeof height === 'number' && Number.isFinite(height)
				&& typeof inMainFrame === 'boolean'
				&& typeof viewW === 'number' && Number.isFinite(viewW)
				&& typeof viewH === 'number' && Number.isFinite(viewH)
				&& typeof occluded === 'boolean') {
				return Object.freeze({ x, y, width, height, inMainFrame, viewportWidth: viewW, viewportHeight: viewH, occluded });
			}
		} catch {
			// このテキストブロックは対象外。他のcontent要素を試す。
		}
	}
	return undefined;
}

/** base64本文を検証してデコードする。長すぎる／base64として不正／空はundefined。 */
export function paradisDecodeFileDropContent(contentBase64: unknown): Buffer | undefined {
	if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
		return undefined;
	}
	// エージェント側で折り返された（改行・空白入りの）base64でも通るように、まず取り除く。
	const normalized = contentBase64.replace(/\s+/g, '');
	if (normalized.length === 0 || normalized.length > MAX_BASE64_LENGTH) {
		return undefined;
	}
	// Buffer.from は不正なbase64文字を黙って読み飛ばすため、先に文字集合と長さを検証しておく
	// （でないと切り詰められた内容を気付かずステージングしてしまう）。
	if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
		return undefined;
	}
	const buffer = Buffer.from(normalized, 'base64');
	return buffer.byteLength > 0 && buffer.byteLength <= PARADIS_FILE_DROP_MAX_BYTES ? buffer : undefined;
}

/** ステージング用のファイル名を検証する（パストラバーサル・区切り文字・制御文字を拒否）。 */
export function paradisSanitizeFileDropName(fileName: unknown): string | undefined {
	if (typeof fileName !== 'string') {
		return undefined;
	}
	const trimmed = fileName.trim();
	return SAFE_FILE_NAME_PATTERN.test(trimmed) && trimmed !== '.' && trimmed !== '..' ? trimmed : undefined;
}

interface IStagingEntry {
	readonly timer: ReturnType<typeof setTimeout>;
	readonly bytes: number;
}

/**
 * base64で受け取ったファイル内容を、CDPの `data.files` へ渡せる実パスとして一時ディレクトリへ
 * 書き出す台帳。アップロードごとに使い捨てのサブディレクトリへ書くため、同名ファイル同士も
 * 衝突しない。ページ側の非同期読み取りに猶予を残すため即座には消さず、一定時間後に
 * ディレクトリごと削除する（サービスdispose時は即時ベストエフォートで全掃除）。
 *
 * 件数・合計バイト数のどちらかが上限へ達すると、新しい保存の前に最も古いエントリから
 * 即時に掃除する（screenshotHandoffの `MAX_ENTRIES` 追い出しと同じ考え方）。
 */
export class ParadisFileDropStaging {

	private readonly _pending = new Map<string, IStagingEntry>();
	private _totalBytes = 0;
	private _disposed = false;

	constructor(
		private readonly ttlMs: number = DEFAULT_STAGING_TTL_MS,
		private readonly maxEntries: number = DEFAULT_MAX_STAGING_ENTRIES,
		private readonly maxTotalBytes: number = DEFAULT_MAX_STAGING_TOTAL_BYTES,
	) { }

	/** 内容を一時ファイルへ書き出し、実パスを返す。 */
	async stage(content: Buffer, fileName: string): Promise<string> {
		if (this._disposed) {
			throw new Error('file drop staging area is disposed');
		}
		this._evictUntilFits(content.byteLength);
		const dir = await mkdtemp(join(tmpdir(), 'paradis-mcp-drop-'));
		const filePath = join(dir, fileName);
		try {
			await writeFile(filePath, content);
		} catch (error) {
			await rm(dir, { recursive: true, force: true }).catch(() => { });
			throw error;
		}
		if (this._disposed) {
			// stage中にdisposeされた場合は自分で片付ける（timerを登録しても発火しないため）。
			await rm(dir, { recursive: true, force: true }).catch(() => { });
			return filePath;
		}
		const timer = setTimeout(() => this._evict(dir), this.ttlMs);
		// このリポジトリの型定義では setTimeout の戻り値は素性を明かさない不透明な `TimeoutHandle`
		// になっている（cross-platformなbase/common層がNode/ブラウザどちらの実体にも決め打ちの
		// 前提を置けないようにするため）。Node実行では常にNodeJS.Timeoutだが、テストが
		// Electronのrendererコンテキストで走る場合はブラウザ互換の数値ハンドルが返ることがあり、
		// `.unref` を持たない。`NodeJS.Timeout`への決め打ちキャストで隠さず、実体を見てから呼ぶ
		// （無ければ何もしない＝refしたままでも実害はない。disposeまたはevictで必ず
		// clearTimeoutされるため無限に生存はしない）。
		const timerHandle = timer as unknown as { unref?: () => void };
		if (typeof timerHandle.unref === 'function') {
			timerHandle.unref();
		}
		this._pending.set(dir, { timer, bytes: content.byteLength });
		this._totalBytes += content.byteLength;
		return filePath;
	}

	/** 保持中の一時ディレクトリを即時ベストエフォートで全掃除する。 */
	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const dir of [...this._pending.keys()]) {
			this._evict(dir);
		}
	}

	/** 件数・合計バイト数が新しいエントリを受け入れられるまで、最古のものから掃除する。 */
	private _evictUntilFits(incomingBytes: number): void {
		while (this._pending.size > 0
			&& (this._pending.size >= this.maxEntries || this._totalBytes + incomingBytes > this.maxTotalBytes)) {
			const oldest = this._pending.keys().next();
			if (oldest.done === true) {
				break;
			}
			this._evict(oldest.value);
		}
	}

	private _evict(dir: string): void {
		const entry = this._pending.get(dir);
		if (entry === undefined) {
			return;
		}
		clearTimeout(entry.timer);
		this._pending.delete(dir);
		this._totalBytes = Math.max(0, this._totalBytes - entry.bytes);
		void rm(dir, { recursive: true, force: true }).catch(() => { });
	}
}

/** 1件の `Input.dispatchDragEvent` 呼び出し（method + 検証済みJSON文字列のparams）。 */
export interface IParadisFileDropDragCommand {
	readonly method: ParadisCdpInputMethod;
	readonly paramsJson: string;
}

function buildDragCommand(type: 'dragEnter' | 'dragOver' | 'drop' | 'dragCancel', x: number, y: number, filePath: string): IParadisFileDropDragCommand {
	return Object.freeze({
		method: 'Input.dispatchDragEvent',
		paramsJson: JSON.stringify({ type, x, y, data: { items: [] as readonly unknown[], dragOperationsMask: 1, files: [filePath] } }),
	});
}

/**
 * dragEnter → dragOver → drop の3コマンドを組み立てる。全コマンドへ同じ `data`（items空・
 * dragOperationsMask=1=Copy・files=[filePath]）を渡す（実ブラウザのD&D同様、CDPも各呼び出しへ
 * 独立してdataを渡す設計であり、puppeteerの `Mouse#drag`/`drop` も同じ形で使っている）。
 * 生成するJSONは `paradisValidateCdpDragEvent`（common/paradisAgentBrowser.ts）の
 * 許可された形（キー集合・型）に厳密に一致させてある。
 */
export function paradisBuildFileDropDragCommands(x: number, y: number, filePath: string): readonly IParadisFileDropDragCommand[] {
	return Object.freeze([
		buildDragCommand('dragEnter', x, y, filePath),
		buildDragCommand('dragOver', x, y, filePath),
		buildDragCommand('drop', x, y, filePath),
	]);
}

/**
 * dragEnter/dragOver成功後にdrop（またはそれ以前の中断）が失敗したとき、ページ側に残る
 * `isDragActive` 等のドラッグ中状態を片付けるためのキャンセルコマンド。
 * ベストエフォート用途（この結果自体の成否は呼び出し元のエラーには影響させない）。
 */
export function paradisBuildFileDropDragCancelCommand(x: number, y: number, filePath: string): IParadisFileDropDragCommand {
	return buildDragCommand('dragCancel', x, y, filePath);
}
