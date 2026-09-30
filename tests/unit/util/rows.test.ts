/**
 * The rows files' reading and appending: a line that is no row (a row cut short) is skipped and said, never thrown; an
 * append that fails part of the way leaves no row cut short.
 */

import { appendRow, forEachJsonRow, sayingSkippedRows, SkippedRows } from "../../../src/util/rows";

import fs, { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** A full disk: the first `bytes` of what is written go in, then the write fails. */
function fullDisk(bytes: number): (target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => void {
    return (target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView): void => {
        fs.writeSync(target as number, String(data).slice(0, bytes));
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    };
}

describe("rows files", (): void => {
    let root: string;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-rows-"));
    });

    afterEach((): void => {
        jest.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    /** The rows read, and what was said of the lines skipped. */
    async function read(file: string, limit?: number): Promise<{ rows: unknown[]; skipped: Array<[string, number, string]> }> {
        const rows: unknown[] = [];
        const skipped: Array<[string, number, string]> = [];
        await forEachJsonRow(file, (row: unknown): number => rows.push(row), {
            limit,
            skipped: (f: string, lines: number, firstError: string): number => skipped.push([f, lines, firstError]),
        });
        return { rows, skipped };
    }

    it("skips a row cut short — the last line, or one in the middle the next row went on after —, counts it, and says so once, naming the file", async (): Promise<void> => {
        const file: string = path.join(root, "rows.jsonl");
        // A row cut short in the middle (the next row appended after its bytes, on its line), and one at the end.
        writeFileSync(file, `{"n":1}\n{"n":2,"text":"cut sh{"n":3}\n{"n":4}\n{"n":5,"te`);
        const { rows, skipped } = await read(file);
        // The one the torn row took with it is lost; every other is read.
        expect(rows).toEqual([{ n: 1 }, { n: 4 }]);
        expect(skipped).toEqual([[file, 2, expect.stringMatching(/JSON/)]]);
        // It once threw at the first of them: "Unexpected end of JSON input", naming no file.
        expect((): unknown => JSON.parse(`{"n":5,"te`)).toThrow(SyntaxError);
    });

    it("skips a line that parses as no JSON object, and counts the rows of a limit, not the lines", async (): Promise<void> => {
        const file: string = path.join(root, "rows.jsonl");
        writeFileSync(file, ["42", "null", "[1]", '{"n":1}', '"text"', '{"n":2}', '{"n":3}'].join("\n"));
        const all: { rows: unknown[]; skipped: Array<[string, number, string]> } = await read(file);
        expect(all.rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
        expect(all.skipped).toEqual([[file, 4, "not a JSON object"]]);
        // The first two rows: the lines that are none before and between them are no rows of the limit.
        expect((await read(file, 2)).rows).toEqual([{ n: 1 }, { n: 2 }]);
        // Nothing skipped, nothing said; no file, no rows.
        writeFileSync(file, '{"n":1}\n');
        expect(await read(file)).toEqual({ rows: [{ n: 1 }], skipped: [] });
        expect(await read(path.join(root, "none.jsonl"))).toEqual({ rows: [], skipped: [] });
    });

    it("says the lines skipped once for each file, again only when there are more: a run reads its files many times", (): void => {
        const said: string[] = [];
        const skipped: SkippedRows = sayingSkippedRows((line: string): number => said.push(line));
        skipped("/a.jsonl", 1, "Unexpected end of JSON input");
        skipped("/a.jsonl", 1, "Unexpected end of JSON input");
        skipped("/b.jsonl", 3, "not a JSON object");
        skipped("/a.jsonl", 2, "Unexpected end of JSON input");
        expect(said).toEqual([
            "  skipped 1 line of /a.jsonl that is no row (the first: Unexpected end of JSON input) — a row cut short by a write that failed",
            "  skipped 3 lines of /b.jsonl that are no row (the first: not a JSON object) — a row cut short by a write that failed",
            "  skipped 2 lines of /a.jsonl that are no row (the first: Unexpected end of JSON input) — a row cut short by a write that failed",
        ]);
    });

    it("appends a row whole or not at all: one that fails part of the way is cut back, and the error names the file", (): void => {
        const file: string = path.join(root, "rows.jsonl");
        appendRow(file, { n: 1 });
        const before: string = readFileSync(file, "utf-8");
        expect(before).toBe('{"n":1}\n');
        jest.spyOn(fs, "appendFileSync").mockImplementationOnce(fullDisk(9));
        expect((): void => appendRow(file, { n: 2, text: "a row longer than what went in" })).toThrow(
            `a row could not be written to ${file}: ENOSPC: no space left on device, write`
        );
        // Kept, its bytes were a row cut short, and the next row went on after them on its line: both lost to every reader.
        expect(readFileSync(file, "utf-8")).toBe(before);
        appendRow(file, { n: 3 });
        expect(readFileSync(file, "utf-8")).toBe('{"n":1}\n{"n":3}\n');
    });

    it("appends to no file it cannot open, and says which; one that fails is cut back to what the file held, whatever it held", (): void => {
        const file: string = path.join(root, "missing-dir", "rows.jsonl");
        expect((): void => appendRow(file, { n: 1 })).toThrow(new RegExp(`^a row could not be written to ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: ENOENT`));
        // A row cut short before (a write that failed before appends were cut back) stays as it was: the readers skip it.
        const other: string = path.join(root, "rows.jsonl");
        appendFileSync(other, '{"n":1}\n{"n":2,"te');
        jest.spyOn(fs, "appendFileSync").mockImplementationOnce(fullDisk(3));
        expect((): void => appendRow(other, { n: 3 })).toThrow(/ENOSPC/);
        expect(readFileSync(other, "utf-8")).toBe('{"n":1}\n{"n":2,"te');
    });
});
