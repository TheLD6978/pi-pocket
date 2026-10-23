/** Pocket persistence: Durable records and an optional native, read-only history-search companion. */
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HistoryField, HistoryMatchSource, HistorySession } from "./history.ts";
import { SqliteHistorySearch } from "./history-index.ts";

export interface HistorySearchTarget extends HistorySession {
    through: EntryId | null;
}

export interface BackendHistoryMatch {
    conversationId: ConversationId;
    source: HistoryMatchSource;
    snippet: string;
}

export interface HistorySearchBackend {
    search(
        request: {
            targets: readonly HistorySearchTarget[];
            text: string;
            fields: readonly HistoryField[];
            groupBy: "entry" | "conversation";
            limit: number;
        },
        context: Context,
    ): Promise<readonly BackendHistoryMatch[]>;
    /** Stop work without closing shared Storage; safe before startup or after Storage has closed. */
    close(context: Context): Promise<void>;
}

export interface PocketPersistence {
    /** Close must be idempotent: Harness can close internally before startup rejects. */
    storage: Storage;
    historySearch?: HistorySearchBackend;
}

export type OpenPersistence = (options: {
    dataDir: string;
    context: Context;
}) => Promise<PocketPersistence>;

/** Keep the current database path and Durable schema; search creates only lazy, derived tables. */
export const openSqlitePersistence: OpenPersistence = async ({ dataDir }) => {
    const database = await openNodeSqliteDatabase(join(dataDir, "pocket.sqlite"));
    const storage = await SqliteStorage.open(database);

    return { storage, historySearch: new SqliteHistorySearch(database, storage) };
};
