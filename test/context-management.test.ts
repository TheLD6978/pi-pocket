import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    recordCost,
    say,
    scriptedModel,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
    CompactionEntry,
    defineDoc,
    UsageDoc,
    type ConversationId,
    type ContextView,
    type EntryId,
} from "@earendil-works/pi-durable";
import { ExtensionRequest } from "../src/server/extension-request.ts";
import { ContextRequestsDoc, SpendDoc, TurnsDoc } from "../src/server/docs.ts";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextManagementCapability } from "../src/server/context-management.ts";
import type { TaskId } from "@earendil-works/pi-durable";

const tailOf = (view: ContextView): EntryId | null =>
    view.entries.reduce<EntryId | null>(
        (latest, entry) => (latest === null || entry.id > latest ? entry.id : latest),
        null,
    );

const State = defineDoc({
    kind: "x.testing.state",
    version: 1,
    scope: "conversation",
    history: "rewindable",
    fork: "asOf",
    initial: () => ({ count: 0 }),
});
const Other = defineDoc({
    kind: "x.other.state",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ count: 0 }),
});
const messages = [
    { role: "user" as const, content: "Summarize these tool results.", timestamp: 1 },
];
const model = scriptedModel((input) => {
    const source = input.messages[0]?.content;
    const response = fauxAssistantMessage(
        "A short summary.",
        source === "reported-error"
            ? { stopReason: "error", errorMessage: "A reported failure" }
            : source === "reported-abort"
              ? { stopReason: "aborted" }
              : {},
    );

    response.usage.cost.total = 0.25;
    response.usage.cost.output = 0.25;

    return response;
});
// Faux deliberately recalculates all costs as zero. This provider-boundary adapter
// reports a real nonzero cost on every partial and terminal response, including aborts.
const freeStream = model.provider.streamSimple.bind(model.provider);

model.provider.streamSimple = (...args) => {
    const marker = args[1].messages[0]?.content;

    if (marker === "slow-deadline" || marker === "oversized-response") {
        const output = createAssistantMessageEventStream();
        const response = fauxAssistantMessage(
            marker === "oversized-response" ? "x".repeat(600_000) : "tick",
        );

        response.api = args[0].api;
        response.provider = args[0].provider;
        response.model = args[0].id;
        response.usage.cost.total = 0.25;
        response.usage.cost.output = 0.25;
        output.push({ type: "start", partial: response });

        void (async () => {
            if (marker === "slow-deadline") {
                while (!args[2]?.signal?.aborted) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    output.push({
                        type: "text_delta",
                        contentIndex: 0,
                        delta: "tick",
                        partial: response,
                    });
                }

                response.stopReason = "aborted";
                output.push({ type: "error", reason: "aborted", error: response });
            } else {
                output.push({ type: "done", reason: "stop", message: response });
            }

            output.end(response);
        })();

        return output;
    }

    const source = freeStream(...args);
    const output = createAssistantMessageEventStream();

    void (async () => {
        for await (const event of source) {
            const response =
                event.type === "error"
                    ? event.error
                    : event.type === "done"
                      ? event.message
                      : event.partial;

            response.usage.cost.total = 0.25;
            response.usage.cost.output = 0.25;
            output.push(event);
        }

        const result = await source.result();

        result.usage.cost.total = 0.25;
        result.usage.cost.output = 0.25;
        output.end(result);
    })();

    return output;
};

let app: App;

before(async () => {
    app = await openApp(model);
});
after(async () => {
    await app.close();
    cleanUp();
});

async function bound(id: ConversationId, by = owner(app), access: "steer" | "view" = "steer") {
    const scope = new ExtensionRequest(app, by.id, access, id);

    scope.bindSource((await app.agentState(id))!);

    return { scope, cap: app.contextManagement.forRequest(id, scope, "testing") };
}

