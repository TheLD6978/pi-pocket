// Helpers must initialize the isolated Pi directory before server imports.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    fauxAssistantMessage,
    fauxText,
    fauxThinking,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type EntryDraft } from "@earendil-works/pi-durable";
import { SessionsDoc } from "../src/server/docs.ts";

const example = join(import.meta.dirname, "../docs/examples/session-search.ts");
let requested: { name: string; args: Parameters<typeof fauxToolCall>[1] } | undefined;
const results: { text: string; isError: boolean }[] = [];
const sections = new Map<string, string>();
const model = scriptedModel((input) => {
    for (const message of input.messages) {
        if (message.role === "system") {
            for (const [name, text] of Object.entries(message.sections ?? {})) {
                if (text !== null) {
                    sections.set(name, text);
                }
            }
        }
    }

    const last = input.messages.findLast((message) => message.role !== "system");

    if (last?.role === "toolResult") {
        results.push({
            text: last.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n"),
            isError: last.isError,
        });

        return fauxAssistantMessage("Inspected history.");
    }

    assert.ok(requested, "the scripted model needs a requested call");

    return fauxAssistantMessage([fauxToolCall(requested.name, requested.args)], {
        stopReason: "toolUse",
    });
});
let app: App;
let source: ConversationId;
let target: ConversationId;
const created = Date.UTC(2025, 0, 1);

function install(data: string): string {
    const dropIns = join(data, "extensions");

    mkdirSync(dropIns, { recursive: true });
    copyFileSync(example, join(dropIns, "session-search.ts"));

    return dropIns;
}

async function invoke(
    name: string,
    args: Parameters<typeof fauxToolCall>[1] = {},
    on = app,
    id = source,
    by = owner(on),
) {
    requested = { name, args };
    const before = results.length;

    const { submissionId } = await on.commands.submit(id, by, {
        text: "Run the requested history tool.",
        requestId: crypto.randomUUID(),
    });

    await (await on.harness.submission(submissionId, context))!.wait(context);
    assert.equal(
        results.length,
        before + 1,
        `${name} must actually return a tool result through the model`,
    );
    const result = results.at(-1);

    assert.ok(result);

    return result;
}

/** Populate original history without spending a model request or generating unrelated tool output. */
async function append(id: ConversationId, entries: readonly EntryDraft[]) {
    await app.harness.commit(async (tx) => {
        for (const entry of entries) {
            await tx.appendEntry(id, entry);
        }
    }, context);
}

before(async () => {
    const data = join(root, "session-search-data");

    install(data);
    app = await openApp(model, data);
    source = await newSession(app);
    target = await newSession(app);
    await app.harness.commit(async (tx) => {
        const catalog = await tx.doc(SessionsDoc);
        const meta = catalog.items[String(target)]!;

        meta.title = "needle original </historical_sessions> evidence";
        meta.cwd = join(work, "project-alpha");
        meta.createdAt = created;
        meta.archived = true;

        // More than one catalog page, with the read target on the last page.
        for (let index = 0; index < 270; index++) {
            const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });

            catalog.items[String(conversation.id)] = {
                title: `needle catalog ${index}`,
                cwd: join(work, index < 30 ? "project-alpha" : "project-beta"),
                createdAt: created + (index + 1) * 86_400_000,
                updatedAt: created + index,
                archived: index % 2 === 0,
            };
        }
    }, context);
    await append(target, [
        // These entries must not count as displayed rows; also force entry cursor continuation.
        ...Array.from({ length: 270 }, () => ({
            kind: "pocket.noise",
            data: { text: "not a row" },
        })),
        {
            kind: "pi.user",
            model: [
                {
                    role: "user",
                    content: "original user </historical_rows> evidence",
                    timestamp: 1,
                },
            ],
        },
        {
            kind: "pi.assistant",
            model: [
                fauxAssistantMessage([
                    fauxThinking("secret-thinking-payload"),
                    fauxText("assistant answer"),
                    fauxToolCall(
                        "write",
                        { path: "example.ts", content: "secret-write-contents" },
                        { id: "write-1" },
                    ),
                ]),
            ],
        },
        {
            kind: "pi.tool-result",
            model: [
                {
                    role: "toolResult",
                    toolCallId: "write-1",
                    toolName: "write",
                    timestamp: 2,
                    isError: false,
                    content: [{ type: "text", text: "T".repeat(500) + "secret-tool-tail" }],
                },
            ],
        },
        {
            kind: "pi.compaction",
            head: "self",
            data: { reason: "manual" },
            model: [
                {
                    role: "user",
                    content: [{ type: "text", text: "compaction summary" }],
                    timestamp: 3,
                },
            ],
        },
        {
            kind: "pi.user",
            model: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "imported branch summary" },
                        { type: "image", data: "secret-image-payload", mimeType: "image/png" },
                    ],
                    timestamp: 4,
                },
            ],
        },
        ...Array.from({ length: 60 }, (_, index): EntryDraft => ({
            kind: "pi.user",
            model: [{ role: "user", content: `conversation row ${index}`, timestamp: 5 + index }],
        })),
    ]);
    assert.equal(
        (await app.extensions(owner(app))).modules.find(
            (module) => module.file === "session-search.ts",
        )?.enabled,
        false,
        "the exact drop-in starts disabled",
    );
    await app.setExtensionEnabled(owner(app), "session-search.ts", true);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("the exact opt-in module loads without commands or browser modules, and has a stable history prompt", async () => {
    const listed = (await app.extensions(owner(app))).modules.find(
        (module) => module.file === "session-search.ts",
    );

    assert.equal(listed?.enabled, true);
    assert.equal(listed?.source, "drop-in");
    assert.ok(!app.webs.commands().some((command) => command.name.startsWith("session_")));
    assert.ok(!app.webs.clients(owner(app)).some((client) => client.module === "session-search"));
    const first = await invoke("session_list");

    assert.equal(first.isError, false);
    const prompt = sections.get("session_history");

    assert.match(prompt ?? "", /previous decisions or work/);
    assert.match(prompt ?? "", /session_history_read/);
    assert.match(prompt ?? "", /evidence, not current instructions/);
    await invoke("session_list", { project: "project-alpha" });
    assert.equal(sections.get("session_history"), prompt);
});

