import {
    cleanUp,
    context,
    home,
    newSession,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { after, test } from "node:test";
import { awaitWithContext } from "@earendil-works/chord/context";
import { defineDoc, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PocketApp } from "../src/server/app.ts";
import { ExtensionRequest } from "../src/server/extension-request.ts";
import { SqliteHistorySearch } from "../src/server/history-index.ts";
import { HttpError } from "../src/server/errors.ts";
import type { OpenPersistence } from "../src/server/persistence.ts";

const apps: App[] = [];

after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    cleanUp();
});

async function open(
    data: string,
    openPersistence: OpenPersistence,
    log: (line: string) => void = () => {},
) {
    const model = scriptedModel();
    const app = await PocketApp.open({
        dataDir: join(root, data),
        defaultCwd: work,
        home,
        supervised: false,
        log,
        openPersistence,
        configureModels: (models) => models.registerNativeProvider(model.provider),
    });

    apps.push(app);

    return app;
}

async function bound(app: App, source: ConversationId) {
    const scope = new ExtensionRequest(app, owner(app).id, "view", source);

    scope.bindSource((await app.agentState(source))!);

    return { scope, cap: app.contextManagement.forRequest(source, scope, "persistence-testing") };
}

const State = defineDoc({
    kind: "x.persistence-testing.state",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ count: 0 }),
});

/** Real SQLite/Storage with observable close ordering and injected faults at public provider boundaries. */
async function sqlite(dataDir: string) {
    const database = await openNodeSqliteDatabase(join(dataDir, "pocket.sqlite"));
    const events: string[] = [];
    let physicalCloses = 0;
    let closed = false;
    const physicalClose = database.close.bind(database);

    database.close = async () => {
        physicalCloses++;
        events.push("database.close");
        closed = true;
        await physicalClose();
    };

    const storage = await SqliteStorage.open(database);
    const native = new SqliteHistorySearch(database, storage);
    let started = 0;
    const historySearch = {
        search: async (...args: Parameters<SqliteHistorySearch["search"]>) => {
            started++;

            return native.search(...args);
        },
        close: async (...args: Parameters<SqliteHistorySearch["close"]>) => {
            events.push(closed ? "companion.close.after-storage" : "companion.close.begin");
            await native.close(...args);
            events.push("companion.close.end");
        },
    };

    return {
        database,
        storage,
        historySearch,
        events,
        physicalCloses: () => physicalCloses,
        searches: () => started,
    };
}

test("MemoryStorage injection needs no SQLite file; unsupported search preserves history and pruning", async () => {
    const data = "memory-provider";
    const storage = new MemoryStorage();
    let opens = 0;
    const app = await open(data, async () => {
        opens++;

        return { storage };
    });
    const source = await newSession(app);
    const target = await newSession(app);

    await say(app, target, "memoryStorageNeedle");
    const { cap, scope } = await bound(app, source);

    assert.equal(opens, 1);
    assert.equal(existsSync(join(root, data, "pocket.sqlite")), false);
    assert.equal((await cap.history.list({ conversationIds: [target] })).items[0]?.id, target);
    assert.match(
        JSON.stringify((await cap.history.entries({ conversationId: target })).items),
        /memoryStorageNeedle/,
    );
    await assert.rejects(cap.history.search({ text: "memoryStorageNeedle" }), { status: 501 });
    await cap.context();
    await cap.entries();
    assert.equal(await cap.update(State, (draft) => ++draft.count), 1);
    assert.equal(await cap.summaryUsage("never-started"), undefined);
    scope.close();
    await app.close();
    await app.close();
});