test("effective history and scoped updates work while idle; lifetime and namespace checks are enforced", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    const { scope, cap } = await bound(id);

    assert.equal(cap.conversationId, id);
    assert.ok((await cap.context()).contributions.length > 0);
    assert.ok((await cap.entries({}, 2)).items.length > 0);
    assert.equal(await cap.update(State, (draft) => ++draft.count), 1);
    await assert.rejects(
        cap.update(Other, (draft) => ++draft.count),
        { status: 403 },
    );
    await assert.rejects(cap.entries({}, 257), { status: 400 });
    scope.close();
    await assert.rejects(cap.context());
    await assert.rejects(cap.update(State, (draft) => ++draft.count));
    assert.equal((await app.harness.snapshot(State, id, context))?.count, 1);
});

test("idle summaries deduplicate and charge the authenticated caller rather than the last requester", async () => {
    const id = await newSession(app);

    await say(app, id, "owner's work");
    const guest = app.config.addUser("Summary payer", "guest").user;
    const { scope, cap } = await bound(id, guest);
    const start = model.state.callCount;
    const paid = app.spend.personSpent(guest.id);
    const progress: number[] = [];
    const first = await cap.summarize("x.testing.once", {
        messages,
        onProgress: (chars) => progress.push(chars),
    });
    const second = await cap.summarize("x.testing.once", { messages });

    assert.deepEqual(second, first);
    assert.equal(model.state.callCount, start + 1);
    assert.ok(progress.every((value) => typeof value === "number"));
    assert.equal(app.spend.personSpent(guest.id), paid + first.response.usage.cost.total);
    const spend = await app.harness.snapshot(SpendDoc, context);

    assert.equal(spend?.people[guest.id], paid + first.response.usage.cost.total);
    await assert.rejects(cap.summarize("x.testing.once", { messages: [] }), { status: 409 });
    scope.close();
});

test("model and thinking policy have no fallback; spend limits and turns block admission", async () => {
    const id = await newSession(app);
    const { scope, cap } = await bound(id);

    await assert.rejects(cap.summarize("other", { messages, model: "faux/faux-2" }), {
        status: 403,
    });
    await assert.rejects(cap.summarize("thinking", { messages, thinking: "high" }), {
        status: 400,
    });
    await recordCost(app, id, 0.25);
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    await assert.rejects(cap.summarize("limited", { messages }), { status: 409 });
    await app.spend.setSessionBudget(owner(app), id, null);
    await app.harness.commit(async (tx) => {
        const turns = await tx.doc(TurnsDoc, id);

        turns.on = true;
        turns.driver = "someone-else";
    }, context);
    await assert.rejects(cap.summarize("turn", { messages }), { status: 409 });
    scope.close();
});

test("an uncertain durable intent is not resent after reopening", async () => {
    const id = await newSession(app);
    const key = "x.testing.crash";
    const token = createHash("sha256").update(`${id}:${key}`).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify({ messages })).digest("hex");

    await app.harness.commit(async (tx) => {
        (await tx.doc(ContextRequestsDoc, id)).items[token] = {
            id: "interrupted",
            by: owner(app).id,
            model: { provider: "faux", modelId: "faux-1" },
            fingerprint,
        };
    }, context);
    await app.close();
    app = await openApp(model, app.dataDir);
    const start = model.state.callCount;
    const { scope, cap } = await bound(id);
    const result = await cap.summarize(key, { messages });

    assert.equal(result.interrupted, true);
    assert.equal(result.response.stopReason, "aborted");
    assert.equal(model.state.callCount, start);
    scope.close();
});

test("cancelled provider responses still have accounted receipts and no unsafe state update", async () => {
    const id = await newSession(app);
    const { scope, cap } = await bound(id);
    const stop = new AbortController();
    const result = await cap.summarize(
        "x.testing.abort",
        { messages, onProgress: () => stop.abort() },
        stop.signal,
    );
    const usage = await app.harness.snapshot(UsageDoc, id, context);

    assert.equal(usage?.models["faux/faux-1"]?.cost.total, result.response.usage.cost.total);
    const receipt = await cap.summarize("x.testing.abort", { messages });

    assert.deepEqual(receipt, result);
    scope.close();
});

