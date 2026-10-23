/** Portable allowlisted extraction from original Durable history, never browser projections. */
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { HistoryField } from "./history.ts";
import { FILE_BLOCK } from "./entry-format.ts";

/** Literal word/number terms shared by core validation and native search. */
export function keywordTokens(text: string): string[] {
    return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export interface HistoryText {
    field: Exclude<HistoryField, "title">;
    text: string;
}

export interface HistoryExtraction {
    fields: HistoryText[];
    /** Only call IDs and target paths survive between batches. Null consumes a pending call. */
    pending: Map<string, string | null>;
}

function metadataPath(details: unknown): string | undefined {
    if (
        typeof details === "object" &&
        details !== null &&
        "path" in details &&
        typeof details.path === "string"
    ) {
        return details.path;
    }

    return undefined;
}

/** The caller owns pending state and commits its changes with the extracted rows and checkpoint. */
export function extractHistoryText(
    entry: EntryRecord,
    pending: Map<string, string>,
): HistoryExtraction {
    const result: HistoryExtraction = { fields: [], pending: new Map() };
    const texts: string[] = [];
    const paths: string[] = [];

    if (!["pi.user", "pi.assistant", "pi.compaction", "pi.tool-result"].includes(entry.kind)) {
        return result;
    }

    for (const message of entry.model ?? []) {
        if (entry.kind === "pi.tool-result") {
            if (message.role !== "toolResult") {
                continue;
            }

            const path = pending.get(message.toolCallId);

            if (path !== undefined) {
                pending.delete(message.toolCallId);
                result.pending.set(message.toolCallId, null);
            }

            if (message.toolName === "write" || message.toolName === "edit") {
                const target = metadataPath(message.details) ?? path;

                if (target !== undefined && target !== "") {
                    paths.push(target);
                }
            }

            continue;
        }

        if (entry.kind === "pi.assistant") {
            if (message.role !== "assistant") {
                continue;
            }

            for (const block of message.content) {
                if (block.type === "text") {
                    texts.push(block.text);
                } else if (
                    block.type === "toolCall" &&
                    (block.name === "write" || block.name === "edit")
                ) {
                    const path = block.arguments.path;

                    if (typeof path === "string") {
                        pending.set(block.id, path);
                        result.pending.set(block.id, path);
                    }
                }
            }

            continue;
        }

        if (message.role !== "user") {
            continue;
        }

        if (typeof message.content === "string") {
            texts.push(message.content);
        } else {
            for (const [index, block] of message.content.entries()) {
                if (
                    block.type === "text" &&
                    !(entry.kind === "pi.user" && index > 0 && block.text.startsWith(FILE_BLOCK))
                ) {
                    texts.push(block.text);
                }
            }
        }
    }

    if (texts.length > 0) {
        result.fields.push({
            field:
                entry.kind === "pi.assistant"
                    ? "assistant"
                    : entry.kind === "pi.compaction"
                      ? "summary"
                      : "user",
            text: texts.join("\n"),
        });
    }

    if (paths.length > 0) {
        result.fields.push({ field: "modifiedPath", text: paths.join("\n") });
    }

    return result;
}