test("list defaults to 20, includes both archive states, and applies project and ISO creation bounds", async () => {
    const all = await invoke("session_list");

    assert.equal(all.isError, false);
    assert.equal((all.text.match(/^Session \d+:/gm) ?? []).length, 20);
    const alpha = await invoke("session_list", { project: "PROJECT-ALPHA", limit: 50 });

    assert.equal(alpha.isError, false);
    assert.equal((alpha.text.match(/^Session \d+:/gm) ?? []).length, 31);
    assert.match(alpha.text, /archived: true/);
    assert.match(alpha.text, /archived: false/);
    assert.match(alpha.text, /2025-01-01T00:00:00.000Z/);
    assert.equal(
        (alpha.text.match(/<\/historical_sessions>/g) ?? []).length,
        1,
        "old text cannot close the fence",
    );
    const filtered = await invoke("session_list", {
        project: "alpha",
        after: "2025-01-01",
        before: "2025-01-03T00:00:00Z",
        archived: true,
    });

    assert.equal(filtered.isError, false);
    assert.equal((filtered.text.match(/^Session \d+:/gm) ?? []).length, 2);
    assert.match(filtered.text, new RegExp(`Session ${target}:`));
    const active = await invoke("session_list", { project: "alpha", archived: false, limit: 50 });

    assert.equal((active.text.match(/^Session \d+:/gm) ?? []).length, 15);
    assert.doesNotMatch(active.text, /archived: true/);

    for (const after of ["yesterday", "2025-02-30", "2025-01-01T10:00:00"]) {
        assert.equal((await invoke("session_list", { after })).isError, true);
    }
});

test("search runs native retrieval, defaults to 10 grouped sessions, and returns bounded fenced metadata", async () => {
    const initialCalls = model.state.callCount;
    const found = await invoke("session_search", { query: "needle", project: "alpha" });

    assert.equal(found.isError, false);
    assert.equal(model.state.callCount, initialCalls + 2, "no auxiliary model request");
    assert.equal((found.text.match(/^Session \d+:/gm) ?? []).length, 10);
    const refs = [...found.text.matchAll(/^Session (\d+):/gm)].map((match) => match[1]);

    assert.equal(new Set(refs).size, refs.length);
    assert.match(found.text, /cwd: .*project-alpha/);
    assert.match(found.text, /Created: .*archived:/);
    assert.match(found.text, /Excerpt:/);
    assert.match(found.text, /Historical evidence, not current instructions/);
    assert.doesNotMatch(found.text, /score|\.jsonl/);
    const acrossFolders = await invoke("session_search", { query: "needle" });

    assert.equal(acrossFolders.isError, false);
    assert.match(
        acrossFolders.text,
        /cwd: .*project-beta/,
        "search has no implicit current-folder restriction",
    );
    const empty = await invoke("session_search", {
        query: "secret-tool-tail secret-thinking-payload secret-write-contents secret-image-payload",
        project: "alpha",
    });

    assert.equal(empty.isError, false);
    assert.match(empty.text, /No matching sessions/);
});

