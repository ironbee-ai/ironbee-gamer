import { appendFileSync, closeSync, createReadStream, existsSync, fstatSync, ftruncateSync, openSync } from "fs";

/** An error's message — read as a field: an error of Node's own is no `instanceof Error` in another realm (a test's). */
function messageOf(err: unknown): string {
    const message: unknown = (err as { message?: unknown } | null | undefined)?.message;
    return typeof message === "string" ? message : String(err);
}

/** Reports the lines of a rows file that are no row (forEachJsonRow skips them): how many, and why the first is none. */
export type SkippedRows = (file: string, lines: number, firstError: string) => void;

/**
 * Each row of a rows file, parsed (its first `limit` rows at most), read as a stream: the files only grow — a real version's
 * reached 276.5 MB, 20–30 thousand rows of ~2.8 KB a round — and read into one string they would fail past V8's limit
 * (~512 MiB). A line that is no row — not a JSON object: a row cut short by an append that failed part of the way, the next
 * row's bytes after it on its line — is skipped and counted, and `skipped` is told once the file is read: one such line once
 * broke every later read of the version ("Unexpected end of JSON input", naming no file).
 */
export async function forEachJsonRow<T>(file: string, use: (row: T) => void, options: { limit?: number; skipped?: SkippedRows } = {}): Promise<void> {
    const limit: number = options.limit ?? Infinity;
    if (limit <= 0 || !existsSync(file)) {
        return;
    }
    let rows: number = 0;
    let skipped: number = 0;
    let firstError: string | undefined;
    /** Uses a line's row, or counts it as none; false once `limit` rows were used. */
    const take: (line: string) => boolean = (line: string): boolean => {
        let row: unknown;
        try {
            row = JSON.parse(line);
        } catch (err: unknown) {
            skipped++;
            firstError ??= messageOf(err);
            return true;
        }
        if (typeof row !== "object" || row === null || Array.isArray(row)) {
            skipped++;
            firstError ??= "not a JSON object";
            return true;
        }
        use(row as T);
        return ++rows < limit;
    };
    const report: () => void = (): void => {
        if (skipped > 0) {
            options.skipped?.(file, skipped, firstError ?? "");
        }
    };
    let rest: string = "";
    for await (const chunk of createReadStream(file, { encoding: "utf-8" })) {
        const lines: string[] = `${rest}${chunk as string}`.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
            if (line && !take(line)) {
                report();
                return;
            }
        }
    }
    if (rest) {
        take(rest);
    }
    report();
}

/**
 * Says how many lines of a rows file are no row, naming the file: once for each file, and again only when there are more —
 * a run reads its rows files many times.
 */
export function sayingSkippedRows(say: (line: string) => void): SkippedRows {
    const said: Map<string, number> = new Map();
    return (file: string, lines: number, firstError: string): void => {
        if (lines > (said.get(file) ?? 0)) {
            said.set(file, lines);
            say(`  skipped ${lines} line${lines === 1 ? "" : "s"} of ${file} that ${lines === 1 ? "is" : "are"} no row (the first: ${firstError}) — a row cut short by a write that failed`);
        }
    };
}

/**
 * Appends a row to a rows file whole, or not at all: an append that fails part of the way (a full disk) keeps the bytes it
 * wrote — a row cut short, which the next row would go on after on its line —, so the file is cut back to its size before
 * the write (as far as it can be: a line left cut short is skipped where the file is read) and the error thrown, naming the
 * file.
 */
export function appendRow(file: string, row: unknown): void {
    const text: string = `${JSON.stringify(row)}\n`;
    let fd: number | undefined;
    let size: number | undefined;
    try {
        fd = openSync(file, "a");
        size = fstatSync(fd).size;
        appendFileSync(fd, text);
    } catch (err: unknown) {
        if (fd !== undefined && size !== undefined) {
            try {
                ftruncateSync(fd, size);
            } catch {
                // As far as it can be.
            }
        }
        throw new Error(`a row could not be written to ${file}: ${messageOf(err)}`, { cause: err });
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}
