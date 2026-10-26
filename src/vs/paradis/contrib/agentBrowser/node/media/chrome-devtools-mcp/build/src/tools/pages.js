/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { logger } from '../logger.js';
import { zod } from '../third_party/index.js';
import { ToolCategory } from './categories.js';
import { CLOSE_PAGE_ERROR, definePageTool, defineTool, timeoutSchema, } from './ToolDefinition.js';
async function navigateWithInterception(page, action, allowListString, timeout) {
    const allowList = allowListString
        ? allowListString.split(',').map((p) => new URLPattern(p.trim()))
        : undefined;
    const requestHandler = (interceptedRequest) => {
        if (!interceptedRequest.isNavigationRequest()) {
            void interceptedRequest.continue();
            return;
        }
        const requestUrl = interceptedRequest.url();
        const isAllowed = allowList.some((pattern) => pattern.test(requestUrl));
        if (isAllowed) {
            void interceptedRequest.continue();
        }
        else {
            logger?.(`Blocking request to: ${requestUrl}`);
            void interceptedRequest.abort('blockedbyclient');
        }
    };
    const cleanupInterception = async () => {
        if (allowList) {
            page.pptrPage.off('request', requestHandler);
            await page.pptrPage.setRequestInterception(false).catch(error => {
                logger?.(`Failed to disable request interception`, error);
            });
        }
    };
    if (allowList) {
        await page.pptrPage.setRequestInterception(true);
        page.pptrPage.on('request', requestHandler);
    }
    try {
        await page.waitForEventsAfterAction(async () => {
            try {
                await action();
            }
            finally {
                await cleanupInterception();
            }
        }, { timeout });
    }
    finally {
        await cleanupInterception();
    }
}
// PARA-PATCH (Para Code): a navigation timeout after the main frame committed the new document is not a failure;
// the page keeps loading in the tab. Over a slow connection (an SSH-forwarded dev server) most navigations passed
// the 10 s default before the load event and were reported as "Unable to navigate", while the page was open.
// Returns the line to report, or undefined to keep the upstream line. See NOTES.md "vendored chrome-devtools-mcp への変更".
function paraCodeStillLoadingLine(error, committed, done) {
    if (!committed || error?.name !== 'TimeoutError') {
        return undefined;
    }
    return `${done}, but the page had not finished loading when the timeout passed (${error.message}). It keeps loading in the tab; this is not an error. Wait for what you need with wait_until instead of navigating or reloading again.`;
}
// PARA-PATCH (Para Code): how long handle_dialog waits for the browser to take the answer. In Para Code a beforeunload
// dialog is closed by the browser itself (it never blocks a navigation), so the record of the dialog can outlive it.
// Answering a dialog that is gone, on a page whose renderer is busy, got no reply until puppeteer's 180 s protocol
// timeout, and the error was swallowed (q.html Q461 2: 184 s per call). See NOTES.md "vendored chrome-devtools-mcp への変更".
const PARA_CODE_DIALOG_ANSWER_TIMEOUT_MS = 5000;
async function paraCodeAnswerDialog(answer) {
    let timer;
    try {
        return await Promise.race([
            answer().then(() => 'answered', err => {
                // Likely already handled by the user outside of MCP, or closed by the browser.
                logger?.(err);
                return 'gone';
            }),
            new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), PARA_CODE_DIALOG_ANSWER_TIMEOUT_MS); }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
function paraCodeUnansweredDialogLine(dialog, outcome) {
    const kind = dialog.type();
    const what = outcome === 'timeout'
        ? `The browser did not take the answer within ${PARA_CODE_DIALOG_ANSWER_TIMEOUT_MS / 1000} s (the page may be busy or frozen)`
        : 'The dialog was already closed';
    const next = kind === 'beforeunload'
        ? ' Para Code closes beforeunload dialogs by itself, so the navigation goes on without an answer; it may still be loading. Wait for the page with wait_until instead of calling handle_dialog again.'
        : ' Check the page with take_snapshot or wait_until.';
    return `${what}; the dialog is no longer recorded as open.${next}`;
}
export const listPages = defineTool(args => {
    return {
        name: 'list_pages',
        description: `Get a list of pages${args?.categoryExtensions ? ' including extension service workers' : ''} open in the browser.`,
        annotations: {
            category: ToolCategory.NAVIGATION,
            readOnlyHint: true,
        },
        schema: {},
        blockedByDialog: false,
        verifyFilesSchema: [],
        handler: async (_request, response) => {
            response.setIncludePages(true);
            response.setListThirdPartyDeveloperTools();
            response.setListWebMcpTools();
        },
    };
});
export const selectPage = defineTool({
    name: 'select_page',
    description: `Select a page as a context for future tool calls.`,
    annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
    },
    schema: {
        pageId: zod
            .number()
            .describe(`The ID of the page to select. Call ${listPages().name} to get available pages.`),
        bringToFront: zod
            .boolean()
            .optional()
            .describe('Whether to focus the page and bring it to the top.'),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, context) => {
        const page = context.getPageById(request.params.pageId);
        context.selectPage(page);
        response.setIncludePages(true);
        response.setListThirdPartyDeveloperTools();
        response.setListWebMcpTools();
        if (request.params.bringToFront) {
            await page.pptrPage.bringToFront();
        }
    },
});
export const closePage = defineTool({
    name: 'close_page',
    description: `Closes the page by its index. The last open page cannot be closed.`,
    annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: false,
    },
    schema: {
        pageId: zod
            .number()
            .describe('The ID of the page to close. Call list_pages to list pages.'),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, context) => {
        try {
            await context.closePage(request.params.pageId);
        }
        catch (err) {
            if (err.message === CLOSE_PAGE_ERROR) {
                response.appendResponseLine(err.message);
            }
            else {
                throw err;
            }
        }
        response.setIncludePages(true);
        response.setListThirdPartyDeveloperTools();
    },
});
export const newPage = defineTool(args => {
    return {
        name: 'new_page',
        description: `Open a new tab and load a URL. Use project URL if not specified otherwise.`,
        annotations: {
            category: ToolCategory.NAVIGATION,
            readOnlyHint: false,
        },
        schema: {
            url: zod.string().describe('URL to load in a new page.'),
            background: zod
                .boolean()
                .optional()
                .describe('Whether to open the page in the background without bringing it to the front. Default is false (foreground).'),
            isolatedContext: zod
                .string()
                .optional()
                .describe('If specified, the page is created in an isolated browser context with the given name. ' +
                'Pages in the same browser context share cookies and storage. ' +
                'Pages in different browser contexts are fully isolated.'),
            ...(args?.experimentalNavigationAllowlist
                ? {
                    allowList: zod
                        .string()
                        .optional()
                        .describe('Optional comma-separated list of URL patterns to allow. If provided, all other navigations will be blocked.'),
                }
                : {}),
            ...timeoutSchema,
        },
        blockedByDialog: false,
        verifyFilesSchema: [],
        handler: async (request, response, context) => {
            const page = await context.newPage(request.params.background, request.params.isolatedContext);
            await navigateWithInterception(page, () => page.pptrPage.goto(request.params.url, {
                timeout: request.params.timeout,
            }), request.params.allowList, request.params.timeout);
            response.setIncludePages(true);
            response.setListThirdPartyDeveloperTools();
        },
    };
});
export const navigatePage = definePageTool(args => {
    return {
        name: 'navigate_page',
        description: `Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.`,
        annotations: {
            category: ToolCategory.NAVIGATION,
            readOnlyHint: false,
        },
        schema: {
            type: zod
                .enum(['url', 'back', 'forward', 'reload'])
                .optional()
                .describe('Navigate the page by URL, back or forward in history, or reload.'),
            url: zod.string().optional().describe('Target URL (only type=url)'),
            ignoreCache: zod
                .boolean()
                .optional()
                .describe('Whether to ignore cache on reload.'),
            handleBeforeUnload: zod
                .enum(['accept', 'decline'])
                .optional()
                .describe('Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept.'),
            initScript: zod
                .string()
                .optional()
                .describe('A JavaScript script to be executed on each new document before any other scripts for the next navigation.'),
            ...(args?.experimentalNavigationAllowlist
                ? {
                    allowList: zod
                        .string()
                        .optional()
                        .describe('Optional comma-separated list of URL patterns to allow. If provided, all other navigations will be blocked.'),
                }
                : {}),
            ...timeoutSchema,
        },
        blockedByDialog: false,
        verifyFilesSchema: [],
        handler: async (request, response) => {
            const page = request.page;
            const options = {
                timeout: request.params.timeout,
            };
            if (!request.params.type && !request.params.url) {
                throw new Error('Either URL or a type is required.');
            }
            if (!request.params.type) {
                request.params.type = 'url';
            }
            const handleBeforeUnload = request.params.handleBeforeUnload ?? 'accept';
            const dialogHandler = (dialog) => {
                if (dialog.type() === 'beforeunload') {
                    if (handleBeforeUnload === 'accept') {
                        response.appendResponseLine(`Accepted a beforeunload dialog.`);
                        void dialog.accept();
                    }
                    else {
                        response.appendResponseLine(`Declined a beforeunload dialog.`);
                        void dialog.dismiss();
                    }
                    // We are not going to report the dialog like regular dialogs.
                    page.clearDialog();
                }
            };
            let initScriptId;
            if (request.params.initScript) {
                const { identifier } = await page.pptrPage.evaluateOnNewDocument(request.params.initScript);
                initScriptId = identifier;
            }
            page.pptrPage.on('dialog', dialogHandler);
            // PARA-PATCH (Para Code): see paraCodeStillLoadingLine. Page.frameNavigated fires when a frame commits a new
            // document (not for same-document navigations); the main frame has no parentId.
            let paraCodeCommitted = false;
            const paraCodeOnFrameNavigated = (event) => {
                if (!event.frame.parentId) {
                    paraCodeCommitted = true;
                }
            };
            page.pptrPage._client().on('Page.frameNavigated', paraCodeOnFrameNavigated);
            try {
                await navigateWithInterception(page, async () => {
                    switch (request.params.type) {
                        case 'url':
                            if (!request.params.url) {
                                throw new Error('A URL is required for navigation of type=url.');
                            }
                            try {
                                await page.pptrPage.goto(request.params.url, options);
                                response.appendResponseLine(`Successfully navigated to ${request.params.url}.`);
                            }
                            catch (error) {
                                response.appendResponseLine(paraCodeStillLoadingLine(error, paraCodeCommitted, `Navigated to ${page.pptrPage.url()}`) ?? `Unable to navigate in the selected page: ${error.message}.`);
                            }
                            break;
                        case 'back':
                            try {
                                await page.pptrPage.goBack(options);
                                response.appendResponseLine(`Successfully navigated back to ${page.pptrPage.url()}.`);
                            }
                            catch (error) {
                                response.appendResponseLine(paraCodeStillLoadingLine(error, paraCodeCommitted, 'Navigated back') ?? `Unable to navigate back in the selected page: ${error.message}.`);
                            }
                            break;
                        case 'forward':
                            try {
                                await page.pptrPage.goForward(options);
                                response.appendResponseLine(`Successfully navigated forward to ${page.pptrPage.url()}.`);
                            }
                            catch (error) {
                                response.appendResponseLine(paraCodeStillLoadingLine(error, paraCodeCommitted, 'Navigated forward') ?? `Unable to navigate forward in the selected page: ${error.message}.`);
                            }
                            break;
                        case 'reload':
                            try {
                                await page.pptrPage.reload({
                                    ...options,
                                    ignoreCache: request.params.ignoreCache,
                                });
                                response.appendResponseLine(`Successfully reloaded the page.`);
                            }
                            catch (error) {
                                response.appendResponseLine(paraCodeStillLoadingLine(error, paraCodeCommitted, 'Reloaded the page') ?? `Unable to reload the selected page: ${error.message}.`);
                            }
                            break;
                    }
                }, request.params.allowList, request.params.timeout);
            }
            finally {
                page.pptrPage.off('dialog', dialogHandler);
                page.pptrPage._client().off('Page.frameNavigated', paraCodeOnFrameNavigated);
                if (initScriptId) {
                    await page.pptrPage
                        .removeScriptToEvaluateOnNewDocument(initScriptId)
                        .catch(error => {
                        logger?.(`Failed to remove init script`, error);
                    });
                }
            }
            response.setIncludePages(true);
            response.setListThirdPartyDeveloperTools();
            response.setListWebMcpTools();
        },
    };
});
export const resizePage = definePageTool({
    name: 'resize_page',
    description: `Resizes the selected page's window so that the page has specified dimension`,
    annotations: {
        category: ToolCategory.EMULATION,
        readOnlyHint: false,
    },
    schema: {
        width: zod.number().describe('Page width'),
        height: zod.number().describe('Page height'),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, _context) => {
        const page = request.page;
        try {
            const browser = page.pptrPage.browser();
            const windowId = await page.pptrPage.windowId();
            const bounds = await browser.getWindowBounds(windowId);
            if (bounds.windowState === 'fullscreen') {
                // Have to call this twice on Ubuntu when the window is in fullscreen mode.
                await browser.setWindowBounds(windowId, { windowState: 'normal' });
                await browser.setWindowBounds(windowId, { windowState: 'normal' });
            }
            else if (bounds.windowState !== 'normal') {
                await browser.setWindowBounds(windowId, { windowState: 'normal' });
            }
        }
        catch {
            // Window APIs are not supported on all platforms
        }
        await page.pptrPage.resize({
            contentWidth: request.params.width,
            contentHeight: request.params.height,
        });
        response.setIncludePages(true);
    },
});
export const handleDialog = definePageTool({
    name: 'handle_dialog',
    description: `If a browser dialog was opened, use this command to handle it`,
    annotations: {
        category: ToolCategory.INPUT,
        readOnlyHint: false,
    },
    schema: {
        action: zod
            .enum(['accept', 'dismiss'])
            .describe('Whether to dismiss or accept the dialog'),
        promptText: zod
            .string()
            .optional()
            .describe('Optional prompt text to enter into the dialog.'),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, _context) => {
        const page = request.page;
        const dialog = page.getDialog();
        if (!dialog) {
            throw new Error('No open dialog found');
        }
        // PARA-PATCH (Para Code): answer the dialog within a few seconds (paraCodeAnswerDialog) instead of waiting for
        // puppeteer's 180 s protocol timeout, and say so when the browser did not take the answer. See paraCodeAnswerDialog.
        switch (request.params.action) {
            case 'accept': {
                const outcome = await paraCodeAnswerDialog(() => dialog.accept(request.params.promptText));
                response.appendResponseLine(outcome === 'answered' ? 'Successfully accepted the dialog' : paraCodeUnansweredDialogLine(dialog, outcome));
                break;
            }
            case 'dismiss': {
                const outcome = await paraCodeAnswerDialog(() => dialog.dismiss());
                response.appendResponseLine(outcome === 'answered' ? 'Successfully dismissed the dialog' : paraCodeUnansweredDialogLine(dialog, outcome));
                break;
            }
        }
        page.clearDialog();
        response.setIncludePages(true);
    },
});
export const getTabId = definePageTool({
    name: 'get_tab_id',
    description: `Get the tab ID of the page`,
    annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
        conditions: ['experimentalInteropTools'],
    },
    schema: {
        pageId: zod
            .number()
            .describe(`The ID of the page to get the tab ID for. Call ${listPages().name} to get available pages.`),
    },
    blockedByDialog: false,
    verifyFilesSchema: [],
    handler: async (request, response, context) => {
        const page = context.getPageById(request.params.pageId);
        const tabId = page.pptrPage._tabId;
        response.setTabId(tabId);
    },
});
//# sourceMappingURL=pages.js.map