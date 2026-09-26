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
	/** PC が作った表計算の差分（HTML）。 */
	readonly html: string | undefined;
	readonly error: string | undefined;
}

interface Loaded {
	readonly key: string;
	readonly text?: string;
	readonly html?: string;
	readonly error?: string;
}

/**
 * 1ファイルの差分を読む（旧 `src/components/diffView.tsx` の取得処理）。ファイルが変わったら
 * 前のファイルの差分は出さない。接続し直したときは読み直すが、読み終わるまでは前回の結果を出しておく。
 */
export function useDiffContent(space: CodeSpace, path: string | undefined, staged: boolean): DiffContent {
	const scmDiff = useAppStore(s => s.scmDiff);
	const scmXlsxDiff = useAppStore(s => s.scmXlsxDiff);
	const source = path !== undefined ? diffSourceOf(path) : 'text';
	const key = `${space.wsId ?? ''}\0${path ?? ''}\0${staged}`;
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
			: scmDiff(wsId, path, staged).then(result => ({ key, text: result.diff }));
		request
			.then(result => { if (current()) { setLoaded(result); } })
			.catch((e: unknown) => { if (current()) { setLoaded({ key, error: errorMessage(e) }); } });
		return () => { cancelled = true; };
	}, [key, path, staged, source, wsId, rendererTarget, scmDiff, scmXlsxDiff]);

	const mine = loaded?.key === key ? loaded : undefined;
	return { source, text: mine?.text, html: mine?.html, error: mine?.error };
}