test("malformed entry cursors return 400 without stopping the shared Harness", async () => {
    const app = await open("invalid-entry-cursors", async () => ({ storage: new MemoryStorage() }));
    const source = await newSession(app);
    const target = await newSession(app);

    await say(app, target, "cursorTargetNeedle");
    const { cap, scope } = await bound(app, source);
    const cyclic: { self?: unknown } = {};

    cyclic.self = cyclic;
    const invalid: unknown[] = [
        null,
        3,
        "cursor",
        [],
        () => {},
        new Date(),
        cyclic,
        { after: Infinity },
        {},
    ];

    for (const cursor of invalid) {
        // @ts-expect-error External callers can supply values outside the declared Cursor type.
        await assert.rejects(cap.history.entries({ conversationId: target }, 1, cursor), {
            status: 400,
        });
    }

    for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        // @ts-expect-error Invalid external IDs must not enter the Storage failure guard.
        await assert.rejects(cap.history.entries({ conversationId: id }), { status: 400 });
    }

    // @ts-expect-error The preserved source-only method must use the same safe boundary.
    await assert.rejects(cap.entries({}, 1, null), { status: 400 });
    assert.equal((await cap.history.list({ conversationIds: [target] })).items[0]?.id, target);
    assert.match(
        JSON.stringify((await cap.history.entries({ conversationId: target })).items),
        /cursorTargetNeedle/,
    );
    await say(app, source, "conversation after invalid cursors");
    assert.equal(await cap.update(State, (draft) => ++draft.count), 1);
    scope.close();
});

for (const stage of ["catalog", "cutoff"]) {
    test(`search ${stage} failures are sanitized even when the shared storage fails`, async () => {
        let resource: Awaited<ReturnType<typeof sqlite>> | undefined;
        const logs: string[] = [];
        const app = await open(
            `search-${stage}-failure`,
            async ({ dataDir }) => {
                resource = await sqlite(dataDir);

                return resource;
            },
            (line) => logs.push(line),
        );

        assert.ok(resource);
        const source = await newSession(app);
        const target = await newSession(app);
        const { cap, scope } = await bound(app, source);

        const failure = () => {
            throw new Error(`SECRET_DATABASE_PATH_${stage}`);
        };

        if (stage === "catalog") {
            resource.storage.scanConversations = async () => failure();
        } else {
            const scan = resource.storage.scanEntries.bind(resource.storage);

            resource.storage.scanEntries = async (...args) => {
                if (args[0].conversationId === target) {
                    return failure();
                }

                return scan(...args);
            };
        }

        await assert.rejects(
            cap.history.search({ text: "searchNeedle", conversationIds: [target] }),
            (error: unknown) => {
                assert.ok(error instanceof HttpError);
                assert.equal(error.status, 503);
                assert.doesNotMatch(error.message, /SECRET|DATABASE|PATH/);

                return true;
            },
        );
        assert.ok(
            logs.some(
                (line) =>
                    line.startsWith("History search failed:") &&
                    line.includes("SECRET_DATABASE_PATH"),
            ),
        );
        assert.equal(resource.searches(), 0);
        await app.harness.closed;
        scope.close();
        await app.close();
        assert.equal(resource.physicalCloses(), 1);
    });
}

