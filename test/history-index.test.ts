import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryDraft, EntryId } from "@earendil-works/pi-durable";
import { SqliteStorage, type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteHistorySearch } from "../src/server/history-index.ts";
import { HISTORY_FIELDS, type HistoryField } from "../src/server/history.ts";
import { keywordTokens } from "../src/server/history-text.ts";
import type { HistorySearchTarget } from "../src/server/persistence.ts";

async function fixture(t: TestContext) {
    const dir = await mkdtemp(join(tmpdir(), "pocket-history-index-"));
    const path = join(dir, "pocket.sqlite");
    let raw = await openNodeSqliteDatabase(path);
    let inTransaction = false;
    let onBatch: (() => Promise<void> | void) | undefined;
    let failBatch = false;
    let batches = 0;
    const database: SqliteDatabase = {
        exec: (...args) => raw.exec(...args),
        run: (...args) => raw.run(...args),
        get: (...args) => raw.get(...args),
        all: (...args) => raw.all(...args),
        close: () => raw.close(),
        transaction: async (callback) => {
            let batch = false;
            const result = await raw.transaction(async (tx) => {
                inTransaction = true;

                try {
                    return await callback({
                        exec: (...args) => tx.exec(...args),
                        get: (...args) => tx.get(...args),
                        all: (...args) => tx.all(...args),
                        run: async (sql, ...args) => {
                            if (
                                sql.startsWith("INSERT OR REPLACE INTO pocket_history_checkpoint")
                            ) {
                                batch = true;

                                if (failBatch) {
                                    throw new Error("injected derived write failure");
                                }
                            }

                            await tx.run(sql, ...args);
                        },
                    });
                } finally {
                    inTransaction = false;
                }
            });

            if (batch) {
                batches++;
                await onBatch?.();
            }

            return result;
        },
    };
    let storage = await SqliteStorage.open(database);
    let index = new SqliteHistorySearch(database, storage);

    const guardScans = () => {
        const scan = storage.scanEntries.bind(storage);

        storage.scanEntries = (...args) => {
            assert.equal(
                inTransaction,
                false,
                "Storage reads must not hold a native write transaction",
            );
            assert.ok(args[1] <= 128, "backfill must use bounded scans");

            return scan(...args);
        };
    };

    guardScans();
    t.after(async () => {
        await index.close(context);
        await storage.close(context);
        await rm(dir, { recursive: true, force: true });
    });

    return {
        database,
        get storage() {
            return storage;
        },
        get index() {
            return index;
        },
        get batches() {
            return batches;
        },
        set onBatch(value: typeof onBatch) {
            onBatch = value;
        },
        set failBatch(value: boolean) {
            failBatch = value;
        },
        async reopen() {
            await index.close(context);
            await storage.close(context);
            raw = await openNodeSqliteDatabase(path);
            storage = await SqliteStorage.open(database);
            guardScans();
            index = new SqliteHistorySearch(database, storage);
        },
        async session(
            title = "Untitled",
            parent?: { conversationId: ConversationId; at: EntryId },
        ): Promise<HistorySearchTarget> {
            const id = await storage.mintId<ConversationId>();

            await storage.commit(
                [{ type: "conversation", value: { id, ...(parent ? { parent } : {}) } }],
                context,
            );

            return {
                id,
                title,
                cwd: "/temporary",
                createdAt: 1,
                updatedAt: 1,
                archived: false,
                through: parent?.at ?? null,
            };
        },
        async append(target: HistorySearchTarget, draft: EntryDraft) {
            const id = await storage.mintId<EntryId>();

            const { head, ...rest } = draft;

            await storage.commit(
                [
                    {
                        type: "entry",
                        value: {
                            ...rest,
                            ...(head === undefined ? {} : { head: head === "self" ? id : head }),
                            id,
                            conversationId: target.id,
                        },
                    },
                ],
                context,
            );
            target.through = id;

            return id;
        },
        search(
            targets: readonly HistorySearchTarget[],
            text: string,
            options: {
                fields?: readonly HistoryField[];
                groupBy?: "entry" | "conversation";
                limit?: number;
                signal?: AbortSignal;
            } = {},
        ) {
            return index.search(
                {
                    targets,
                    text,
                    fields: options.fields ?? HISTORY_FIELDS,
                    groupBy: options.groupBy ?? "conversation",
                    limit: options.limit ?? 100,
                },
                options.signal ? withAbortSignal(options.signal, context) : context,
            );
        },
    };
}

