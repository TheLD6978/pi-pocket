/** Authorized original history for live, source-bound extension capabilities. */
import { createHash } from "node:crypto";
import { isJsonValue, type Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { StorageRequestError } from "@earendil-works/pi-durable";
import { Compile } from "typebox/compile";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { keywordTokens } from "./history-text.ts";
import type { HistorySearchBackend, HistorySearchTarget } from "./persistence.ts";
import type {
    ConversationId,
    Cursor,
    EntryId,
    EntryQuery,
    EntryRecord,
    Page,
} from "@earendil-works/pi-durable";

export const HISTORY_FIELDS = ["title", "user", "assistant", "summary", "modifiedPath"] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

export interface HistorySession {
    id: ConversationId;
    title: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    archived: boolean;
}

export interface HistoryFilter {
    conversationIds?: readonly ConversationId[];
    project?: string;
    after?: number;
    before?: number;
    archived?: boolean;
}

export interface HistoryListOptions extends HistoryFilter {
    limit?: number;
    cursor?: Cursor;
}

export interface HistorySearchOptions extends HistoryFilter {
    text: string;
    fields?: readonly HistoryField[];
    groupBy?: "entry" | "conversation";
    limit?: number;
}

export type HistoryMatchSource =
    { kind: "title" } | { kind: "entry"; entryId: EntryId; field: Exclude<HistoryField, "title"> };

export interface HistoryMatch {
    session: HistorySession;
    source: HistoryMatchSource;
    snippet: string;
}

export interface HistoryAccess {
    list(options?: HistoryListOptions): Promise<Page<HistorySession, Cursor>>;
    entries(query: EntryQuery, limit?: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
    search(options: HistorySearchOptions): Promise<readonly HistoryMatch[]>;
}

const idSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const filterSchema = {
    conversationIds: Type.Optional(Type.Array(idSchema)),
    project: Type.Optional(Type.String()),
    after: Type.Optional(Type.Number()),
    before: Type.Optional(Type.Number()),
    archived: Type.Optional(Type.Boolean()),
};
const listCheck = Compile(
    Type.Object(
        {
            ...filterSchema,
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
            cursor: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        },
        { additionalProperties: false },
    ),
);
const searchCheck = Compile(
    Type.Object(
        {
            ...filterSchema,
            text: Type.String(),
            fields: Type.Optional(
                Type.Array(Type.Union(HISTORY_FIELDS.map((field) => Type.Literal(field)))),
            ),
            groupBy: Type.Optional(
                Type.Union([Type.Literal("entry"), Type.Literal("conversation")]),
            ),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
    ),
);
const entryCheck = Compile(
    Type.Object(
        {
            conversationId: idSchema,
            minEntryId: Type.Optional(idSchema),
            maxEntryId: Type.Optional(idSchema),
            order: Type.Optional(
                Type.Union([Type.Literal("ascending"), Type.Literal("descending")]),
            ),
        },
        { additionalProperties: false },
    ),
);
const pageCursorCheck = Compile(Type.Record(Type.String(), Type.Unknown()));
const cursorCheck = Compile(
    Type.Object(
        {
            kind: Type.Literal("pocket.history.list.v1"),
            source: idSchema,
            by: Type.String(),
            filter: Type.String(),
            at: Type.Number(),
            id: idSchema,
        },
        { additionalProperties: false },
    ),
);

function fingerprint(filter: HistoryFilter): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                ids:
                    filter.conversationIds === undefined
                        ? null
                        : [...new Set(filter.conversationIds)].sort((a, b) => a - b),
                project: filter.project?.toLowerCase() ?? null,
                after: filter.after ?? null,
                before: filter.before ?? null,
                archived: filter.archived ?? null,
            }),
        )
        .digest("hex");
}

function matches(session: HistorySession, filter: HistoryFilter): boolean {
    return (
        (filter.conversationIds === undefined || filter.conversationIds.includes(session.id)) &&
        (filter.project === undefined ||
            session.cwd.toLowerCase().includes(filter.project.toLowerCase())) &&
        (filter.after === undefined || session.createdAt >= filter.after) &&
        (filter.before === undefined || session.createdAt < filter.before) &&
        (filter.archived === undefined || session.archived === filter.archived)
    );
}

