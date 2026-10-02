// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { InteractionManager } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { FS_BINARY_RESPONSE_ENCODING, decodeUtf8 } from '@para/protocol';
import { sendPcRequest, useAppStore } from '../../appState.js';
import type { DiffRow } from '../../components/diffParser.js';
import { officeRawDiff } from './officeRawDiff.js';
import { reviewRenderSide, type ReviewContentKind, type ReviewSide, type ReviewSides, type ReviewViewMode } from './reviewViewModes.js';
import { errorMessage } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';
import type { FileContent } from './useFileContent.js';

/** 差分の画面の「表示」「差分」と、Office の「Raw」の中身（テキストの Raw は `useDiffContent`）。 */
export interface ReviewViewContent {
	/** 表示: ファイルビューアの部品に渡す中身。 */
	readonly render?: FileContent;
	/** 画像の差分: 変更前・変更後（base64。その側に無ければ undefined）。 */
	readonly images?: { readonly before: string | undefined; readonly after: string | undefined };
	/** Excel・Word の差分: PC が描いた HTML。 */
	readonly html?: string;
	/** Excel・Word の Raw: セルの値・段落の比較の行。 */
	readonly rows?: readonly DiffRow[];
	/** Raw を上限（`MAX_RAW_LINES`）で打ち切った（先頭だけを比べた）。 */
	readonly rowsCapped?: boolean;
	readonly error?: string;
}

export interface ReviewViewState {
	/** まだ読み込んでいなければ undefined。 */
	readonly content: ReviewViewContent | undefined;
	/** Excel の表示でシートを選ぶ。 */
	readonly selectSheet: (index: number) => void;
}

interface FileAtReply {
	readonly data?: string;
	readonly missing?: boolean;
}

/** その側の中身（base64）。その側に無ければ undefined。`scm.file-at.v1` の PC だけに送る。 */
async function fileAt(pcId: string | undefined, ws: string, path: string, side: ReviewSide): Promise<string | undefined> {
	if (side === 'missing') {
		return undefined;
	}
	const reply = await sendPcRequest<FileAtReply>(pcId, 'scm', { t: 'fileAt', ws, path, side, responseEncoding: FS_BINARY_RESPONSE_ENCODING }, { timeoutMs: 120_000 });
	return reply.missing === true ? undefined : reply.data ?? '';
}

/** Office の Raw で端末の中で読む 1 つの側の上限（バイト）。超えたら Raw は出さない（端末の記憶と時間を使い切らない）。 */
export const OFFICE_RAW_MAX_BYTES = 20 * 1024 * 1024;

/** PC が置き換えた（同じ端末の次の要求が来た）要求の応答。画面は何も出さずに次の応答を待つ。 */
export const SUPERSEDED_ERROR = 'superseded';

/** base64 の長さから元のバイト数を見積もる（デコードする前に大きさを確かめる）。 */
export function base64ByteLength(base64: string): number {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return Math.floor(base64.length * 3 / 4) - padding;
}

/** 次の描画を待つ（重い処理の前に「読み込み中」を先に出す）。 */
function afterInteractions(): Promise<void> {
	return new Promise(resolve => {
		InteractionManager.runAfterInteractions(() => setTimeout(resolve, 0));
	});
}

const TOO_LARGE_RAW = '大きすぎるため Raw は出せません（片側 20MB まで）';

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/**
 * 差分の画面の見方ごとの中身を読む。見方・ファイル・中身の識別が変わったら読み直し、前の結果は出さない。
 * 作業ツリーの側はファイルビューアと同じ要求（`fsRead` / `fsMedia` / `fsXlsx` / `fsDocx`）、それ以外の側は `fileAt`。
 * テキストの Raw は読まない（`useDiffContent` が `git diff` を読む）。
 */