const user = (text: string): EntryDraft => ({
    kind: "pi.user",
    model: [{ role: "user", content: text, timestamp: 1 }],
});
const assistant = (text: string): EntryDraft => ({
    kind: "pi.assistant",
    model: [fauxAssistantMessage(text)],
});
const call = (id: string, path: string, name = "write"): EntryDraft => ({
    kind: "pi.assistant",
    model: [
        fauxAssistantMessage([
            {
                type: "toolCall",
                id,
                name,
                arguments: {
                    path,
                    content: "writebodysecret",
                    newText: "replacementsecret",
                    arbitrary: "argumentsecret",
                },
            },
        ]),
    ],
});
const result = (toolCallId: string, toolName = "write", path?: string): EntryDraft => ({
    kind: "pi.tool-result",
    model: [
        {
            role: "toolResult",
            toolCallId,
            toolName,
            content: [{ type: "text", text: "rawresultsecret" }],
            details: path ? { path } : undefined,
            isError: false,
            timestamp: 1,
        },
    ],
});

test("allowlisted original text survives resets and edits; excluded bodies never enter search", async (t) => {
    const f = await fixture(t);
    const target = await f.session("titlemarker");
    const original = await f.append(target, user("stringmarker"));

    await f.append(target, {
        kind: "pi.user",
        model: [
            {
                role: "user",
                timestamp: 1,
                content: [
                    {
                        type: "text",
                        text: '<file name="ordinarymarker">This is the first user block.',
                    },
                    { type: "text", text: "blockmarker" },
                    { type: "text", text: '<file name="attached">attachmentsecret</file>' },
                    { type: "image", mimeType: "image/png", data: "imagesecret" },
                ],
            },
        ],
    });
    await f.append(target, {
        kind: "pi.assistant",
        model: [
            fauxAssistantMessage([
                { type: "text", text: "assistantmarker" },
                { type: "thinking", thinking: "thinkingsecret" },
            ]),
        ],
    });
    await f.append(target, {
        kind: "pi.compaction",
        model: [{ role: "user", content: "summarymarker", timestamp: 1 }],
    });
    await f.append(target, {
        kind: "pi.compaction",
        model: [
            { role: "user", content: [{ type: "text", text: "summaryblockmarker" }], timestamp: 1 },
        ],
    });
    await f.append(target, user("importedbranchmarker"));
    await f.append(target, { ...user("shellsecret"), kind: "pocket.shell" });
    await f.append(target, call("write-1", "changedpathmarker.ts"));
    const completed = await f.append(target, result("write-1"));

    await f.append(target, call("edit-1", "editedpathmarker.ts", "edit"));
    await f.append(target, result("edit-1", "edit"));
    await f.append(target, result("metadata-only", "edit", "explicitpathmarker.ts"));
    await f.append(target, call("unrecognized", "readpathsecret.ts", "read"));
    await f.append(target, result("unrecognized", "read", "readmetadatasecret.ts"));
    await f.append(target, {
        kind: "pi.reset",
        head: "self",
        edits: [
            {
                target: original,
                action: "replace",
                messages: [{ role: "user", content: "effectivereplacementsecret", timestamp: 1 }],
            },
        ],
    });

    for (const term of [
        "titlemarker",
        "stringmarker",
        "ordinarymarker",
        "blockmarker",
        "assistantmarker",
        "summarymarker",
        "summaryblockmarker",
        "importedbranchmarker",
        "changedpathmarker",
        "editedpathmarker",
        "explicitpathmarker",
    ]) {
        assert.equal((await f.search([target], term)).length, 1, term);
    }

    for (const term of [
        "attachmentsecret",
        "imagesecret",
        "thinkingsecret",
        "shellsecret",
        "rawresultsecret",
        "writebodysecret",
        "replacementsecret",
        "argumentsecret",
        "effectivereplacementsecret",
        "readpathsecret",
        "readmetadatasecret",
    ]) {
        assert.deepEqual(await f.search([target], term), [], term);
    }

    assert.deepEqual((await f.search([target], "changedpathmarker"))[0]?.source, {
        kind: "entry",
        entryId: completed,
        field: "modifiedPath",
    });
    assert.deepEqual(await f.search([target], "stringmarker", { fields: ["assistant"] }), []);
    assert.equal(
        (await f.storage.entry(original, context))?.entry.model?.[0]?.content,
        "stringmarker",
    );
});

