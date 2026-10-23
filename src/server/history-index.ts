/** Rebuildable, lazy SQLite full-text search over logical Durable conversation history. */
import { setImmediate } from "node:timers/promises";
import { awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { EntryId, Storage } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import type { HistoryField } from "./history.ts";
import type {
    BackendHistoryMatch,
    HistorySearchBackend,
    HistorySearchTarget,
} from "./persistence.ts";
import { extractHistoryText, keywordTokens } from "./history-text.ts";

const BATCH_SIZE = 128;
const SCHEMA_VERSION = 1;

/** Decode an ID allocated by Durable and stored in our derived SQLite rows. */
function entryId(value: number): EntryId {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("Invalid history entry ID");
    }

    return value as EntryId;
}

type SearchRequest = Parameters<HistorySearchBackend["search"]>[0];

interface Hit {
    conversation: number;
    entry: number;
    field: HistoryField;
    excerpt: string;
}

export class SqliteHistorySearch implements HistorySearchBackend {
    readonly #database: SqliteDatabase;
    readonly #storage: Storage;
    readonly #stop = new AbortController();
    #queue: Promise<void> = Promise.resolve();
    #ready = false;

    constructor(database: SqliteDatabase, storage: Storage) {
        this.#database = database;
        this.#storage = storage;
    }

    search(request: SearchRequest, context: Context): Promise<readonly BackendHistoryMatch[]> {
        const bound = withAbortSignal(this.#stop.signal, context);

        if (request.targets.length === 0) {
            return awaitWithContext(Promise.resolve([]), bound);
        }

        const run = async () => {
            bound.abortSignal?.throwIfAborted();

            await this.#schema(bound);

            for (const target of request.targets) {
                await this.#catchUp(target, bound);
            }

            bound.abortSignal?.throwIfAborted();

            return this.#query(request, bound);
        };

        const pending = this.#queue.then(run);

        this.#queue = pending.then(
            () => {},
            () => {},
        );

        return awaitWithContext(pending, bound);
    }

    async close(_context: Context): Promise<void> {
        this.#stop.abort(new Error("History search is closed"));
        await this.#queue;
    }

    async #schema(context: Context): Promise<void> {
        if (this.#ready) {
            return;
        }

        await this.#database.transaction(async (tx) => {
            context.abortSignal?.throwIfAborted();
            await tx.exec(
                "CREATE TABLE IF NOT EXISTS pocket_history_schema (version INTEGER NOT NULL)",
            );
            const schema = await tx.get<{ version: number }>(
                "SELECT version FROM pocket_history_schema",
            );

            if (schema?.version !== SCHEMA_VERSION) {
                await tx.exec(`
                    DROP TABLE IF EXISTS pocket_history_fts;
                    DROP TABLE IF EXISTS pocket_history_source;
                    DROP TABLE IF EXISTS pocket_history_checkpoint;
                    DROP TABLE IF EXISTS pocket_history_pending;
                    DELETE FROM pocket_history_schema;
                `);
                await tx.run("INSERT INTO pocket_history_schema VALUES (?)", SCHEMA_VERSION);
            }

