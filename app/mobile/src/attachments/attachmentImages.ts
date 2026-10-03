// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { pcHasCapabilityFor, sendPcRequest } from '../appState.js';
import { PcCapability } from '../pcCompat.js';
import { isPcUnreachableError, pcReplyErrorCode } from '../store.js';
import { ATTACHMENT_FAILURE_MESSAGES, base64ByteLength, classifyAttachmentFailure, finalAttachmentFailure, shouldRetryWithoutWorkspace, type AttachmentFailureKind } from './attachmentFetchPolicy.js';
import { attachmentFileName, attachmentMediaTypeOfBase64 } from './attachmentText.js';

/**
 * 添付画像の実体を探して出す（札のサムネイルと全画面ビューア）。
 *
 * 探す順番:
 * 1. 端末の控え（送った端末だけ。上げるときに書く。OS が消すことがあるキャッシュの場所）
 * 2. 端末に持っているサムネイル（PC から取り寄せたもの）
 * 3. PC の置き場（`fs.attachment.v1` を広告している PC だけ。サムネイルは PC で長辺 512px に縮めて受け取る）。
 *    スペースの PC 画面で見つからなければ、スペースを付けずにもう 1 回頼む
 * 4. 呼び出し側が渡す代わり（transcript の画像のブロック。大きさで照合できたときだけ。`attachmentChips.tsx`）
 *
 * 原寸は全画面で開いたときだけ取り寄せ、端末の控えとして書いておく（共有・写真への保存はファイルが要る）。
 */

/** 端末の控え（原寸）。OS が空きの足りないときに消すことがあるが、そのときは PC から取り直す。 */
const ORIGINALS_DIR = LegacyFileSystem.cacheDirectory !== null ? `${LegacyFileSystem.cacheDirectory}paraAttachments/` : undefined;
/**
 * PC で縮めたサムネイル（1 枚数十 KB）。アプリは消さない（掃除しない）。
 *
 * iCloud のバックアップに載せず、OS にも消されない場所（Library/Application Support に「バックアップの対象外」の
 * 属性を付ける）が望ましいが、expo-file-system（SDK 57。legacy・新 API とも）に属性を付ける口が無く、既存の
 * ネイティブモジュール（`modules/para-*`）にも無い。そのためバックアップの対象外である caches に置き、OS が消したら
 * PC から取り直す（PC は置き場を掃除しないので取り直せる）。
 */
const THUMBS_DIR = LegacyFileSystem.cacheDirectory !== null ? `${LegacyFileSystem.cacheDirectory}paraAttachmentThumbs/` : undefined;

/** PC からの取り寄せを同時に走らせる数（見えている札の分だけ頼むが、一度に投げすぎない）。 */
const MAX_CONCURRENT_FETCHES = 4;

/** 札・ビューアが指す 1 枚。 */
export interface AttachmentTarget {
	/** どの PC の置き場か（省くといま見ている PC）。 */
	readonly pcId: string | undefined;
	/** そのエージェントのスペース（そのスペースの PC 画面へ頼む。SSH 先の置き場はそのウィンドウでしか読めない）。 */
	readonly ws: string | undefined;
	readonly name: string;
	readonly path: string;
}

/** 失敗の理由を利用者向けの短い文で持つ。 */
export class AttachmentLoadError extends Error {
	constructor(message: string, readonly kind: AttachmentFailureKind) {
		super(message);
		this.name = 'AttachmentLoadError';
	}
}

const knownFiles = new Map<string, string>();

/**
 * 添付の原寸の大きさ（バイト）。端末の控え・PC の応答から分かったものだけ。transcript の画像のブロックと照合するのに使う。
 */
const useAttachmentSizeStore = create<{ readonly sizes: Readonly<Record<string, number>> }>()(() => ({ sizes: {} }));

function recordAttachmentSize(name: string, size: number | undefined): void {
	if (size === undefined || !Number.isFinite(size) || size <= 0 || useAttachmentSizeStore.getState().sizes[name] === size) {
		return;
	}
	useAttachmentSizeStore.setState(state => ({ sizes: { ...state.sizes, [name]: size } }));
}

/** 添付の原寸の大きさ（分からないものは undefined）。 */
export function useAttachmentSizes(names: readonly string[]): readonly (number | undefined)[] {
	return useAttachmentSizeStore(useShallow(state => names.map(name => state.sizes[name])));
}
const inFlight = new Map<string, Promise<string>>();
let running = 0;
const waiting: Array<() => void> = [];

