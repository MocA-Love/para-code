/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 実体は common/paradisMcpConfigStatus.ts（node層に依存しない純粋なパーサ群）へ移した。
// shared process 側（node/paradisMcpSetup.ts）の既存importをそのまま生かすための再export。
export * from '../common/paradisMcpConfigStatus.js';
