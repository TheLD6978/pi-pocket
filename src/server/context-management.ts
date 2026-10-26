/** Conversation-bound extension state, effective history, and accounted auxiliary model requests. */
import { createHash, randomUUID } from "node:crypto";
import type { Context, Draft } from "@earendil-works/chord";
import {
    awaitWithContext,
    BACKGROUND_CONTEXT,
    withAbortSignal,
} from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
    AgentDoc,
    ProviderDoc,
    UsageDoc,
    type ConversationDocToken,
    type ConversationId,
    type ContextView,
    type Cursor,
    type EntryId,
    type EntryQuery,
    type EntryRecord,
    type JsonObject,
    type ModelRef,
    type Page,
    type TaskId,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { ContextRequestsDoc, SpendDoc, TurnsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import type { HistoryAccess } from "./history.ts";
import type { RequestActor } from "./extension-request.ts";
import { isThinkingLevel, levelAtMost, resolveModel, THINKING_LEVELS } from "./models.ts";
import { noWait } from "./limit-gate.ts";

export interface ContextSummaryOptions {
    messages: readonly Message[];
    model?: string;
    thinking?: ModelThinkingLevel;
    maxTokens?: number;
    timeoutMs?: number;
    onProgress?: (receivedChars: number) => void;
}
export interface ContextSummary {
    response: AssistantMessage;
    model: ModelRef;
    id: string;
    interrupted?: boolean;
}
export interface ContextManagementCapability {
    readonly conversationId: ConversationId;
    readonly history: HistoryAccess;
    context(options?: { at?: EntryId }): Promise<ContextView>;
    entries(
        query?: Omit<EntryQuery, "conversationId">,
        limit?: number,
        cursor?: Cursor,
    ): Promise<Page<EntryRecord, Cursor>>;
    update<T extends JsonObject, R>(
        document: ConversationDocToken<T>,
        change: (draft: Draft<T>) => R | Promise<R>,
        options?: { expectedTail?: EntryId | null },
    ): Promise<R>;
    summaryUsage(key: string): Promise<{ id: string; usage: Usage } | undefined>;
    summarize(
        key: string,
        request: ContextSummaryOptions,
        signal?: AbortSignal,
    ): Promise<ContextSummary>;
}
export interface ContextManagementApi {
    forTask(taskId: TaskId, context: Context): Promise<ContextManagementCapability>;
}
const MAX_DOCUMENT = 8_000_000;
const MAX_REQUEST = 2_000_000;
const MAX_RECEIPTS = 1000;
const MAX_LEDGER = 16_000_000;
const MAX_RESPONSE = 512_000;
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const receiptToken = (source: ConversationId, key: string): string => {
    if (typeof key !== "string" || key.length < 1 || key.length > 512) {
        throw new HttpError(400, "A summary key has 1–512 characters.");
    }

    return createHash("sha256").update(`${source}:${key}`).digest("hex");
};

const fingerprintOf = (request: ContextSummaryOptions): string =>
    createHash("sha256")
        .update(
            JSON.stringify({
                messages: request.messages,
                model: request.model,
                thinking: request.thinking,
                maxTokens: request.maxTokens,
            }),
        )
        .digest("hex");

/** Core owns the payer, permissions, model policy and request receipts; extensions own pruning. */
export class ContextManagement implements ContextManagementApi {
    readonly #app: PocketApp;
    readonly #pending = new Map<
        string,
        { by: string; fingerprint: string; promise: Promise<ContextSummary> }
    >();
    constructor(app: PocketApp) {
        this.#app = app;
    }

    async forTask(taskId: TaskId, context: Context): Promise<ContextManagementCapability> {
        const task = await this.#app.harness.getTask(taskId, context);

        if (task === undefined || task.state.status === "terminal" || task.abortRequested) {
            throw new HttpError(409, "The originating task is no longer active.");
        }

        const by = this.#app.attribution.requesterOf(task.conversationId);

        if (by === undefined) {
            throw new HttpError(403, "This task has no requester.");
        }

        return this.#bind(task.conversationId, by, context, undefined, undefined, taskId);
    }

    forRequest(
        source: ConversationId,
        actor: RequestActor,
        module: string,
    ): ContextManagementCapability {
        return this.#bind(source, actor.current().id, actor.context, module, actor);
    }

    forCommand(
        source: ConversationId,
        by: string,
        taskId: TaskId,
        context: Context,
        module: string,
    ): ContextManagementCapability {
        return this.#bind(source, by, context, module, undefined, taskId);
    }

    #bind(
        source: ConversationId,
        by: string,
        context: Context,
        module?: string,
        actor?: RequestActor,
        taskId?: TaskId,
    ): ContextManagementCapability {
        const app = this.#app;

        const current = (): User => {
            context.abortSignal?.throwIfAborted();
            const user = actor?.current() ?? app.config.userById(by);

            if (user === undefined) {
                throw new HttpError(403, "The requester no longer has access.");
            }

            app.requireSee(user, source);

            return user;
        };

        const authorize = async (tx: Tx, mutation: boolean): Promise<User> => {
            const user = current();

            if (taskId !== undefined) {
                const task = await tx.task(taskId);

                if (
                    task === undefined ||
                    task.conversationId !== source ||
                    task.state.status === "terminal" ||
                    task.abortRequested
                ) {
                    throw new HttpError(409, "The originating task is no longer active.");
                }
            }

            if (actor !== undefined) {
                await actor.authorize(tx, mutation);
            }

            if (mutation) {
                const turns = await tx.doc(TurnsDoc, app.rootOf(source));

                app.requireSteer(current());

                if (turns.on && turns.driver !== user.id) {
                    throw new HttpError(409, "Take the wheel first.");
                }
            }

            current();

            return user;
        };

        const check = async (): Promise<void> => {
            await app.harness.commit((tx) => authorize(tx, false), context);
        };

        const history = app.history.bind({ source, by, context, check, current });

        return Object.freeze({
            conversationId: source,
            history,
            context: async (options?: { at?: EntryId }) => {
                await check();
                const result = await (await app.conversation(source)).context(context, options);

                await check();

                return result;
            },
            entries: async (
                query: Omit<EntryQuery, "conversationId"> = {},
                limit = 256,
                cursor?: Cursor,
            ) => {
                if (
                    !Number.isInteger(limit) ||
                    limit < 1 ||
                    limit > 256 ||
                    "conversationId" in query
                ) {
                    throw new HttpError(
                        400,
                        "History pages contain 1–256 entries of this conversation.",
                    );
                }

                return history.entries({ ...query, conversationId: source }, limit, cursor);
            },
            update: async <T extends JsonObject, R>(
                document: ConversationDocToken<T>,
                change: (draft: Draft<T>) => R | Promise<R>,
                options?: { expectedTail?: EntryId | null },
            ): Promise<R> => {
                const definition = document.definition;

                if (
                    definition.scope !== "conversation" ||
                    !definition.kind.startsWith(module === undefined ? "x." : `x.${module}.`) ||
                    "family" in definition
                ) {
                    throw new HttpError(
                        403,
                        "Only this module's conversation documents can be updated.",
                    );
                }

                return app.harness.commit(async (tx) => {
                    await authorize(tx, true);

                    if (options?.expectedTail !== undefined) {
                        const latest = await tx.scanEntries(
                            { conversationId: source, order: "descending" },
                            1,
                        );
                        const tail = latest.items[0]?.id ?? null;

                        if (tail !== options.expectedTail) {
                            throw new HttpError(
                                409,
                                "The source transcript changed; read it again before updating.",
                            );
                        }
                    }

                    const draft = await tx.doc(document, source);
                    const result = await change(draft);

                    if (Buffer.byteLength(JSON.stringify(draft)) > MAX_DOCUMENT) {
                        throw new HttpError(413, "The extension document is too large.");
                    }

                    await authorize(tx, true);

                    return result;
                }, context);
            },
            summaryUsage: async (key: string) => {
                const token = receiptToken(source, key);

                await check();
                const receipt = (await app.harness.snapshot(ContextRequestsDoc, source, context))
                    ?.items[token];

                await check();
                const result = receipt?.result as unknown as ContextSummary | undefined;

                return result === undefined
                    ? undefined
                    : { id: result.id, usage: clean(result.response.usage) };
            },
            summarize: async (
                key: string,
                request: ContextSummaryOptions,
                signal?: AbortSignal,
            ) => {
                const token = receiptToken(source, key);

                // Every caller must still have access, even when joining another invocation.
                await check();
                const fingerprint = fingerprintOf(request);
                const pending = this.#pending.get(token);

                if (pending !== undefined) {
                    if (pending.by !== by || pending.fingerprint !== fingerprint) {
                        throw new HttpError(
                            409,
                            "This summary key belongs to a different request.",
                        );
                    }

                    const joined = await awaitWithContext(
                        pending.promise,
                        signal === undefined ? context : withAbortSignal(signal, context),
                    );

                    await check();

                    return joined;
                }

                const run = this.#summarize(
                    source,
                    by,
                    token,
                    request,
                    context,
                    authorize,
                    actor,
                    signal,
                );

                this.#pending.set(token, { by, fingerprint, promise: run });

                try {
                    const result = await run;

                    await check();

                    return result;
                } finally {
                    this.#pending.delete(token);
                }
            },
        });
    }

    async #summarize(
        source: ConversationId,
        by: string,
        token: string,
        request: ContextSummaryOptions,
        parent: Context,
        authorize: (tx: Tx, mutation: boolean) => Promise<User>,
        actor?: RequestActor,
        signal?: AbortSignal,
    ): Promise<ContextSummary> {
        const app = this.#app;

        if (
            request.timeoutMs !== undefined &&
            (!Number.isInteger(request.timeoutMs) ||
                request.timeoutMs < 1 ||
                request.timeoutMs > 600000)
        ) {
            throw new HttpError(400, "Summary timeoutMs must be 1–600000.");
        }

        const deadline =
            request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs);
        const signals = [parent.abortSignal, signal, deadline].filter(
            (s): s is AbortSignal => s !== undefined,
        );
        const stopped =
            signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals);
        const context = withAbortSignal(stopped, parent);

        stopped.throwIfAborted();
        const fingerprint = fingerprintOf(request);

        if (Buffer.byteLength(JSON.stringify(request.messages)) > MAX_REQUEST) {
            throw new HttpError(413, "The summary input is too large.");
        }

        const before = (await app.harness.snapshot(ContextRequestsDoc, source, context))?.items[
            token
        ];

        if (before !== undefined) {
            if (before.by !== by || before.fingerprint !== fingerprint) {
                throw new HttpError(409, "This summary key belongs to a different request.");
            }

            if (before.result !== undefined) {
                return clean(before.result) as unknown as ContextSummary;
            }

            const model = before.model;
            const known = app.models.getModel(model.provider, model.modelId);

            const interrupted: ContextSummary = {
                id: before.id,
                model,
                interrupted: true,
                response: this.#failed(
                    model,
                    known?.api ?? "openai-completions",
                    "A restart interrupted this summary; it was not resent.",
                    true,
                ),
            };

            // Settle the unknown outcome without inventing usage, and release its reserved space.
            await app.harness.commit(async (tx) => {
                const receipt = (await tx.doc(ContextRequestsDoc, source)).items[token]!;

                receipt.result ??= clean(interrupted) as unknown as JsonObject;
            }, BACKGROUND_CONTEXT);

            return interrupted;
        }

        const agent = await app.agentState(source);
        const selected = agent?.model;
        const spec = request.model ?? (selected && `${selected.provider}/${selected.modelId}`);

        if (spec === undefined || !spec.includes("/")) {
            throw new HttpError(400, "Select an exact provider/modelId first.");
        }

        const same = spec === (selected && `${selected.provider}/${selected.modelId}`);

        if (!same && !app.config.subagentModels.includes(spec)) {
            throw new HttpError(403, "This summary model is not allowed.");
        }

        const ref = resolveModel(app.models, spec, app.signInNeeded);
        const model = app.models.getModel(ref.provider, ref.modelId)!;
        const thinking = request.thinking ?? agent?.thinkingLevel ?? "off";

        if (
            !isThinkingLevel(thinking) ||
            THINKING_LEVELS.indexOf(thinking) >
                THINKING_LEVELS.indexOf(agent?.thinkingLevel ?? "off") ||
            levelAtMost(model, thinking) !== thinking
        ) {
            throw new HttpError(400, "The summary thinking level is not allowed.");
        }

        if (
            request.maxTokens !== undefined &&
            (!Number.isInteger(request.maxTokens) ||
                request.maxTokens < 1 ||
                request.maxTokens > 32768)
        ) {
            throw new HttpError(400, "Summary maxTokens must be 1–32768.");
        }

        const problem = await app.providers.problem(ref, true);

        if (problem !== undefined) {
            throw new HttpError(400, `The summary model cannot be used: ${problem}`);
        }

        // Reuse this check both for the durable intent and immediately before provider admission.
        const authorizeSummary = async (tx: Tx): Promise<void> => {
            const user = await authorize(tx, true);
            const fresh = await tx.doc(AgentDoc, source);

            actor?.checkSource(fresh);

            if (
                JSON.stringify(fresh.model) !== JSON.stringify(selected) ||
                fresh.thinkingLevel !== agent?.thinkingLevel ||
                (!same && !app.config.subagentModels.includes(spec))
            ) {
                throw new HttpError(409, "The source model policy changed.");
            }

            app.spend.check(user, source);
        };

        const id = randomUUID();
        const admitted = await app.harness.commit(async (tx) => {
            await authorizeSummary(tx);
            const ledger = await tx.doc(ContextRequestsDoc, source);

            if (ledger.items[token] !== undefined) {
                return false;
            }

            // Reserve bounded response space for every unfinished request, so concurrent
            // requests cannot all admit against the same free storage.
            const reserved =
                Object.values(ledger.items).filter((item) => item.result === undefined).length *
                MAX_RESPONSE;

            if (
                Object.keys(ledger.items).length >= MAX_RECEIPTS ||
                Buffer.byteLength(JSON.stringify(ledger)) + reserved + MAX_RESPONSE + 1024 >
                    MAX_LEDGER
            ) {
                throw new HttpError(
                    413,
                    "This conversation has reached its auxiliary request limit.",
                );
            }

            ledger.items[token] = { id, by, model: ref, fingerprint };

            return true;
        }, context);

        if (!admitted) {
            throw new HttpError(
                409,
                "This summary was admitted concurrently; retry to read its receipt.",
            );
        }

        let response: AssistantMessage;
        let reported: AssistantMessage | undefined;

        try {
            const sessionId = await app.harness.commit(async (tx) => {
                await authorizeSummary(tx);

                return (await tx.doc(ProviderDoc, source)).sessionId;
            }, context);
            const events = app.models.streamSimple(
                model,
                { messages: clean([...request.messages]) },
                // Auxiliary summaries must finish without an invisible provider-limit wait.
                noWait({
                    ...app.streamSettings(),
                    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
                    sessionId,
                    maxTokens: Math.min(
                        request.maxTokens ?? 4096,
                        model.maxTokens > 0 ? model.maxTokens : 4096,
                    ),
                    ...(thinking === "off" ? {} : { reasoning: thinking }),
                    cacheRetention: "none",
                    signal: stopped,
                }),
            );

            for await (const event of events) {
                reported =
                    event.type === "error"
                        ? event.error
                        : event.type === "done"
                          ? event.message
                          : event.partial;

                if (event.type === "text_delta") {
                    try {
                        request.onProgress?.(
                            event.partial.content
                                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                                .join("").length,
                        );
                    } catch {
                        /* Progress cannot change billing or request success. */
                    }
                }
            }

            response = await events.result();
        } catch (error) {
            response = {
                ...this.#failed(
                    ref,
                    model.api,
                    error instanceof Error ? error.message : "The summary request failed.",
                    stopped.aborted,
                ),
                ...(reported === undefined ? {} : { usage: reported.usage }),
            };
        }

        // A provider's maxTokens is not a storage bound. Discard an oversized response,
        // but preserve and account its actual reported usage.
        if (Buffer.byteLength(JSON.stringify(response)) > MAX_RESPONSE - 1024) {
            response = {
                ...this.#failed(
                    ref,
                    model.api,
                    "The auxiliary response exceeded its storage limit and was discarded.",
                    false,
                ),
                usage: response.usage,
            };
        }

        const result: ContextSummary = { id, model: ref, response };

        // Billing and the durable response must survive caller cancellation and loss of access.
        await app.harness.commit(async (tx) => {
            const ledger = await tx.doc(ContextRequestsDoc, source);
            const receipt = ledger.items[token];

            if (receipt === undefined) {
                throw new Error("The admitted summary receipt is missing.");
            }

            if (receipt.result !== undefined) {
                return;
            }

            const usage = await tx.doc(UsageDoc, source);
            const spend = await tx.doc(SpendDoc);
            const bucket = `${ref.provider}/${ref.modelId}`;
            const previous = usage.models[bucket];

            usage.models[bucket] =
                previous === undefined ? clean(response.usage) : addUsage(previous, response.usage);
            const cost = response.usage.cost.total;

            spend.people[by] = (spend.people[by] ?? 0) + cost;
            spend.counted[String(source)] = (spend.counted[String(source)] ?? 0) + cost;
            receipt.result = clean(result) as unknown as JsonObject;
        }, BACKGROUND_CONTEXT);

        return result;
    }

    #failed(
        model: ModelRef,
        api: AssistantMessage["api"],
        message: string,
        aborted: boolean,
    ): AssistantMessage {
        return {
            role: "assistant",
            api,
            provider: model.provider,
            model: model.modelId,
            content: [],
            stopReason: aborted ? "aborted" : "error",
            errorMessage: message,
            timestamp: this.#app.now(),
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
        };
    }
}

function addUsage(a: Usage, b: Usage): Usage {
    const result = clean(a);

    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
        result[key] += b[key];
    }

    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
        result.cost[key] += b.cost[key];
    }

    return result;
}