async function withFetchSlot<T>(run: () => Promise<T>): Promise<T> {
	if (running >= MAX_CONCURRENT_FETCHES) {
		await new Promise<void>(resolve => waiting.push(resolve));
	}
	running++;
	try {
		return await run();
	} finally {
		running--;
		waiting.shift()?.();
	}
}

async function ensureDirectory(directory: string): Promise<void> {
	const info = await LegacyFileSystem.getInfoAsync(directory);
	if (!info.exists) {
		await LegacyFileSystem.makeDirectoryAsync(directory, { intermediates: true });
	}
}

/** そのファイルがあれば URI。`sizeOf` を渡すと、その添付の原寸の大きさとして覚える。 */
async function existing(uri: string | undefined, sizeOf?: string): Promise<string | undefined> {
	if (uri === undefined) {
		return undefined;
	}
	if (knownFiles.get(uri) === uri) {
		return uri;
	}
	try {
		const info = await LegacyFileSystem.getInfoAsync(uri);
		if (info.exists) {
			knownFiles.set(uri, uri);
			if (sizeOf !== undefined) {
				recordAttachmentSize(sizeOf, info.size);
			}
			return uri;
		}
	} catch { /* 読めなければ無いものとして次を探す */ }
	knownFiles.delete(uri);
	return undefined;
}

function originalUri(name: string, mediaType?: string): string | undefined {
	return ORIGINALS_DIR !== undefined ? `${ORIGINALS_DIR}${attachmentFileName(name, mediaType)}` : undefined;
}

function thumbUri(name: string): string | undefined {
	return THUMBS_DIR !== undefined ? `${THUMBS_DIR}${name}.jpg` : undefined;
}

/** 端末の控え（名前に拡張子が無いものは JPEG として書いてある）。 */
function existingOriginal(name: string): Promise<string | undefined> {
	return existing(originalUri(name), name);
}

/**
 * 上げ終わった画像を端末の控えとして書く（送った端末は PC に頼まずに出せる）。失敗しても送信は止めない。
 */
export async function saveAttachmentDeviceCopy(name: string, base64: string): Promise<string | undefined> {
	const uri = originalUri(name);
	if (uri === undefined || ORIGINALS_DIR === undefined) {
		return undefined;
	}
	try {
		await ensureDirectory(ORIGINALS_DIR);
		await LegacyFileSystem.writeAsStringAsync(uri, base64, { encoding: LegacyFileSystem.EncodingType.Base64 });
		knownFiles.set(uri, uri);
		recordAttachmentSize(name, base64ByteLength(base64));
		return uri;
	} catch {
		return undefined;
	}
}

function failure(kind: AttachmentFailureKind): AttachmentLoadError {
	return new AttachmentLoadError(ATTACHMENT_FAILURE_MESSAGES[kind], kind);
}

async function requestFromPc(target: AttachmentTarget, variant: 'thumb' | 'full', ws: string | undefined): Promise<{ readonly data: string; readonly mediaType: string | undefined }> {
	try {
		const response = await withFetchSlot(() => sendPcRequest<{ readonly data?: unknown; readonly mediaType?: unknown; readonly size?: unknown }>(target.pcId, 'fs', {
			t: 'attachment',
			name: target.name,
			variant,
			responseEncoding: 'fs-binary-v1',
			...(ws !== undefined ? { ws } : {}),
		}, { timeoutMs: variant === 'full' ? 120_000 : 30_000 }));
		if (typeof response.data !== 'string' || response.data.length === 0) {
			throw failure('other');
		}
		// PC は `size` に置き場のファイル（原寸）の大きさを入れる（サムネイルの応答でも）
		recordAttachmentSize(target.name, typeof response.size === 'number' ? response.size : undefined);
		return { data: response.data, mediaType: typeof response.mediaType === 'string' ? response.mediaType : undefined };
	} catch (error) {
		if (error instanceof AttachmentLoadError) {
			throw error;
		}
		throw failure(classifyAttachmentFailure(pcReplyErrorCode(error), isPcUnreachableError(error)));
	}
}

async function fetchFromPc(target: AttachmentTarget, variant: 'thumb' | 'full'): Promise<{ readonly data: string; readonly mediaType: string | undefined }> {
	if (!pcHasCapabilityFor(target.pcId, PcCapability.FsAttachment)) {
		throw failure('old-pc');
	}
	const hadWorkspace = target.ws !== undefined;
	try {
		return await requestFromPc(target, variant, target.ws);
	} catch (error) {
		const kind = error instanceof AttachmentLoadError ? error.kind : 'other';
		if (!shouldRetryWithoutWorkspace(kind, hadWorkspace)) {
			throw failure(finalAttachmentFailure(kind, hadWorkspace));
		}
	}
	// スペースの PC 画面に無ければ、スペースを付けずにもう 1 回（いま前面の画面へ届く。手元と接続先の取り違えに備える）
	try {
		return await requestFromPc(target, variant, undefined);
	} catch (error) {
		const kind = error instanceof AttachmentLoadError ? error.kind : 'other';
		throw failure(kind);
	}
}