test("reported failed and aborted responses are charged once across replay and restart", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Failure payer", "guest").user;
    const { scope, cap } = await bound(id, guest);

    for (const stop of ["error", "abort"] as const) {
        const request = {
            messages: [{ role: "user" as const, content: `reported-${stop}`, timestamp: 1 }],
        };
        const result = await cap.summarize(`x.testing.reported-${stop}`, request);

        assert.equal(result.response.stopReason, stop === "error" ? "error" : "aborted");
        assert.equal(result.response.usage.cost.total, 0.25);
        assert.deepEqual(await cap.summarize(`x.testing.reported-${stop}`, request), result);
    }

    assert.equal(app.spend.personSpent(guest.id), 0.5);
    scope.close();
    await app.close();
    app = await openApp(model, app.dataDir);
    assert.equal(app.spend.personSpent(guest.id), 0.5);
    assert.equal(app.spend.sessionSpent(id), 0.5);
});

test("concurrent requests join once, while mismatched actors or inputs never join", async () => {
    const id = await newSession(app);
    const { scope, cap } = await bound(id);
    const start = model.state.callCount;
    const [a, b] = await Promise.all([
        cap.summarize("x.testing.parallel", { messages }),
        cap.summarize("x.testing.parallel", { messages }),
    ]);

    assert.deepEqual(a, b);
    assert.equal(model.state.callCount, start + 1);
    const guest = app.config.addUser("Different payer", "guest").user;
    const other = await bound(id, guest);

    await assert.rejects(other.cap.summarize("x.testing.parallel", { messages }), { status: 409 });
    assert.equal(app.spend.personSpent(guest.id), 0);
    scope.close();
    other.scope.close();
});

test("request close during a summary still accounts the response but forbids later mutations", async () => {
    const id = await newSession(app);
    const { scope, cap } = await bound(id);

    await assert.rejects(
        cap.summarize("x.testing.close", {
            messages,
            onProgress: () => scope.close(),
        }),
    );

    await assert.rejects(cap.update(State, (draft) => ++draft.count));
    const fresh = await bound(id);

    const result = await fresh.cap.summarize("x.testing.close", { messages });

    assert.deepEqual(await fresh.cap.summaryUsage("x.testing.close"), {
        id: result.id,
        usage: result.response.usage,
    });
    assert.equal(
        (await app.harness.snapshot(UsageDoc, id, context))?.models["faux/faux-1"]?.cost.total,
        result.response.usage.cost.total,
    );
    fresh.scope.close();
});

test("summaryUsage reads only exact-key persisted counters across cancellation and restart", async () => {
    const id = await newSession(app);
    const { scope, cap } = await bound(id);
    const key = "x.testing.receipt-read";

    assert.equal(await cap.summaryUsage(key), undefined);
    await assert.rejects(cap.summaryUsage(""), { status: 400 });
    let streaming!: () => void;
    const began = new Promise<void>((resolve) => {
        streaming = resolve;
    });
    const running = cap.summarize(key, {
        messages: [{ role: "user", content: "slow-deadline", timestamp: 1 }],
        timeoutMs: 5000,
        onProgress: streaming,
    });

    await began;
    assert.equal(
        await cap.summaryUsage(key),
        undefined,
        "an admitted in-flight request has no persisted usage result yet",
    );
    scope.close();
    await assert.rejects(running);
    await assert.rejects(cap.summaryUsage(key));
    const fresh = await bound(id);
    const response = await fresh.cap.summarize(key, {
        messages: [{ role: "user", content: "slow-deadline", timestamp: 1 }],
        timeoutMs: 5000,
    });

    assert.equal(response.response.stopReason, "aborted");
    const saved = await fresh.cap.summaryUsage(key);

    assert.deepEqual(saved, { id: response.id, usage: response.response.usage });
    assert.deepEqual(Object.keys(saved!).sort(), ["id", "usage"]);
    assert.equal(saved!.usage.cost.total, 0.25);
    saved!.usage.cost.total = 99;
    assert.equal(
        (await fresh.cap.summaryUsage(key))!.usage.cost.total,
        0.25,
        "returned counters cannot mutate the receipt",
    );
    const other = await bound(await newSession(app));

    assert.equal(
        await other.cap.summaryUsage(key),
        undefined,
        "the same key cannot read another source's receipt",
    );
    fresh.scope.close();
    other.scope.close();
    await app.close();
    app = await openApp(model, app.dataDir);
    const reopened = await bound(id);

    assert.deepEqual(await reopened.cap.summaryUsage(key), {
        id: response.id,
        usage: response.response.usage,
    });
    reopened.scope.close();
});