test("native matches use eligible sources before grouping and limit, with OR terms, stemming and stable ties", async (t) => {
    const f = await fixture(t);
    const privateTarget = await f.session("private");

    await f.append(privateTarget, user("running alpha alpha alpha"));
    await f.search([privateTarget], "alpha");
    const publicTargets: HistorySearchTarget[] = [];

    for (let i = 0; i < 3; i++) {
        const target = await f.session();

        await f.append(target, user("running alpha"));
        publicTargets.push(target);
    }

    const matches = await f.search(publicTargets, "runs absentword", { limit: 3 });

    assert.deepEqual(
        matches.map((hit) => hit.conversationId),
        publicTargets.map((target) => target.id).reverse(),
    );
    assert.equal((await f.search(publicTargets, '" OR NOT alpha*', { limit: 3 })).length, 3);
    const target = publicTargets[0]!;

    await f.append(target, user("alpha"));
    assert.equal((await f.search([target], "alpha")).length, 1);
    assert.equal((await f.search([target], "alpha", { groupBy: "entry" })).length, 2);
    assert.deepEqual(keywordTokens("héllo 42 OR - café"), ["héllo", "42", "OR", "café"]);
});

test("entry grouping keeps one best field and a separate title; snippets stay bounded", async (t) => {
    const f = await fixture(t);
    const target = await f.session("sameword");
    const entry = await f.append(target, {
        kind: "pi.assistant",
        model: [
            fauxAssistantMessage([
                { type: "text", text: "sameword" },
                { type: "toolCall", id: "self", name: "edit", arguments: { path: "sameword.ts" } },
            ]),
            {
                role: "toolResult",
                toolCallId: "self",
                toolName: "edit",
                content: [],
                isError: false,
                timestamp: 1,
            },
        ],
    });

    // One entry can contain several messages, but kind remains authoritative: assistant kind excludes result metadata.
    assert.equal((await f.search([target], "sameword", { groupBy: "entry" })).length, 2);
    assert.equal((await f.search([target], "sameword"))[0]?.conversationId, target.id);
    await f.append(target, user(`longword ${"x".repeat(1500)}`));
    const hit = (await f.search([target], "longword"))[0]!;

    assert.ok(hit.snippet.length <= 1000);
    assert.ok(hit.snippet.endsWith("…"));
    assert.ok(entry > 0);
});

test("logical forks, older request boundaries and pending completions cannot expose later ancestor text", async (t) => {
    const f = await fixture(t);
    const parent = await f.session();

    await f.append(parent, user("inheritedmarker"));
    const forkPoint = await f.append(parent, call("pending", "pendingpathmarker.ts"));
    const beforeResult = { ...parent };
    const completed = await f.append(parent, result("pending"));

    await f.append(parent, user("postforksecret"));
    const fork = await f.session("Fork", { conversationId: parent.id, at: forkPoint });

    assert.equal((await f.search([parent], "postforksecret")).length, 1);
    assert.deepEqual(await f.search([fork], "postforksecret pendingpathmarker"), []);
    assert.equal((await f.search([fork], "inheritedmarker")).length, 1);
    assert.deepEqual(await f.search([beforeResult], "pendingpathmarker"), []);
    assert.deepEqual(await f.search([{ ...parent, through: null }], "inheritedmarker"), []);
    const forkResult = await f.append(fork, result("pending"));

    assert.deepEqual((await f.search([fork], "pendingpathmarker"))[0]?.source, {
        kind: "entry",
        entryId: forkResult,
        field: "modifiedPath",
    });
    assert.deepEqual(
        (await f.search([{ ...parent, through: completed }], "pendingpathmarker"))[0]?.source,
        { kind: "entry", entryId: completed, field: "modifiedPath" },
    );
});