function shared(key: string, run: () => Promise<string>): Promise<string> {
	const current = inFlight.get(key);
	if (current !== undefined) {
		return current;
	}
	const request = run().finally(() => { inFlight.delete(key); });
	inFlight.set(key, request);
	return request;
}

/** 札のサムネイル（端末のファイルの URI）。 */
export function loadAttachmentThumb(target: AttachmentTarget): Promise<string> {
	return shared(`thumb\0${target.name}`, async () => {
		const local = await existingOriginal(target.name) ?? await existing(thumbUri(target.name));
		if (local !== undefined) {
			return local;
		}
		const fetched = await fetchFromPc(target, 'thumb');
		const uri = thumbUri(target.name);
		if (uri === undefined || THUMBS_DIR === undefined) {
			return `data:image/jpeg;base64,${fetched.data}`;
		}
		await ensureDirectory(THUMBS_DIR);
		await LegacyFileSystem.writeAsStringAsync(uri, fetched.data, { encoding: LegacyFileSystem.EncodingType.Base64 });
		knownFiles.set(uri, uri);
		return uri;
	});
}

/** 全画面の原寸（端末のファイルの URI）。 */
export function loadAttachmentFull(target: AttachmentTarget): Promise<string> {
	return shared(`full\0${target.name}`, async () => {
		const local = await existingOriginal(target.name);
		if (local !== undefined) {
			return local;
		}
		const fetched = await fetchFromPc(target, 'full');
		const saved = await saveAttachmentDeviceCopy(target.name, fetched.data);
		return saved ?? `data:${fetched.mediaType ?? attachmentMediaTypeOfBase64(fetched.data) ?? 'image/jpeg'};base64,${fetched.data}`;
	});
}

/** 取り寄せの状態（`toolImage.tsx` の `ImageLoad` と同じ形）。 */
export type AttachmentLoad =
	| { readonly status: 'idle' }
	| { readonly status: 'loading' }
	| { readonly status: 'ready'; readonly uri: string }
	| { readonly status: 'error'; readonly message: string; readonly kind: AttachmentLoadError['kind'] };

/** 札・ビューアから使う。`enabled` が false の間は何もしない。 */
export function useAttachmentImage(target: AttachmentTarget | undefined, variant: 'thumb' | 'full', enabled = true): AttachmentLoad {
	const [load, setLoad] = useState<AttachmentLoad>({ status: 'idle' });
	const generation = useRef(0);
	const pcId = target?.pcId;
	const ws = target?.ws;
	const name = target?.name;
	const path = target?.path;
	useEffect(() => {
		const current = ++generation.current;
		if (name === undefined || path === undefined || !enabled) {
			setLoad({ status: 'idle' });
			return;
		}
		setLoad({ status: 'loading' });
		const request = { pcId, ws, name, path };
		(variant === 'thumb' ? loadAttachmentThumb(request) : loadAttachmentFull(request))
			.then(uri => {
				if (generation.current === current) {
					setLoad({ status: 'ready', uri });
				}
			})
			.catch((error: unknown) => {
				if (generation.current === current) {
					const reason = error instanceof AttachmentLoadError ? error : failure('other');
					setLoad({ status: 'error', message: reason.message, kind: reason.kind });
				}
			});
		return () => { generation.current++; };
	}, [pcId, ws, name, path, variant, enabled]);
	return load;
}

/** 共有・保存に使える端末のファイルにする（data URI のときは一時ファイルへ書く）。 */
export async function attachmentShareableUri(uri: string, name: string): Promise<string | undefined> {
	if (!uri.startsWith('data:')) {
		return uri;
	}
	const match = /^data:([^;]+);base64,(.*)$/s.exec(uri);
	const directory = LegacyFileSystem.cacheDirectory;
	if (match === null || directory === null) {
		return undefined;
	}
	const target = `${directory}${attachmentFileName(name, match[1])}`;
	await LegacyFileSystem.writeAsStringAsync(target, match[2] ?? '', { encoding: LegacyFileSystem.EncodingType.Base64 });
	return target;
}