test("viewers and revoked people cannot mutate or spend", async () => {
    const id = await newSession(app);
    const viewer = app.config.addUser("History reader", "viewer").user;
    const { scope, cap } = await bound(id, viewer, "view");

    await cap.context();
    const start = model.state.callCount;

    await assert.rejects(
        cap.update(State, (draft) => ++draft.count),
        { status: 403 },
    );
    await assert.rejects(cap.summarize("x.testing.viewer", { messages }), { status: 403 });
    assert.equal(model.state.callCount, start);
    app.config.removeUser(viewer.id);
    await assert.rejects(cap.context(), { status: 403 });
    await assert.rejects(cap.summaryUsage("x.testing.revoked"), { status: 403 });
    scope.close();
});

test("the original summary caller cannot receive a response after its access is revoked", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Revoked summary requester", "guest").user;
    const { scope, cap } = await bound(id, guest);
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
        release = resolve;
    });
    const key = "x.testing.revoke-original";
    const running = cap.summarize(key, {
        messages: [{ role: "user", content: "slow-deadline", timestamp: 1 }],
        timeoutMs: 100,
        onProgress: release,
    });

    await began;
    app.config.removeUser(guest.id);
    await assert.rejects(running, { status: 403 });
    const viewer = await bound(id);
    const receipt = await viewer.cap.summaryUsage(key);

    assert.equal(receipt?.usage.cost.total, 0.25, "reported usage persists despite revocation");
    assert.equal(
        (await app.harness.snapshot(SpendDoc, context))?.people[guest.id],
        0.25,
        "the frozen initiating payer is still billed",
    );
    scope.close();
    viewer.scope.close();
});

test("expectedTail compares the newest visible entry, not the compaction-first array position", async () => {
    const id = await newSession(app);

    await say(app, id, "retain this answer");
    const { scope, cap } = await bound(id);
    const kept = tailOf(await cap.context())!;
    const marker = await app.harness.commit(
        (tx) =>
            tx.appendEntry(CompactionEntry, id, {
                head: kept,
                model: [
                    {
                        role: "user",
                        content: "A summary before the retained answer.",
                        timestamp: 1,
                    },
                ],
                data: { reason: "manual" },
            }),
        context,
    );
    const view = await cap.context();

    assert.equal(view.entries[0]?.id, marker.id);
    assert.equal(view.entries.at(-1)?.id, kept);
    assert.equal(tailOf(view), marker.id);
    await assert.rejects(
        cap.update(State, (draft) => ++draft.count, { expectedTail: kept }),
        { status: 409 },
    );
    assert.equal(
        await cap.update(State, (draft) => ++draft.count, { expectedTail: tailOf(view) }),
        1,
    );
    scope.close();
});

test("expectedTail rejects stale work before mutating the extension document", async () => {
    const id = await newSession(app);
    const { scope, cap } = await bound(id);
    const expectedTail = tailOf(await cap.context());

    await cap.update(State, (draft) => ++draft.count, { expectedTail });
    await say(app, id, "change the transcript");
    let called = false;

    await assert.rejects(
        cap.update(
            State,
            (draft) => {
                called = true;
                draft.count++;
            },
            { expectedTail },
        ),
        { status: 409 },
    );
    assert.equal(called, false);
    assert.equal((await app.harness.snapshot(State, id, context))?.count, 1);
    const fresh = tailOf(await cap.context());

    assert.equal(await cap.update(State, (draft) => ++draft.count, { expectedTail: fresh }), 2);
    scope.close();
});

