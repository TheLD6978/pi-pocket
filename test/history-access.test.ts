import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    work,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    AgentDoc,
    defineDoc,
    UserEntry,
    UsageDoc,
    type ConversationId,
} from "@earendil-works/pi-durable";
import { ExtensionRequest } from "../src/server/extension-request.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});
after(async () => {
    await app.close();
    cleanUp();
});

async function bound(source: ConversationId, user = owner(app)) {
    const scope = new ExtensionRequest(app, user.id, "view", source);

    scope.bindSource((await app.agentState(source))!);

    return { scope, cap: app.contextManagement.forRequest(source, scope, "history-testing") };
}

const State = defineDoc({
    kind: "x.history-testing.state",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ count: 0 }),
    checkpointWhen: () => false,
});

test("history filters and list cursors use current catalog metadata and bind source and caller", async () => {
    const source = await newSession(app);
    const a = await newSession(app);
    const b = await newSession(app);
    const c = await newSession(app);

    const times: readonly [ConversationId, number][] = [
        [a, 10],
        [b, 20],
        [c, 30],
    ];

    await app.harness.commit(async (tx) => {
        const sessions = await tx.doc(SessionsDoc);

        for (const [id, at] of times) {
            const meta = sessions.items[String(id)]!;

            meta.createdAt = at;
            meta.archived = id === a;
        }
    }, context);
    const { cap, scope } = await bound(source);
    const filter = { conversationIds: [a, b, c] };
    const first = await cap.history.list({ ...filter, limit: 1 });

    assert.deepEqual(
        first.items.map((session) => session.id),
        [c],
    );
    assert.ok(first.next);
    assert.deepEqual(
        (await cap.history.list({ ...filter, limit: 2, cursor: first.next })).items.map(
            (s) => s.id,
        ),
        [b, a],
    );
    assert.deepEqual(
        (await cap.history.list({ ...filter, after: 20, before: 30 })).items.map((s) => s.id),
        [b],
    );
    assert.deepEqual(
        (await cap.history.list({ ...filter, archived: true })).items.map((s) => s.id),
        [a],
    );
    assert.equal((await cap.history.list({ conversationIds: [] })).items.length, 0);
    assert.equal((await cap.history.search({ text: "unmatched", conversationIds: [] })).length, 0);
    await assert.rejects(cap.history.list({ ...filter, project: "other", cursor: first.next }), {
        status: 400,
    });
    const other = await bound(a);

    await assert.rejects(other.cap.history.list({ ...filter, cursor: first.next }), {
        status: 400,
    });
    const guest = app.config.addUser("Catalog requester", "guest").user;
    const guestBinding = await bound(source, guest);

    await assert.rejects(guestBinding.cap.history.list({ ...filter, cursor: first.next }), {
        status: 400,
    });
    guestBinding.scope.close();
    app.config.removeUser(guest.id);
    await assert.rejects(cap.history.list({ limit: 257 }), { status: 400 });
    await assert.rejects(cap.history.list({ after: Infinity }), { status: 400 });
    await assert.rejects(cap.history.search({ text: "!!!" }), { status: 400 });
    await assert.rejects(cap.history.search({ text: "x".repeat(1001) }), { status: 400 });
    scope.close();
    other.scope.close();
});

test("discovery includes the current and archived sessions across folders, with case-insensitive project filters", async () => {
    const source = await newSession(app);
    const cwd = join(work, "HistoryCaseFolder");

    mkdirSync(cwd);
    const otherFolder = await newSession(app, cwd);

    await app.commands.updateSession(source, owner(app), { title: "currentTitleNeedle" });
    await app.commands.updateSession(otherFolder, owner(app), {
        title: "folderTitleNeedle",
        archived: true,
    });
    const { cap, scope } = await bound(source);
    const all = await cap.history.list();

    assert.ok(all.items.some((session) => session.id === source));
    assert.ok(all.items.some((session) => session.id === otherFolder && session.archived));
    assert.deepEqual(
        (await cap.history.list({ project: "historycasefolder" })).items.map(
            (session) => session.id,
        ),
        [otherFolder],
    );
    assert.equal(
        (await cap.history.list({ project: "HISTORYCASEFOLDER", archived: false })).items.length,
        0,
    );
    assert.equal(
        (await cap.history.search({ text: "currentTitleNeedle", fields: ["title"] }))[0]?.session
            .id,
        source,
    );
    assert.equal(
        (await cap.history.search({ text: "folderTitleNeedle", project: "historycasefolder" }))[0]
            ?.session.id,
        otherFolder,
    );
    scope.close();
});

