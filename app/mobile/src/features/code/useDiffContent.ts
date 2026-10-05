// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { useAppStore } from '../../appState.js';
import { diffSourceOf, type DiffSource } from './diffReview.js';
import { errorMessage } from './scmModel.js';
import { currentRendererTarget, type CodeSpace } from './useCodeSpace.js';

export interface DiffContent {
	readonly source: DiffSource;
	/** `git diff` のテキスト（テキストの差分のとき）。 */
	readonly text: string | undefined;
	/** 差分が大きすぎて PC が先頭だけを送った（`text` は行の境目で切れている）。 */
	readonly truncated: boolean;
	/** PC が作った表計算の差分（HTML）。 */
	readonly html: string | undefined;
	readonly error: string | undefined;
}

interface Loaded {
	readonly key: string;
	readonly text?: string;
	readonly truncated?: boolean;
	readonly html?: string;
	readonly error?: string;
}

/**
 * 1ファイルの差分を読む（旧 `src/components/diffView.tsx` の取得処理）。ファイルが変わったら
 * 前のファイルの差分は出さない。接続し直したときは読み直すが、読み終わるまでは前回の結果を出しておく。
 *
 * `identity` は変更の中身の識別（`ScmEntry.identity`）。一覧を読み直して識別が変わった（確認した後に書き換えられた）
 * ときも読み直す。古い差分のまま「もう一度確認済みにする」を押せないようにするため（Orca W2-14）。
 */
export function useDiffContent(space: CodeSpace, path: string | undefined, staged: boolean, identity?: string): DiffContent {
	const scmDiff = useAppStore(s => s.scmDiff);
	const scmXlsxDiff = useAppStore(s => s.scmXlsxDiff);
	const source = path !== undefined ? diffSourceOf(path) : 'text';
	const key = `${space.wsId ?? ''}\0${path ?? ''}\0${staged}\0${identity ?? ''}`;
	const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
	const { wsId, rendererTarget } = space;

	useEffect(() => {
		if (path === undefined || wsId === undefined || rendererTarget === undefined) {
			return undefined;
		}
		if (source === 'officeUnavailable') {
			setLoaded({ key, error: 'この Office 形式の差分は表示できません' });
			return undefined;
		}
		let cancelled = false;
		const current = () => !cancelled && currentRendererTarget(wsId) === rendererTarget;
		const request = source === 'spreadsheet'
			? scmXlsxDiff(wsId, path).then(result => ({ key, html: result.html }))
			: scmDiff(wsId, path, staged).then(result => ({ key, text: result.diff, truncated: result.truncated === true }));
		request
			.then(result => { if (current()) { setLoaded(result); } })
			.catch((e: unknown) => { if (current()) { setLoaded({ key, error: errorMessage(e) }); } });
		return () => { cancelled = true; };
	}, [key, path, staged, source, wsId, rendererTarget, scmDiff, scmXlsxDiff]);

	const mine = loaded?.key === key ? loaded : undefined;
	return { source, text: mine?.text, truncated: mine?.truncated === true, html: mine?.html, error: mine?.error };
}