test("the elapsed deadline cancels a provider that keeps streaming and still bills reported usage", async () => {
    const id = await newSession(app);
    const { scope, cap } = await bound(id);
    const started = Date.now();
    const result = await cap.summarize("x.testing.deadline", {
        messages: [{ role: "user", content: "slow-deadline", timestamp: 1 }],
        timeoutMs: 60,
    });

    assert.equal(result.response.stopReason, "aborted");
    assert.ok(Date.now() - started < 2000, "continuous tokens did not extend the elapsed deadline");
    assert.equal(result.response.usage.cost.total, 0.25);
    assert.equal(app.spend.sessionSpent(id), 0.25);
    scope.close();
});

test("a joined caller's expiration cancels only its wait, not the admitted summary", async () => {
    const id = await newSession(app);
    const first = await bound(id);
    const second = await bound(id);
    const request = {
        messages: [{ role: "user" as const, content: "slow-deadline", timestamp: 1 }],
        timeoutMs: 100,
    };
    const original = first.cap.summarize("x.testing.join-lifetime", request);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const joined = second.cap.summarize("x.testing.join-lifetime", request);
    const rejected = assert.rejects(joined);

    setTimeout(() => second.scope.close(), 10);
    await rejected;
    const result = await original;

    assert.equal(result.response.stopReason, "aborted");
    assert.equal(app.spend.sessionSpent(id), 0.25);
    assert.deepEqual(await first.cap.summarize("x.testing.join-lifetime", request), result);
    first.scope.close();
});

test("oversized responses are discarded without losing their usage or durable receipt", async () => {
    const id = await newSession(app);
    const { scope, cap } = await bound(id);
    const input = {
        messages: [{ role: "user" as const, content: "oversized-response", timestamp: 1 }],
    };
    const result = await cap.summarize("x.testing.oversized", input);

    assert.equal(result.response.stopReason, "error");
    assert.equal(result.response.content.length, 0);
    assert.equal(result.response.usage.cost.total, 0.25);
    assert.equal(app.spend.sessionSpent(id), 0.25);
    assert.deepEqual(await cap.summarize("x.testing.oversized", input), result);
    scope.close();
});

test("host task capability and command capability expire at their actual lifetimes", async () => {
    const seen = globalThis as unknown as {
        testingTask?: TaskId;
        testingTaskCap?: ContextManagementCapability;
        testingCommandCap?: ContextManagementCapability;
        testingHostKeys?: string[];
    };

    writeFileSync(
        join(app.dataDir, "extensions", "testing.ts"),
        `/** Tests scoped capability lifetimes. */
import { defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";
export default (host, web) => {
    globalThis.testingHostKeys = Object.keys(host.contextManagement);
    web.command("testing-capture", { description: "Capture capability", scope: "conversation", handler: async (_args, ctx) => {
        globalThis.testingCommandCap = ctx.contextManagement;
        await ctx.contextManagement.context();
        return { type: "toast", level: "info", message: "Captured" };
    } });
    return defineExtension({ name: "testing-lifetimes", hooks: [hook(GenerationTask, { onYield: async (_answer, api, context) => {
        globalThis.testingTask = api.taskId;
        globalThis.testingTaskCap = await host.contextManagement.forTask(api.taskId, context);
        await globalThis.testingTaskCap.context();
    } })] });
};`,
    );
    await app.setExtensionEnabled(owner(app), "testing.ts", true);
    assert.deepEqual(
        seen.testingHostKeys,
        ["forTask"],
        "no arbitrary-actor factory is exposed on host",
    );
    const id = await newSession(app);

    await say(app, id, "capture task");
    assert.ok(seen.testingTaskCap);
    await assert.rejects(seen.testingTaskCap.context());
    await assert.rejects(seen.testingTaskCap.summaryUsage("x.testing.expired"));
    await assert.rejects(app.contextManagement.forTask(seen.testingTask!, context), {
        status: 409,
    });
    await app.extensionCommands.run(id, owner(app), {
        commandId: app.webs.commands().find((command) => command.name === "testing-capture")!.id,
        args: "",
        requestId: crypto.randomUUID(),
    });
    assert.ok(seen.testingCommandCap);
    await assert.rejects(seen.testingCommandCap.context());
    await assert.rejects(seen.testingCommandCap.update(State, (draft) => ++draft.count));
});
