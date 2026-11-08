// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createContext } from 'react';

/**
 * 発言のメニューの「引用して返信」の入れ口。入力欄のある会話の画面（`agentChatPane.tsx`）が一覧を包んで渡し、
 * 発言（`messageContextMenu.tsx`）はここから受け取る。渡されていない画面（過去の会話・作業の様子など）と、
 * 質問への答えを書いている間は `undefined` で、メニューに項目を出さない。
 */
export const ChatQuoteContext = createContext<((text: string) => void) | undefined>(undefined);
