// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TextInput } from 'react-native';
import { createMobileOfficeNonce } from '../../components/officeCapability.js';
import { normalizeFindQuery, parseFindMessage, stepFindIndex, type FindCommand, type FindResult } from './fileFind.js';

/** WebView へ送る操作と、その送った順の番号。 */
export interface FindRequest {
	readonly seq: number;
	readonly command: FindCommand;
}

/** ビューアの本文（`FileViewerBody`）に渡すもの。本文はこれを WebView へ流し、結果を返す。 */
export interface FileFindBinding {
	/** 検索の結果をページの他のメッセージと取り違えないための印（誤認防止。秘密ではない）。 */
	readonly token: string;
	/** 最後に送る操作（変わるたびに本文が WebView へ流す）。 */
	readonly request: FindRequest | undefined;
	/** WebView の `onMessage` の中身。検索の結果なら受け取って true。 */
	onMessage(data: string): boolean;
	/** WebView が読み込み直した（表示の切り替え・シートの切り替えなど）。今の語で探し直す。 */
	onViewLoaded(): void;
}

export interface FileFindController {
	readonly open: boolean;
	/** 探している語（打ち終わってから少し待って決まる）。 */
	readonly query: string;
	readonly result: FindResult | undefined;
	readonly inputRef: RefObject<TextInput | null>;
	readonly binding: FileFindBinding;
	/** 欄を開く（開いていれば入力欄へフォーカスを戻す）。 */
	show(): void;
	close(): void;
	toggle(): void;
	changeQuery(raw: string): void;
	/** 前後の一致へ（欄が閉じていれば開く）。 */
	step(delta: 1 | -1): void;
}

/** 打ち終わってから探し始めるまで（ms）。1文字ごとに長い本文を探し直さない。 */
const QUERY_DEBOUNCE_MS = 200;

/**
 * ファイルビューアの中の検索の状態（欄の開閉・語・件数）。WebView の中の処理は `fileFind.ts` のスクリプトがする。
 */
export function useFileFind(): FileFindController {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [result, setResult] = useState<FindResult | undefined>(undefined);
	const [request, setRequest] = useState<FindRequest | undefined>(undefined);
	const token = useMemo(() => createMobileOfficeNonce(), []);
	const inputRef = useRef<TextInput | null>(null);
	const seqRef = useRef(0);
	/** 最後に探し直した（または印を外した）操作の番号。それより前の結果は捨てる。 */
	const baseSeqRef = useRef(0);
	const queryRef = useRef('');
	queryRef.current = query;
	const resultRef = useRef(result);
	resultRef.current = result;
	const openRef = useRef(open);
	openRef.current = open;
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const issue = useCallback((command: FindCommand) => {
		const seq = ++seqRef.current;
		if (command.op !== 'select') {
			baseSeqRef.current = seq;
		}
		setRequest({ seq, command });
	}, []);

	useEffect(() => () => clearTimeout(debounceRef.current), []);

	const applyQuery = useCallback((next: string) => {
		setQuery(next);
		setResult(undefined);
		issue(next.length > 0 ? { op: 'search', query: next, index: 0 } : { op: 'clear' });
	}, [issue]);

	const show = useCallback(() => {
		if (openRef.current) {
			inputRef.current?.focus();
			return;
		}
		setOpen(true);
	}, []);

	const close = useCallback(() => {
		clearTimeout(debounceRef.current);
		setOpen(false);
		if (queryRef.current.length > 0) {
			applyQuery('');
		}
	}, [applyQuery]);

	const toggle = useCallback(() => {
		if (openRef.current) {
			close();
		} else {
			show();
		}
	}, [close, show]);

	const changeQuery = useCallback((raw: string) => {
		clearTimeout(debounceRef.current);
		const next = normalizeFindQuery(raw);
		debounceRef.current = setTimeout(() => applyQuery(next), next.length === 0 ? 0 : QUERY_DEBOUNCE_MS);
	}, [applyQuery]);

	const step = useCallback((delta: 1 | -1) => {
		if (!openRef.current) {
			show();
			return;
		}
		const current = resultRef.current;
		if (current === undefined || current.count === 0) {
			return;
		}
		issue({ op: 'select', index: stepFindIndex(current, delta) });
	}, [issue, show]);

	const onMessage = useCallback((data: string) => {
		const parsed = parseFindMessage(data, token);
		if (parsed === undefined) {
			return false;
		}
		if (parsed.seq >= baseSeqRef.current) {
			setResult(parsed);
		}
		return true;
	}, [token]);

	const onViewLoaded = useCallback(() => {
		if (queryRef.current.length > 0) {
			setResult(undefined);
			issue({ op: 'search', query: queryRef.current, index: 0 });
		}
	}, [issue]);

	const binding = useMemo<FileFindBinding>(() => ({ token, request, onMessage, onViewLoaded }), [token, request, onMessage, onViewLoaded]);
	return { open, query, result, inputRef, binding, show, close, toggle, changeQuery, step };
}