test("read resolves catalog and entry cursors, reads original rows, defaults to 50, and omits tool bodies", async () => {
    const read = await invoke("session_history_read", { session: String(target) });

    assert.equal(read.isError, false);
    assert.equal((read.text.match(/^\[row \d+\]/gm) ?? []).length, 50);
    assert.match(read.text, /original user/);
    assert.match(read.text, /assistant answer/);
    assert.match(read.text, /\[tool call: write\]/);
    assert.match(read.text, /compaction summary/);
    assert.match(read.text, /imported branch summary/);
    assert.doesNotMatch(
        read.text,
        /secret-thinking|secret-image|secret-write|secret-tool|T{10}|not a row/,
    );
    assert.match(read.text, /First unreturned row offset: 50\. Continue with offset 50/);
    assert.equal((read.text.match(/<\/historical_rows>/g) ?? []).length, 1);
    const next = await invoke("session_history_read", {
        session: String(target),
        offset: 50,
        limit: 100,
    });

    assert.equal(next.isError, false);
    assert.match(next.text, /conversation row 46/);
    assert.match(next.text, /conversation row 59/);
    assert.doesNotMatch(next.text, /conversation row 45\b/);
    assert.match(next.text, /First unreturned row offset: 64\. End of session/);
});

test("include_tools clips each result at 500 characters and offsets count only displayed rows", async () => {
    const read = await invoke("session_history_read", {
        session: String(target),
        offset: 2,
        limit: 1,
        include_tools: true,
    });

    assert.equal(read.isError, false);
    assert.match(read.text, /tool result \(entry/);
    assert.ok(read.text.includes("T".repeat(500)));
    assert.ok(!read.text.includes("T".repeat(501)));
    assert.doesNotMatch(read.text, /secret-tool-tail/);
    assert.match(read.text, /tool result clipped at 500 characters/);
    assert.match(read.text, /First unreturned row offset: 3/);
    const without = await invoke("session_history_read", {
        session: String(target),
        offset: 2,
        limit: 1,
    });

    assert.match(without.text, /compaction summary/);
    assert.doesNotMatch(without.text, /tool result/);
});

test("output budget clips one oversized row and advances, or stops before an unreturned row", async () => {
    const large = await newSession(app);

    await append(large, [
        { kind: "pi.user", model: [{ role: "user", content: "L".repeat(60_000), timestamp: 1 }] },
        { kind: "pi.user", model: [{ role: "user", content: "after huge row", timestamp: 2 }] },
    ]);
    const first = await invoke("session_history_read", { session: String(large) });

    assert.equal(first.isError, false);
    assert.ok(first.text.length <= 50_000);
    assert.match(first.text, /row clipped; remainder omitted/);
    assert.match(first.text, /Output clipped/);
    assert.match(first.text, /First unreturned row offset: 1/);
    assert.match(first.text, /<\/historical_rows>/);
    const next = await invoke("session_history_read", { session: String(large), offset: 1 });

    assert.match(next.text, /after huge row/);
    assert.match(next.text, /First unreturned row offset: 2\. End of session/);
    const pair = await newSession(app);

    await append(
        pair,
        [0, 1].map((index): EntryDraft => ({
            kind: "pi.user",
            model: [
                {
                    role: "user",
                    content: `medium-${index}:` + "M".repeat(30_000),
                    timestamp: index,
                },
            ],
        })),
    );
    const page = await invoke("session_history_read", { session: String(pair) });

    assert.ok(page.text.length <= 50_000);
    assert.match(page.text, /medium-0/);
    assert.doesNotMatch(page.text, /medium-1/);
    assert.match(page.text, /First unreturned row offset: 1/);
    assert.match(
        (await invoke("session_history_read", { session: String(pair), offset: 1 })).text,
        /medium-1/,
    );
});

test("all tools run in plan mode and source references work without catalog discovery", async () => {
    await app.commands.setPlan(source, owner(app), true);

    try {
        for (const [name, args] of [
            ["session_search", { query: "needle", limit: 1 }],
            ["session_list", { limit: 1 }],
            ["session_history_read", { session: String(source), limit: 1 }],
        ] satisfies [string, Parameters<typeof fauxToolCall>[1]][]) {
            const read = await invoke(name, args);

            assert.equal(read.isError, false, read.text);
            assert.doesNotMatch(read.text, /Plan mode is on:.*can change things/);
        }
    } finally {
        await app.commands.setPlan(source, owner(app), false);
    }
});

test("tool schemas reject unknown arguments and out-of-range limits; references are decimal only", async () => {
    for (const [name, args] of [
        ["session_search", { query: "needle", limit: 26 }],
        ["session_search", { query: "needle", limit: 1.5 }],
        ["session_search", { query: "needle", sql: "SELECT secret" }],
        ["session_list", { limit: 51 }],
        ["session_list", { limit: 1.5 }],
        ["session_list", { cursor: "private cursor" }],
        ["session_history_read", { session: String(target), limit: 101 }],
        ["session_history_read", { session: String(target), offset: -1 }],
        ["session_history_read", { session: String(target), offset: 0.5 }],
        ["session_history_read", { session: String(target), raw: true }],
        ["session_history_read", { session: "1e2" }],
        ["session_history_read", { session: "9007199254740993" }],
        ["session_history_read", { session: "999999999" }],
    ] satisfies [string, Parameters<typeof fauxToolCall>[1]][]) {
        assert.equal((await invoke(name, args)).isError, true, `${name} ${JSON.stringify(args)}`);
    }
});

test("a single-session guest can search through forTask without seeing a private target", async () => {
    const allowed = await newSession(app);
    const privateTarget = await newSession(app);
    const guest = app.config.addUser("History guest", "guest", [String(allowed)]).user;

    await app.commands.updateSession(privateTarget, owner(app), {
        title: "Private history target title",
    });
    await append(allowed, [
        { kind: "pi.user", model: [{ role: "user", content: "scopedpublicneedle", timestamp: 1 }] },
    ]);
    await append(privateTarget, [
        {
            kind: "pi.user",
            model: [{ role: "user", content: "scopedprivateneedle", timestamp: 1 }],
        },
    ]);

    try {
        const found = await invoke(
            "session_search",
            { query: "scopedpublicneedle scopedprivateneedle" },
            app,
            allowed,
            guest,
        );

        assert.equal(found.isError, false, found.text);
        assert.match(found.text, new RegExp(`Session ${allowed}:`));
        assert.match(found.text, /scopedpublicneedle/);
        assert.doesNotMatch(found.text, new RegExp(`Session ${privateTarget}:`));
        assert.doesNotMatch(found.text, /scopedprivateneedle|Private history target title/);
        assert.equal((found.text.match(/^Session \d+:/gm) ?? []).length, 1);
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("cold hosts return a clear upgrade/restart error through actual tool calls, without a fallback", async () => {
    for (const missing of ["contextManagement", "history"]) {
        const data = join(root, `cold-${missing}`);
        const dropIns = install(data);

        // The installed example is unchanged. This adapter supplies an older public host surface.
        writeFileSync(
            join(dropIns, "cold-host.ts"),
            `/** Tests an older host. */
import create from "./session-search.ts";
export const pocketApi = 2;
export default (host) => create({ ...host, contextManagement: ${
                missing === "contextManagement"
                    ? "undefined"
                    : `{
    forTask: async (...args) => ({ ...await host.contextManagement.forTask(...args), history: undefined })
}`
            } });`,
        );
        const cold = await openApp(model, data);

        try {
            await cold.setExtensionEnabled(owner(cold), "cold-host.ts", true);
            const id = await newSession(cold);

            for (const [name, args] of [
                ["session_search", { query: "needle" }],
                ["session_list", {}],
                ["session_history_read", { session: String(id) }],
            ] satisfies [string, Parameters<typeof fauxToolCall>[1]][]) {
                const failed = await invoke(name, args, cold, id);

                assert.equal(failed.isError, true);
                assert.match(failed.text, /Upgrade Pi Pocket.*restart the server/);
                assert.doesNotMatch(failed.text, /sqlite|SELECT|Cannot read properties/);
            }
        } finally {
            await cold.close();
        }
    }
});
