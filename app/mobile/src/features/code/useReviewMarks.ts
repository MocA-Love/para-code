// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback } from 'react';
import { codeCacheKey, useCodeCache, useReviewMarks, type ReviewMarks } from './codeCache.js';
import type { ScmEntry } from './scmModel.js';
import type { CodeSpace } from './useCodeSpace.js';

/**
 * 差分レビューの「確認済み」の印（Orca W2-14）。
 *
 * 印は確認したときの中身の識別（`ScmEntry.identity`）と一緒に持つので、確認した後にエージェントが
 * 書き換えたファイルは「確認後に変更あり」になり、確認済みに数えない。
 */
export interface ReviewMarksController {
	readonly marks: ReviewMarks;
	/** いまの中身で確認済みにする / 外す。 */
	setReviewed(entry: ScmEntry, reviewed: boolean): void;
}

export function useReviewMarksController(space: CodeSpace): ReviewMarksController {
	const key = codeCacheKey(space.pcId, space.spaceId);
	const marks = useReviewMarks(key);
	const setReviewMark = useCodeCache(s => s.setReviewMark);

	const setReviewed = useCallback((entry: ScmEntry, reviewed: boolean) => {
		setReviewMark(key, entry.path, reviewed ? { identity: entry.identity, reviewedAt: Date.now() } : undefined);
	}, [key, setReviewMark]);

	return { marks, setReviewed };
}