export function useReviewView(space: CodeSpace, path: string | undefined, kind: ReviewContentKind, mode: ReviewViewMode, sides: ReviewSides, identity: string | undefined, officeRaw: boolean): ReviewViewState {
	const { fsRead, fsXlsx, fsDocx, fsMedia, scmXlsxDiff } = useAppStore(useShallow(s => ({ fsRead: s.fsRead, fsXlsx: s.fsXlsx, fsDocx: s.fsDocx, fsMedia: s.fsMedia, scmXlsxDiff: s.scmXlsxDiff })));
	const { pcId, wsId, rendererTarget } = space;
	const [sheet, setSheet] = useState<number | undefined>(undefined);
	const key = `${wsId ?? ''}\0${path ?? ''}\0${mode}\0${identity ?? ''}\0${sides.before}\0${sides.after}\0${sheet ?? ''}`;
	const [loaded, setLoaded] = useState<{ readonly key: string; readonly content: ReviewViewContent } | undefined>(undefined);
	const pathRef = useRef(path);
	if (pathRef.current !== path) {
		pathRef.current = path;
		if (sheet !== undefined) {
			setSheet(undefined);
		}
	}
	const wanted = path !== undefined && kind !== 'text' && (mode !== 'raw' || officeRaw);

	useEffect(() => {
		if (!wanted || path === undefined || wsId === undefined || rendererTarget === undefined) {
			return undefined;
		}
		let cancelled = false;
		const current = () => !cancelled && currentRendererTarget(wsId) === rendererTarget;
		const renderSide = reviewRenderSide(sides);
		const load = async (): Promise<ReviewViewContent> => {
			if (mode === 'render') {
				switch (kind) {
					case 'markdown':
					case 'html': {
						if (renderSide === 'worktree') {
							return { render: { text: await fsRead(wsId, path, false) } };
						}
						const data = await fileAt(pcId, wsId, path, renderSide);
						const content = data !== undefined ? decodeUtf8(base64ToBytes(data)) : '';
						return { render: { text: { content, truncated: false, size: content.length } } };
					}
					case 'image':
					case 'docx': {
						if (renderSide === 'worktree') {
							const response = kind === 'image' ? await fsMedia(wsId, path) : await fsDocx(wsId, path);
							return { render: { binary: response.data } };
						}
						return { render: { binary: await fileAt(pcId, wsId, path, renderSide) ?? '' } };
					}
					case 'spreadsheet': {
						const response = await fsXlsx(wsId, path, sheet);
						return { render: { xlsx: { html: response.html, sheets: response.sheets, sheet: response.sheet } } };
					}
				}
				return {};
			}
			if (mode === 'diff') {
				if (kind === 'image') {
					const [before, after] = await Promise.all([fileAt(pcId, wsId, path, sides.before), fileAt(pcId, wsId, path, sides.after)]);
					return { images: { before, after } };
				}
				if (kind === 'spreadsheet') {
					return { html: (await scmXlsxDiff(wsId, path)).html };
				}
				const reply = await sendPcRequest<{ readonly html?: string }>(pcId, 'scm', { t: 'wordDiff', ws: wsId, path, original: sides.before, modified: sides.after }, { timeoutMs: 120_000 });
				return { html: reply.html ?? '' };
			}
			// Office の Raw: 両側のバイト列を受け取り、端末の中でセルの値・段落を比べる
			const [before, after] = await Promise.all([fileAt(pcId, wsId, path, sides.before), fileAt(pcId, wsId, path, sides.after)]);
			if ((before !== undefined && base64ByteLength(before) > OFFICE_RAW_MAX_BYTES) || (after !== undefined && base64ByteLength(after) > OFFICE_RAW_MAX_BYTES)) {
				return { error: TOO_LARGE_RAW };
			}
			// 展開と比較は JS の上で重いので、「読み込み中」を描き終えてから始める
			await afterInteractions();
			if (!current()) {
				return {};
			}
			const result = officeRawDiff(kind === 'docx' ? 'docx' : 'spreadsheet', {
				before: before !== undefined ? base64ToBytes(before) : undefined,
				after: after !== undefined ? base64ToBytes(after) : undefined,
			});
			return result.kind === 'rows' ? { rows: result.rows, rowsCapped: result.capped }
				: result.kind === 'tooLarge' ? { error: TOO_LARGE_RAW }
					: { error: 'ファイルの中身を読み取れませんでした' };
		};
		load()
			.then(content => { if (current()) { setLoaded({ key, content }); } })
			.catch((e: unknown) => {
				// 置き換えられた要求（同じ端末から次の Word 差分を頼んだ）は、次の応答を待つだけで何も出さない
				if (current() && errorMessage(e) !== SUPERSEDED_ERROR) {
					setLoaded({ key, content: { error: errorMessage(e) } });
				}
			});
		return () => { cancelled = true; };
		// sides は before / after を key に含めている
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, wanted, rendererTarget, fsRead, fsXlsx, fsDocx, fsMedia, scmXlsxDiff, pcId]);

	const selectSheet = useCallback((index: number) => setSheet(index), []);
	return { content: loaded?.key === key ? loaded.content : undefined, selectSheet };
}