test("a restricted source audience hides indexed targets before ranking and limits", async () => {
    const source = await newSession(app);
    const visible = await Promise.all([newSession(app), newSession(app), newSession(app)]);
    const privateTarget = await newSession(app);

    for (const id of visible) {
        await say(app, id, "rankneedle shared discussion");
    }

    await say(app, privateTarget, `${"rankneedle ".repeat(30)} privateOnlyNeedle`);
    await app.commands.updateSession(privateTarget, owner(app), { title: "PrivateTargetTitle" });
    const { scope, cap } = await bound(source);

    // Warm the private row before changing visibility, so this tests native scope filtering too.
    assert.ok(
        (await cap.history.search({ text: "rankneedle", limit: 100 })).some(
            (hit) => hit.session.id === privateTarget,
        ),
    );
    const viewer = app.config.addUser("Source reader", "viewer", [
        String(source),
        ...visible.map(String),
    ]).user;

    try {
        const hits = await cap.history.search({ text: "rankneedle", limit: 3 });

        assert.equal(hits.length, 3);
        assert.deepEqual(new Set(hits.map((hit) => hit.session.id)), new Set(visible));
        assert.doesNotMatch(JSON.stringify(hits), /privateOnlyNeedle|PrivateTargetTitle/);
        assert.equal(
            (await cap.history.list({ conversationIds: [privateTarget] })).items.length,
            0,
        );
        await assert.rejects(
            cap.history.entries({ conversationId: privateTarget }),
            (error: unknown) => {
                assert.ok(error instanceof HttpError);
                assert.equal(error.status, 404);
                assert.equal(error.message, "This history is not available here.");

                return true;
            },
        );
        await assert.rejects(
            cap.history.entries({
                // @ts-expect-error Tests an external numeric reference that is not a stored conversation.
                conversationId: Number.MAX_SAFE_INTEGER,
            }),
            (error: unknown) => {
                assert.ok(error instanceof HttpError);
                assert.equal(error.status, 404);
                assert.equal(error.message, "This history is not available here.");

                return true;
            },
        );
    } finally {
        app.config.removeUser(viewer.id);
        scope.close();
    }
});

test("direct entries can read an authorized hidden conversation but discovery cannot add it", async () => {
    const source = await newSession(app);
    const pip = await app.pip.ensure(owner(app));
    const hidden = await app.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
    );

    await app.harness.commit(async (tx) => {
        await tx.appendEntry(UserEntry, pip, {
            model: [{ role: "user", content: "pipOnlyMarker", timestamp: 1 }],
        });
        await tx.appendEntry(UserEntry, hidden.id, {
            model: [{ role: "user", content: "uncatalogedMarker", timestamp: 1 }],
        });
    }, context);
    const { scope, cap } = await bound(source);

    assert.equal((await cap.history.list({ conversationIds: [pip, hidden.id] })).items.length, 0);
    assert.deepEqual(
        await cap.history.search({
            text: "pipOnlyMarker uncatalogedMarker",
            conversationIds: [pip, hidden.id],
        }),
        [],
    );
    assert.ok(
        (await cap.history.entries({ conversationId: pip })).items.some(
            (entry) => entry.kind === "pi.user",
        ),
    );
    assert.equal(
        (await cap.history.entries({ conversationId: hidden.id })).items[0]?.model?.[0]?.content,
        "uncatalogedMarker",
    );
    scope.close();
});

test("target reads preserve source updates and usage, and source lifetime controls every history operation", async () => {
    const source = await newSession(app);
    const target = await newSession(app);

    await say(app, target, "historyReadNeedle");
    const before = await app.harness.snapshot(UsageDoc, source, context);
    const targetBefore = await app.harness.snapshot(AgentDoc, target, context);
    const { scope, cap } = await bound(source);
    const page = await cap.history.entries({ conversationId: target, order: "ascending" }, 1);

    assert.equal(page.items[0]?.kind, "pi.user");
    assert.ok(page.next);
    assert.ok((await cap.entries()).items.length === 0);
    await cap.history.search({ text: "historyReadNeedle", conversationIds: [target] });
    assert.equal(await cap.update(State, (draft) => ++draft.count), 1);
    assert.equal((await app.harness.snapshot(State, source, context))?.count, 1);
    assert.equal(await app.harness.snapshot(State, target, context), undefined);
    assert.deepEqual(await app.harness.snapshot(AgentDoc, target, context), targetBefore);
    assert.deepEqual(await app.harness.snapshot(UsageDoc, source, context), before);
    // A native cursor never changes the explicit target, even if a caller reuses it incorrectly.
    assert.equal(
        (await cap.history.entries({ conversationId: source }, 1, page.next)).items.length,
        0,
    );
    scope.close();
    await assert.rejects(cap.history.list());
    await assert.rejects(cap.history.entries({ conversationId: target }));
    await assert.rejects(cap.history.search({ text: "historyReadNeedle" }));
});

test("original fork history includes inherited entries and excludes later ancestor messages", async () => {
    const source = await newSession(app);
    const parent = await newSession(app);

    await say(app, parent, "inheritedHistoryNeedle");
    const before = await app.transcripts.allEntries(parent, true);
    const reply = before.findLast((entry) => entry.kind === "assistant")!;
    const fork = await app.commands.fork(parent, owner(app), { entryId: reply.id });

    await say(app, parent, "laterAncestorNeedle");
    const { scope, cap } = await bound(source);
    const inherited = await cap.history.entries({ conversationId: fork.id, order: "ascending" });

    assert.match(JSON.stringify(inherited.items), /inheritedHistoryNeedle/);
    assert.doesNotMatch(JSON.stringify(inherited.items), /laterAncestorNeedle/);
    assert.equal(
        (await cap.history.search({ text: "inheritedHistoryNeedle", conversationIds: [fork.id] }))
            .length,
        1,
    );
    assert.equal(
        (await cap.history.search({ text: "laterAncestorNeedle", conversationIds: [fork.id] }))
            .length,
        0,
    );
    scope.close();
});