            await tx.exec(`
                CREATE TABLE IF NOT EXISTS pocket_history_source (
                    rowid INTEGER PRIMARY KEY, conversation INTEGER NOT NULL,
                    entry INTEGER NOT NULL, field TEXT NOT NULL, text TEXT NOT NULL,
                    UNIQUE (conversation, entry, field)
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS pocket_history_fts USING fts5(
                    conversation UNINDEXED, entry UNINDEXED, field UNINDEXED, text,
                    content = 'pocket_history_source', content_rowid = 'rowid',
                    tokenize = 'porter unicode61'
                );
                CREATE TRIGGER IF NOT EXISTS pocket_history_source_insert AFTER INSERT ON pocket_history_source BEGIN
                    INSERT INTO pocket_history_fts (rowid, conversation, entry, field, text)
                    VALUES (new.rowid, new.conversation, new.entry, new.field, new.text);
                END;
                CREATE TRIGGER IF NOT EXISTS pocket_history_source_update AFTER UPDATE ON pocket_history_source BEGIN
                    INSERT INTO pocket_history_fts (pocket_history_fts, rowid, conversation, entry, field, text)
                    VALUES ('delete', old.rowid, old.conversation, old.entry, old.field, old.text);
                    INSERT INTO pocket_history_fts (rowid, conversation, entry, field, text)
                    VALUES (new.rowid, new.conversation, new.entry, new.field, new.text);
                END;
                CREATE TABLE IF NOT EXISTS pocket_history_checkpoint (
                    conversation INTEGER PRIMARY KEY, entry INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pocket_history_pending (
                    conversation INTEGER NOT NULL, call TEXT NOT NULL, path TEXT NOT NULL,
                    PRIMARY KEY (conversation, call)
                );
            `);
            context.abortSignal?.throwIfAborted();
        });
        this.#ready = true;
    }

    async #catchUp(target: HistorySearchTarget, context: Context): Promise<void> {
        context.abortSignal?.throwIfAborted();
        // Titles are current catalog metadata, even when no transcript entry was added.
        await this.#database.transaction(async (tx) => {
            context.abortSignal?.throwIfAborted();
            await this.#put(tx, target.id, 0, "title", target.title);
            context.abortSignal?.throwIfAborted();
        });
        context.abortSignal?.throwIfAborted();

        if (target.through === null) {
            return;
        }

        const checkpoint = await this.#database.get<{ entry: number }>(
            "SELECT entry FROM pocket_history_checkpoint WHERE conversation = ?",
            target.id,
        );
        let last = checkpoint?.entry ?? 0;

        context.abortSignal?.throwIfAborted();

        if (last >= target.through) {
            return;
        }

        const saved = await this.#database.all<{ call: string; path: string }>(
            "SELECT call, path FROM pocket_history_pending WHERE conversation = ?",
            target.id,
        );
        const pending = new Map(saved.map((row) => [row.call, row.path]));

        while (last < target.through) {
            context.abortSignal?.throwIfAborted();
            // Never use Storage inside a native transaction: both share the same serialized facade.
            const page = await this.#storage.scanEntries(
                {
                    conversationId: target.id,
                    ...(last === 0 ? {} : { minEntryId: entryId(last) }),
                    maxEntryId: target.through,
                    order: "ascending",
                },
                BATCH_SIZE,
                undefined,
                context,
            );
            const entries = page.items.filter((entry) => entry.id > last);

            if (entries.length === 0) {
                break;
            }

            const batch = entries.map((entry) => ({
                entry,
                extracted: extractHistoryText(entry, pending),
            }));
            const consumed = entries.at(-1);

            if (consumed === undefined) {
                break;
            }

            context.abortSignal?.throwIfAborted();
            await this.#database.transaction(async (tx) => {
                context.abortSignal?.throwIfAborted();

                for (const { entry, extracted } of batch) {
                    for (const field of extracted.fields) {
                        await this.#put(tx, target.id, entry.id, field.field, field.text);
                    }

                    for (const [call, path] of extracted.pending) {
                        if (path === null) {
                            await tx.run(
                                "DELETE FROM pocket_history_pending WHERE conversation = ? AND call = ?",
                                target.id,
                                call,
                            );
                        } else {
                            await tx.run(
                                "INSERT OR REPLACE INTO pocket_history_pending VALUES (?, ?, ?)",
                                target.id,
                                call,
                                path,
                            );
                        }
                    }
                }

                await tx.run(
                    "INSERT OR REPLACE INTO pocket_history_checkpoint VALUES (?, ?)",
                    target.id,
                    consumed.id,
                );
                context.abortSignal?.throwIfAborted();
            });
            last = consumed.id;
            // Give ordinary submissions and queued cancellation a turn between bounded commits.
            await setImmediate();
        }
    }

    async #put(
        tx: SqliteExecutor,
        conversation: number,
        entry: number,
        field: HistoryField,
        text: string,
    ): Promise<void> {
        await tx.run(
            `
            INSERT INTO pocket_history_source (conversation, entry, field, text) VALUES (?, ?, ?, ?)
            ON CONFLICT (conversation, entry, field) DO UPDATE SET text = excluded.text
                WHERE text <> excluded.text
        `,
            conversation,
            entry,
            field,
            text,
        );
    }

    async #query(
        request: SearchRequest,
        context: Context,
    ): Promise<readonly BackendHistoryMatch[]> {
        const tokens = keywordTokens(request.text);

        if (tokens.length === 0 || request.fields.length === 0) {
            return [];
        }

        const targets = JSON.stringify(
            request.targets.map((target) => ({ id: target.id, through: target.through })),
        );
        const hits = await this.#database.all<Hit>(
            `
            WITH hits AS MATERIALIZED (
                SELECT conversation, entry, field,
                    snippet(pocket_history_fts, 3, '', '', ' … ', 64) AS excerpt,
                    bm25(pocket_history_fts) AS rank
                FROM pocket_history_fts
                JOIN json_each(?) AS eligible
                    ON conversation = json_extract(eligible.value, '$.id')
                WHERE pocket_history_fts MATCH ?
                    AND field IN (SELECT value FROM json_each(?))
                    AND (entry = 0 OR entry <= json_extract(eligible.value, '$.through'))
            ), grouped AS (
                SELECT *, row_number() OVER (
                    PARTITION BY conversation ${request.groupBy === "entry" ? ", entry" : ""}
                    ORDER BY rank, CASE WHEN field = 'title' THEN 0 ELSE 1 END,
                        entry DESC, field
                ) AS position FROM hits
            )
            SELECT conversation, entry, field, excerpt FROM grouped WHERE position = 1
            ORDER BY rank, conversation DESC, CASE WHEN field = 'title' THEN 0 ELSE 1 END,
                entry DESC, field LIMIT ?
        `,
            targets,
            tokens.map((token) => `"${token}"`).join(" OR "),
            JSON.stringify(request.fields),
            request.limit,
        );

        context.abortSignal?.throwIfAborted();

        return hits.map((hit) => {
            const target = request.targets.find((target) => target.id === hit.conversation);

            if (target === undefined) {
                throw new Error("History query returned an ineligible target");
            }

            return {
                conversationId: target.id,
                source:
                    hit.field === "title"
                        ? { kind: "title" }
                        : {
                              kind: "entry",
                              entryId: entryId(hit.entry),
                              field: hit.field,
                          },
                snippet: hit.excerpt.length > 1000 ? `${hit.excerpt.slice(0, 999)}…` : hit.excerpt,
            };
        });
    }
}