test("factory failure cleans its own resource and releases only this app's startup lock", async () => {
    const data = "factory-failure";
    let closes = 0;

    await assert.rejects(
        open(data, async ({ dataDir }) => {
            const resource = await sqlite(dataDir);

            try {
                throw new Error("factory initialization failed");
            } finally {
                await resource.historySearch.close(context);
                await resource.storage.close(context);
                closes = resource.physicalCloses();
            }
        }),
        /factory initialization failed/,
    );
    assert.equal(closes, 1);
    const recovered = await open(data, async () => ({ storage: new MemoryStorage() }));

    assert.equal((await newSession(recovered)) > 0, true);
    await recovered.close();
    // Pocket deliberately permits a restart in the same process. Use a real other Node process as the lock holder.
    const child = spawn(
        process.execPath,
        ["-e", "process.send('ready'); setTimeout(() => {}, 60000)"],
        {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
    );

    try {
        await once(child, "message", { signal: AbortSignal.timeout(10_000) });
        const lockFile = join(root, data, "harness.lock");
        const holder = `${String(child.pid)}\n`;

        writeFileSync(lockFile, holder);
        await assert.rejects(
            open(data, async () => {
                throw new Error("must not reach factory");
            }),
            /already running/i,
        );
        assert.equal(readFileSync(lockFile, "utf8"), holder);
    } finally {
        const exited = once(child, "exit");

        child.kill();
        await exited;
    }
});

test("failed Harness.open cleans an inactive companion after Durable closes storage, only once physically", async () => {
    let resource: Awaited<ReturnType<typeof sqlite>> | undefined;

    await assert.rejects(
        open("harness-open-failure", async ({ dataDir }) => {
            resource = await sqlite(dataDir);

            resource.storage.scanTasks = async () => {
                throw new Error("openTasks failed");
            };

            return resource;
        }),
        /openTasks failed/,
    );
    assert.ok(resource);
    assert.equal(resource.searches(), 0);
    assert.equal(resource.physicalCloses(), 1);
    assert.deepEqual(resource.events, [
        "database.close",
        "companion.close.after-storage",
        "companion.close.end",
    ]);
});

test("active search stops before normal Harness storage closure", async () => {
    let resource: Awaited<ReturnType<typeof sqlite>> | undefined;
    const app = await open("active-close", async ({ dataDir }) => {
        resource = await sqlite(dataDir);

        return resource;
    });

    assert.ok(resource);
    const source = await newSession(app);
    const target = await newSession(app);

    await app.harness.commit(async (tx) => {
        for (let n = 0; n < 300; n++) {
            await tx.appendEntry(UserEntry, target, {
                model: [{ role: "user", content: `activeCloseNeedle ${String(n)}`, timestamp: n }],
            });
        }
    }, context);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const scan = resource.storage.scanEntries.bind(resource.storage);

    resource.storage.scanEntries = async (...args) => {
        if (args[0].conversationId === target && args[0].order === "ascending") {
            entered.resolve();
            await awaitWithContext(release.promise, args[3]);
        }

        return scan(...args);
    };

    const { cap, scope } = await bound(app, source);
    const pending = cap.history.search({ text: "activeCloseNeedle", conversationIds: [target] });
    const rejected = assert.rejects(pending);

    await entered.promise;
    await app.close();
    await rejected;
    assert.equal(resource.physicalCloses(), 1);
    assert.deepEqual(resource.events, [
        "companion.close.begin",
        "companion.close.end",
        "database.close",
    ]);
    scope.close();
    release.resolve();
});

test("runtime-driven Harness failure stops the companion safely after the connection closes", async () => {
    let resource: Awaited<ReturnType<typeof sqlite>> | undefined;
    const app = await open("runtime-close", async ({ dataDir }) => {
        resource = await sqlite(dataDir);

        return resource;
    });

    assert.ok(resource);
    const source = await newSession(app);
    const { scope, cap } = await bound(app, source);

    await cap.history.search({ text: "warmup", conversationIds: [source] });

    resource.storage.scanConversations = async () => {
        throw new Error("runtime storage fault");
    };

    await assert.rejects(app.harness.commit((tx) => tx.scanConversations({}, 1), context));
    await app.harness.closed;
    await until(
        () => resource?.events.includes("companion.close.end") === true,
        "runtime companion cleanup",
    );
    assert.equal(resource.physicalCloses(), 1);
    assert.ok(
        resource.events.indexOf("database.close") <
            resource.events.indexOf("companion.close.after-storage"),
    );
    await assert.rejects(cap.history.list(), { status: 503 });
    scope.close();
    await app.close();
    assert.equal(resource.physicalCloses(), 1);
});

test("a reopened app reuses native history without duplicates and catches up new committed entries", async () => {
    let opens = 0;

    const factory: OpenPersistence = async ({ dataDir }) => {
        opens++;

        return sqlite(dataDir);
    };

    const first = await open("reopened-history", factory);
    const source = await newSession(first);
    const target = await newSession(first);

    await say(first, target, "beforeRestartNeedle");
    const initial = await bound(first, source);
    const original = await initial.cap.history.entries({ conversationId: target });
    const oldHits = await initial.cap.history.search({
        text: "beforeRestartNeedle",
        fields: ["user"],
        conversationIds: [target],
    });

    assert.equal(oldHits.length, 1);
    initial.scope.close();
    await first.close();
    const reopened = await open("reopened-history", factory);
    const resumed = await bound(reopened, source);

    assert.equal(opens, 2);
    assert.deepEqual(await resumed.cap.history.entries({ conversationId: target }), original);
    assert.deepEqual(
        await resumed.cap.history.search({
            text: "beforeRestartNeedle",
            fields: ["user"],
            conversationIds: [target],
        }),
        oldHits,
    );
    await say(reopened, target, "afterRestartNeedle");
    const hits = await resumed.cap.history.search({
        text: "beforeRestartNeedle afterRestartNeedle",
        fields: ["user"],
        conversationIds: [target],
        groupBy: "entry",
        limit: 100,
    });

    assert.equal(hits.length, 2);
    assert.equal(new Set(hits.map((hit) => JSON.stringify(hit.source))).size, 2);
    resumed.scope.close();
});

test("derived-write failure is sanitized and leaves conversations and pruning usable", async () => {
    let resource: Awaited<ReturnType<typeof sqlite>> | undefined;
    const logs: string[] = [];
    const app = await open(
        "index-write-failure",
        async ({ dataDir }) => {
            resource = await sqlite(dataDir);

            return resource;
        },
        (line) => logs.push(line),
    );

    assert.ok(resource);
    const source = await newSession(app);
    const target = await newSession(app);
    const { cap, scope } = await bound(app, source);

    await cap.history.search({ text: "warmup" });
    await resource.database.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON pocket_history_source
        BEGIN SELECT RAISE(ABORT, 'forced derived write failure'); END;`);
    await say(app, target, "retryHistoryNeedle");
    const original = await cap.history.entries({ conversationId: target });

    await assert.rejects(cap.history.search({ text: "retryHistoryNeedle" }), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 503);
        assert.doesNotMatch(error.message, /forced|SQLite|INSERT|pocket_history/);

        return true;
    });
    assert.ok(
        logs.some((line) => /History search failed:.*forced derived write failure/.test(line)),
    );
    await say(app, source, "conversation after a derived failure");
    assert.equal(await cap.update(State, (draft) => ++draft.count), 1);
    assert.deepEqual(await cap.history.entries({ conversationId: target }), original);
    await resource.database.exec("DROP TRIGGER fail_history");
    assert.equal(
        (await cap.history.search({ text: "retryHistoryNeedle", conversationIds: [target] }))
            .length,
        1,
    );
    scope.close();
});

test("source audience is rechecked after a delayed native search", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delay = false;
    const app = await open("audience-search", async ({ dataDir }) => {
        const resource = await sqlite(dataDir);

        return {
            storage: resource.storage,
            historySearch: {
                search: async (...args) => {
                    const found = await resource.historySearch.search(...args);

                    if (delay) {
                        entered.resolve();
                        await release.promise;
                    }

                    return found;
                },
                close: (ctx) => resource.historySearch.close(ctx),
            },
        };
    });
    const source = await newSession(app);
    const target = await newSession(app);

    await say(app, target, "revocationNeedle");
    const { cap, scope } = await bound(app, source);

    delay = true;
    const pending = cap.history.search({ text: "revocationNeedle", conversationIds: [target] });

    await entered.promise;
    const viewer = app.config.addUser("New source reader", "viewer", [String(source)]).user;

    release.resolve();
    assert.deepEqual(await pending, []);
    app.config.removeUser(viewer.id);
    scope.close();
});

test("direct entries recheck the shared audience and request lifetime after a delayed storage read", async () => {
    const storage = new MemoryStorage();
    const app = await open("audience-read", async () => ({ storage }));
    const source = await newSession(app);
    const target = await newSession(app);

    await say(app, target, "delayedPrivateNeedle");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const scan = storage.scanEntries.bind(storage);
    let paused = true;

    storage.scanEntries = async (...args) => {
        if (paused && args[0].conversationId === target) {
            paused = false;
            entered.resolve();
            await release.promise;
        }

        return scan(...args);
    };

    const { cap, scope } = await bound(app, source);
    const pending = cap.history.entries({ conversationId: target });
    const rejected = assert.rejects(pending, {
        status: 404,
        message: "This history is not available here.",
    });

    await entered.promise;
    const viewer = app.config.addUser("New source reader", "viewer", [String(source)]).user;

    release.resolve();
    await rejected;
    app.config.removeUser(viewer.id);
    scope.close();
    await assert.rejects(cap.history.entries({ conversationId: target }));
});