/** A shared read service; each binding retains its source and authenticated caller. */
export class History {
    readonly #app: PocketApp;
    #backend: HistorySearchBackend | undefined;
    #ready = false;
    #closing: Promise<void> | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    install(backend: HistorySearchBackend | undefined): void {
        this.#backend = backend;
    }

    ready(): void {
        this.#ready = true;
    }

    close(context: Context): Promise<void> {
        this.#ready = false;
        this.#closing ??= this.#backend?.close(context) ?? Promise.resolve();

        return this.#closing;
    }

    #requireReady(): void {
        if (!this.#ready) {
            throw new HttpError(
                503,
                "Session history is not available while the server starts or closes.",
            );
        }
    }

    #shared(source: ConversationId, target: ConversationId, user: User): boolean {
        const app = this.#app;

        return (
            app.canSee(user, target) &&
            app.config.users.every(
                (person) => !app.canSee(person, source) || app.canSee(person, target),
            )
        );
    }

    /** Take IDs from Durable records, then join only the app's ordinary-session catalog. */
    async #catalog(context: Context): Promise<HistorySession[]> {
        const ids: ConversationId[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await this.#app.harness.commit(
                (tx) => tx.scanConversations({}, 256, cursor),
                context,
            );

            ids.push(...page.items.map((record) => record.id));
            cursor = page.next;
        } while (cursor !== undefined);

        const catalog = new Map(this.#app.sessions().map((session) => [session.id, session]));
        const found: HistorySession[] = [];

        for (const id of ids) {
            const meta = catalog.get(id);

            if (meta !== undefined) {
                found.push({
                    id,
                    title: meta.title ?? "New session",
                    cwd: meta.cwd,
                    createdAt: meta.createdAt,
                    updatedAt: meta.updatedAt,
                    archived: meta.archived === true,
                });
            }
        }

        return found;
    }

    bind(options: {
        source: ConversationId;
        by: string;
        context: Context;
        check: () => Promise<void>;
        current: () => User;
    }): HistoryAccess {
        const { source, by, context, check, current } = options;

        const authorize = async () => {
            this.#requireReady();
            await check();
            this.#requireReady();

            return current();
        };

        const shared = (target: ConversationId) => this.#shared(source, target, current());

        const catalog = async (filter: HistoryFilter) => {
            await authorize();
            const sessions = await this.#catalog(context);

            await authorize();

            return sessions.filter((session) => shared(session.id) && matches(session, filter));
        };

        // All asynchronous search reads belong to one error boundary, including catalog and cutoff preparation.
        const searchCall = async <T>(read: () => Promise<T>): Promise<T> => {
            try {
                return await read();
            } catch (error) {
                context.abortSignal?.throwIfAborted();
                current();

                try {
                    await authorize();
                } catch (authorization) {
                    // A failed store can prevent reauthorization. Never leak that technical error either.
                    if (authorization instanceof HttpError && authorization.status !== 503) {
                        throw authorization;
                    }
                }

                context.abortSignal?.throwIfAborted();
                current();
                this.#app.log(`History search failed: ${describe(error)}`);

                throw new HttpError(
                    503,
                    "History search is temporarily unavailable. Try again later.",
                );
            }
        };

        const entries: HistoryAccess["entries"] = async (query, limit = 256, cursor) => {
            if (
                !entryCheck.Check(query) ||
                !Number.isInteger(limit) ||
                limit < 1 ||
                limit > 256 ||
                (cursor !== undefined && (!isJsonValue(cursor) || !pageCursorCheck.Check(cursor)))
            ) {
                throw new HttpError(
                    400,
                    "History pages contain 1–256 entries with valid ID bounds.",
                );
            }

            await authorize();

            if (
                !shared(query.conversationId) ||
                (await this.#app.harness.commit(
                    (tx) => tx.conversation(query.conversationId),
                    context,
                )) === undefined
            ) {
                throw new HttpError(404, "This history is not available here.");
            }

            let page: Page<EntryRecord, Cursor>;

            try {
                page = await (
                    await this.#app.conversation(query.conversationId)
                ).entries(query, limit, cursor, context);
            } catch (error) {
                if (error instanceof StorageRequestError) {
                    throw new HttpError(400, "The history cursor or range is invalid.");
                }

                throw error;
            }

            await authorize();

            if (!shared(query.conversationId)) {
                throw new HttpError(404, "This history is not available here.");
            }

            return page;
        };

        return Object.freeze({
            entries,
            list: async (filter: HistoryListOptions = {}) => {
                if (!listCheck.Check(filter)) {
                    throw new HttpError(400, "Invalid history filters or page limit.");
                }

                const key = fingerprint(filter);
                const after = filter.cursor;

                if (
                    after !== undefined &&
                    (!cursorCheck.Check(after) ||
                        after.source !== source ||
                        after.by !== by ||
                        after.filter !== key)
                ) {
                    throw new HttpError(
                        400,
                        "The history cursor belongs to another query or caller.",
                    );
                }

                const sessions = (await catalog(filter)).sort(
                    (a, b) => b.createdAt - a.createdAt || b.id - a.id,
                );
                const remaining =
                    after === undefined
                        ? sessions
                        : sessions.filter(
                              (session) =>
                                  session.createdAt < after.at ||
                                  (session.createdAt === after.at && session.id < after.id),
                          );
                const limit = filter.limit ?? 50;
                const items = remaining.slice(0, limit);
                const last = items.at(-1);

                return {
                    items,
                    ...(remaining.length > limit && last !== undefined
                        ? {
                              next: {
                                  kind: "pocket.history.list.v1",
                                  source,
                                  by,
                                  filter: key,
                                  at: last.createdAt,
                                  id: last.id,
                              },
                          }
                        : {}),
                };
            },
            search: async (filter: HistorySearchOptions) => {
                if (!searchCheck.Check(filter)) {
                    throw new HttpError(400, "Invalid history search or limit.");
                }

                const text = filter.text.trim();

                if (text.length === 0 || text.length > 1000 || keywordTokens(text).length === 0) {
                    throw new HttpError(
                        400,
                        "Search text needs 1–1000 characters and a word or number.",
                    );
                }

                this.#requireReady();
                await searchCall(authorize);
                const backend = this.#backend;

                if (backend === undefined) {
                    throw new HttpError(
                        501,
                        "This persistence backend does not provide history search.",
                    );
                }

                return searchCall(async () => {
                    const sessions = await catalog(filter);
                    const targets: HistorySearchTarget[] = [];

                    for (const session of sessions) {
                        context.abortSignal?.throwIfAborted();
                        const page = await (
                            await this.#app.conversation(session.id)
                        ).entries({ order: "descending" }, 1, undefined, context);

                        targets.push({ ...session, through: page.items[0]?.id ?? null });
                    }

                    await authorize();
                    const eligible = targets.filter((target) => shared(target.id));
                    const fields = filter.fields ?? HISTORY_FIELDS;

                    if (eligible.length === 0 || fields.length === 0) {
                        return [];
                    }

                    const found = await backend.search(
                        {
                            targets: eligible,
                            text,
                            fields,
                            groupBy: filter.groupBy ?? "conversation",
                            limit: filter.limit ?? 25,
                        },
                        context,
                    );

                    await authorize();
                    const allowed = new Map(eligible.map((target) => [target.id, target]));
                    const currentCatalog = new Map(
                        (await catalog(filter)).map((session) => [session.id, session]),
                    );
                    const results: HistoryMatch[] = [];

                    for (const hit of found) {
                        const target = allowed.get(hit.conversationId);
                        const session = currentCatalog.get(hit.conversationId);

                        if (target === undefined || session === undefined || !shared(session.id)) {
                            continue;
                        }

                        if (hit.source.kind === "entry") {
                            if (
                                target.through === null ||
                                hit.source.entryId > target.through ||
                                !fields.includes(hit.source.field)
                            ) {
                                continue;
                            }

                            const page = await entries(
                                {
                                    conversationId: session.id,
                                    minEntryId: hit.source.entryId,
                                    maxEntryId: hit.source.entryId,
                                },
                                1,
                            );

                            if (page.items[0]?.id !== hit.source.entryId) {
                                continue;
                            }
                        } else if (!fields.includes("title")) {
                            continue;
                        }

                        results.push({
                            session,
                            source: hit.source,
                            snippet:
                                hit.snippet.length > 1000
                                    ? `${hit.snippet.slice(0, 999)}…`
                                    : hit.snippet,
                        });
                    }

                    await authorize();

                    return results
                        .filter((hit) => shared(hit.session.id))
                        .slice(0, filter.limit ?? 25);
                });
            },
        });
    }
}
