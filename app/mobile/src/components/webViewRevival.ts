// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useState } from 'react';

/**
 * iOS がメモリ不足で WebView の中身のプロセスを落としたときに、WebView を作り直すための世代。
 * 落ちたまま放っておくと、その画面は白紙のまま戻らない（`onContentProcessDidTerminate` を受けて
 * 世代を進め、WebView の `key` に混ぜる）。ターミナル（`termView.tsx`）は自前で読み直す。
 */
export function useWebViewRevival(): { readonly generation: number; readonly onContentProcessDidTerminate: () => void } {
	const [generation, setGeneration] = useState(0);
	const onContentProcessDidTerminate = useCallback(() => setGeneration(value => value + 1), []);
	return { generation, onContentProcessDidTerminate };
}
