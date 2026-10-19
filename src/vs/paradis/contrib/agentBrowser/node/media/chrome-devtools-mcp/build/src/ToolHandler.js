/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { logger } from './logger.js';
import { McpResponse } from './McpResponse.js';
import { SlimMcpResponse } from './SlimMcpResponse.js';
import { ClearcutLogger } from './telemetry/ClearcutLogger.js';
import { bucketizeLatency } from './telemetry/transformation.js';
import { zod } from './third_party/index.js';
import { labels, OFF_BY_DEFAULT_CATEGORIES } from './tools/categories.js';
import { pageIdSchema } from './tools/ToolDefinition.js';
export function buildFlag(category) {
    return `category${category.charAt(0).toUpperCase() + category.slice(1)}`;
}
function buildDisabledMessage(toolName, flag, categoryLabel) {
    const reason = categoryLabel
        ? `is in category ${categoryLabel} which`
        : `requires experimental feature ${flag} and`;
    return `Tool ${toolName} ${reason} is currently disabled. Enable it by running chrome-devtools start ${flag}=true. For more information check the README.`;
}
function getCategoryStatus(category, serverArgs) {
    const categoryFlag = buildFlag(category);
    const flagValue = serverArgs[categoryFlag];
    const isDisabled = OFF_BY_DEFAULT_CATEGORIES.includes(category)
        ? !flagValue
        : flagValue === false;
    if (isDisabled) {
        return {
            categoryFlag,
            disabled: true,
        };
    }
    return {
        disabled: false,
    };
}
function getConditionStatus(condition, serverArgs) {
    if (condition && !serverArgs[condition]) {
        return { conditionFlag: condition, disabled: true };
    }
    return { disabled: false };
}
function getToolStatusInfo(tool, serverArgs) {
    const category = tool.annotations.category;
    const categoryCheck = getCategoryStatus(category, serverArgs);
    if (category && categoryCheck.disabled) {
        if (!categoryCheck.categoryFlag) {
            throw new Error('when the category is disabled there should always be a flag set');
        }
        return {
            disabled: true,
            reason: buildDisabledMessage(tool.name, `--${categoryCheck.categoryFlag}`, labels[category]),
        };
    }
    for (const condition of tool.annotations.conditions || []) {
        const conditionCheck = getConditionStatus(condition, serverArgs);
        if (conditionCheck.disabled) {
            if (!conditionCheck.conditionFlag) {
                throw new Error('when the condition is disabled there should always be a flag set');
            }
            return {
                disabled: true,
                reason: buildDisabledMessage(tool.name, `--${conditionCheck.conditionFlag}`),
            };
        }
    }
    return { disabled: false };
}
function isPageScopedTool(tool) {
    return 'pageScoped' in tool && tool.pageScoped === true;
}
function formatArgumentNames(names) {
    return names.map(name => `"${name}"`).join(', ');
}
function buildUnknownArgumentsMessage(toolName, unknownArgumentNames, expectedArgumentNames) {
    const unknownLabel = unknownArgumentNames.length === 1 ? 'argument' : 'arguments';
    const expectedArguments = expectedArgumentNames.length
        ? `Expected arguments: ${formatArgumentNames(expectedArgumentNames)}.`
        : 'This tool does not accept any arguments.';
    const correction = unknownArgumentNames.length === 1 ? 'Remove it' : 'Remove them';
    return `Unknown ${unknownLabel} for tool "${toolName}": ${formatArgumentNames(unknownArgumentNames)}. ${expectedArguments} ${correction} and retry.`;
}
export class ToolHandler {
    // PARA-PATCH (Para Code): see handle below (a static so tests can shorten it).
    static paraCodeTimeoutGraceMs = 10000;
    tool;
    serverArgs;
    getContext;
    toolMutex;
    inputSchema;
    registeredInputSchema;
    shouldRegister;
    disabledReason;
    constructor(tool, serverArgs, getContext, toolMutex) {
        this.tool = tool;
        this.serverArgs = serverArgs;
        this.getContext = getContext;
        this.toolMutex = toolMutex;
        const { disabled, reason } = getToolStatusInfo(tool, serverArgs);
        this.disabledReason = reason;
        this.shouldRegister = !(disabled && !serverArgs.viaCli);
        this.inputSchema =
            'pageScoped' in tool &&
                tool.pageScoped &&
                serverArgs.experimentalPageIdRouting &&
                !serverArgs.slim
                ? { ...pageIdSchema, ...tool.schema }
                : tool.schema;
        this.registeredInputSchema = zod.object(this.inputSchema).passthrough();
    }
    unknownArgumentNames(params) {
        return Object.keys(params).filter(key => !Object.hasOwn(this.inputSchema, key));
    }
    // PARA-PATCH (Para Code): give up on the call after params.paraCodeTimeoutMs (an internal argument Para Code sets on
    // evaluate_script and take_snapshot; never published in tools/list) plus a short grace, counted from when the call
    // holds the tool mutex, and release the mutex then. A page that does not answer otherwise held this tab's tools for
    // puppeteer's 180 s protocol timeout. evaluate_script gives up by itself at paraCodeTimeoutMs (tools/script.js); the
    // grace keeps this a backstop for it. The abandoned call settles later on its own: its result is dropped and its
    // response does not replace the page's text snapshot (McpResponse.handle). See NOTES.md "vendored chrome-devtools-mcp への変更".
    async handle(params) {
        const timeoutMs = params?.paraCodeTimeoutMs;
        if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) {
            return await this.paraCodeHandleWithoutTimeout(params);
        }
        const waitMs = timeoutMs + ToolHandler.paraCodeTimeoutGraceMs;
        const timedOut = Promise.withResolvers();
        let guard;
        let released = false;
        let abandoned = false;
        let timer;
        const release = () => {
            if (guard && !released) {
                released = true;
                guard.dispose();
            }
        };
        try {
            return await Promise.race([
                this.paraCodeHandleWithoutTimeout(params, acquired => {
                    guard = acquired;
                    timer = setTimeout(() => {
                        abandoned = true;
                        timedOut.resolve({ content: [{ type: 'text', text: `PARA_BROWSER_PAGE_UNRESPONSIVE: ${this.tool.name} did not finish within ${waitMs} ms.` }], isError: true });
                    }, waitMs);
                    return { dispose: release, paraCodeAbandoned: () => abandoned };
                }),
                timedOut.promise,
            ]);
        }
        finally {
            clearTimeout(timer);
            release();
        }
    }
    async paraCodeHandleWithoutTimeout(params, paraCodeOnAcquired) {
        if (this.disabledReason) {
            return {
                content: [
                    {
                        type: 'text',
                        text: this.disabledReason,
                    },
                ],
                isError: true,
            };
        }
        const unknownArgumentNames = this.unknownArgumentNames(params);
        if (unknownArgumentNames.length) {
            return {
                content: [
                    {
                        type: 'text',
                        text: buildUnknownArgumentsMessage(this.tool.name, unknownArgumentNames, Object.keys(this.inputSchema)),
                    },
                ],
                isError: true,
            };
        }
        // PARA-PATCH (Para Code): see handle above.
        const acquiredGuard = await this.toolMutex.acquire();
        const guard = paraCodeOnAcquired ? paraCodeOnAcquired(acquiredGuard) : acquiredGuard;
        const startTime = Date.now();
        let success = false;
        try {
            logger?.(`${this.tool.name} request: ${JSON.stringify(params, null, '  ')}`);
            const context = await this.getContext();
            logger?.(`${this.tool.name} context: resolved`);
            await context.detectOpenDevToolsWindows();
            const response = this.serverArgs.slim
                ? new SlimMcpResponse(this.serverArgs)
                : new McpResponse(this.serverArgs);
            response.setRedactNetworkHeaders(this.serverArgs.redactNetworkHeaders);
            // PARA-PATCH (Para Code): see handle above.
            response.paraCodeAbandoned = guard.paraCodeAbandoned;
            try {
                if (this.tool.verifyFilesSchema) {
                    for (const key of this.tool.verifyFilesSchema) {
                        const filePath = params[key];
                        await context.validatePath(filePath);
                    }
                }
                if (isPageScopedTool(this.tool)) {
                    const pageId = typeof params.pageId === 'number' ? params.pageId : undefined;
                    const page = this.serverArgs.experimentalPageIdRouting &&
                        pageId !== undefined &&
                        !this.serverArgs.slim
                        ? context.getPageById(pageId)
                        : context.getSelectedMcpPage();
                    response.setPage(page);
                    if (this.tool.blockedByDialog) {
                        page.throwIfDialogOpen();
                    }
                    await this.tool.handler({
                        params,
                        page,
                    }, response, context);
                }
                else {
                    await this.tool.handler({
                        params,
                    }, response, context);
                }
            }
            catch (err) {
                response.setError(err);
            }
            const { content, structuredContent } = await response.handle(this.tool.name, context, this.serverArgs.experimentalToonFormat ?? false);
            const result = {
                content,
            };
            if (response.error) {
                result.isError = true;
            }
            success = true;
            if (this.serverArgs.experimentalStructuredContent) {
                result.structuredContent = structuredContent;
            }
            return result;
        }
        catch (err) {
            logger?.(`${this.tool.name} error:`, err, err?.stack);
            let errorText = err && 'message' in err ? err.message : String(err);
            if ('cause' in err && err.cause) {
                errorText += `\nCause: ${err.cause.message}`;
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: errorText,
                    },
                ],
                isError: true,
            };
        }
        finally {
            void ClearcutLogger.get()?.logToolInvocation({
                toolName: this.tool.name,
                params,
                schema: this.inputSchema,
                success,
                latencyMs: bucketizeLatency(Date.now() - startTime),
            });
            guard.dispose();
        }
    }
}
//# sourceMappingURL=ToolHandler.js.map