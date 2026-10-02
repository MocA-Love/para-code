// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { NEUTRAL_CHAT_TEXT_SCALE, chatTextScaleFor, scaleChatSize, scaleChatStyles, type ChatFontSize, type ChatTextScale } from '../chatTextScale.js';

/**
 * 会話表示の文字サイズを部品へ配る（計算は `src/chatTextScale.ts`）。
 *
 * 効かせる範囲を `ChatTextScaleProvider` の内側に限るため、Context で配る。Markdown・ツールの中身などの
 * 部品は会話以外（会話の履歴の画面・サブエージェントの画面）でも使っており、そちらは Provider の外なので
 * 倍率は無変化（元の表がそのまま返る）。
 *
 * ここでは端末の保存領域もストアも import しない（`src/components/` の部品からも使うため）。
 * いまの設定を読むのは Provider を置く側（`AgentChatPane`）。
 */
const ChatTextScaleContext = createContext<ChatTextScale>(NEUTRAL_CHAT_TEXT_SCALE);

/** 内側の会話の部品に、設定の文字サイズを効かせる。設定を変えるとその場で描き直される。 */
export function ChatTextScaleProvider({ size, children }: { size: ChatFontSize; children: ReactNode }) {
	const value = useChatTextScaleFor(size);
	return <ChatTextScaleContext.Provider value={value}>{children}</ChatTextScaleContext.Provider>;
}

/** 設定の値から倍率を作る（OS の文字サイズが変わったら作り直す）。設定のシートの見本でも使う。 */
export function useChatTextScaleFor(size: ChatFontSize): ChatTextScale {
	const { fontScale } = useWindowDimensions();
	return useMemo(() => chatTextScaleFor(size, fontScale), [size, fontScale]);
}

/** いまの倍率（Provider の外では無変化）。 */
export function useChatTextScale(): ChatTextScale {
	return useContext(ChatTextScaleContext);
}

/**
 * `StyleSheet.create` の表に会話の倍率をかけたもの。部品の中で `const styles = useChatStyles(baseStyles)`
 * のように使う。表と倍率の組ごとに使い回すので、行ごとに呼んでも作り直さない。
 */
export function useChatStyles<T extends { readonly [key: string]: object }>(styles: T): T {
	return scaleChatStyles(styles, useChatTextScale());
}

/** 文字の横に置くアイコンの大きさに倍率をかける。 */
export function useChatIconSize(size: number): number {
	return scaleChatSize(size, useChatTextScale());
}