test("cancelled bounded batches resume after reopening with pending correlation and no duplicate rows", async (t) => {
    const f = await fixture(t);
    const target = await f.session();

    await f.append(target, call("across-pages", "resumepathmarker.ts"));

    for (let i = 0; i < 280; i++) {
        await f.append(target, user("backfillmarker"));
    }

    const completed = await f.append(target, result("across-pages"));
    const abort = new AbortController();

    f.onBatch = () => abort.abort(new Error("cancel between batches"));
    await assert.rejects(
        f.search([target], "backfillmarker", { signal: abort.signal }),
        /cancel between batches/,
    );
    await f.index.close(context);
    assert.equal(f.batches, 1);
    f.onBatch = undefined;
    await f.reopen();
    assert.deepEqual((await f.search([target], "resumepathmarker"))[0]?.source, {
        kind: "entry",
        entryId: completed,
        field: "modifiedPath",
    });
    assert.equal((await f.search([target], "backfillmarker", { groupBy: "entry" })).length, 100);
    const rows = await f.database.get<{ count: number }>(
        "SELECT count(*) AS count FROM pocket_history_fts WHERE field = 'user'",
    );

    assert.equal(rows?.count, 280);
    assert.deepEqual(await f.database.all("SELECT * FROM pocket_history_pending"), []);
});

test("title refresh, lazy schema recovery and failed write rollback leave original storage intact", async (t) => {
    const f = await fixture(t);
    const target = await f.session("oldtitlemarker");
    const id = await f.append(target, user("originalmarker"));

    assert.equal(
        (await f.database.all("SELECT name FROM sqlite_master WHERE name LIKE 'pocket_history_%'"))
            .length,
        0,
    );
    assert.deepEqual(await f.search([], "originalmarker"), []);
    assert.equal(
        (await f.database.all("SELECT name FROM sqlite_master WHERE name LIKE 'pocket_history_%'"))
            .length,
        0,
    );
    f.failBatch = true;
    await assert.rejects(f.search([target], "originalmarker"), /injected derived write failure/);
    assert.deepEqual(await f.database.all("SELECT * FROM pocket_history_checkpoint"), []);
    assert.equal(
        (await f.database.all("SELECT * FROM pocket_history_fts WHERE field = 'user'")).length,
        0,
    );
    f.failBatch = false;
    assert.equal((await f.search([target], "originalmarker")).length, 1);
    target.title = "newtitlemarker";
    assert.equal((await f.search([target], "newtitlemarker"))[0]?.source.kind, "title");
    assert.deepEqual(await f.search([target], "oldtitlemarker"), []);
    await f.database.run("UPDATE pocket_history_schema SET version = 999");
    await f.reopen();
    assert.equal((await f.search([target], "originalmarker")).length, 1);
    assert.equal((await f.storage.entry(id, context))?.entry.model?.[0]?.content, "originalmarker");
});

test("queued cancellation is prompt, close drains work without SQL and tolerates a closed shared store", async (t) => {
    const f = await fixture(t);
    const target = await f.session();

    await f.append(target, user("queuedmarker"));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
        started = resolve;
    });
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });

    f.onBatch = async () => {
        started();
        await held;
    };

    const active = f.search([target], "queuedmarker");

    await entered;
    assert.deepEqual(await f.search([], "queuedmarker"), []);
    const abort = new AbortController();
    const queued = f.search([target], "queuedmarker", { signal: abort.signal });

    abort.abort(new Error("cancel queued caller"));
    await assert.rejects(queued, /cancel queued caller/);
    const closed = f.index.close(context);

    await assert.rejects(active, /History search is closed/);
    release();
    await closed;
    await f.storage.close(context);
    await f.index.close(context);
    await assert.rejects(f.search([target], "queuedmarker"), /closed/);
});

test("ordinary Durable commits complete between bounded backfill batches", async (t) => {
    const f = await fixture(t);
    const target = await f.session();
    const other = await f.session();

    for (let i = 0; i < 260; i++) {
        await f.append(target, user("interleavemarker"));
    }

    let completedAtBatch = 0;

    f.onBatch = async () => {
        if (completedAtBatch === 0) {
            await f.append(other, assistant("concurrentmarker"));
            completedAtBatch = f.batches;
        }
    };

    assert.equal((await f.search([target], "interleavemarker")).length, 1);
    assert.equal(completedAtBatch, 1);
    assert.ok(f.batches > completedAtBatch);
    assert.equal((await f.search([other], "concurrentmarker")).length, 1);
});
