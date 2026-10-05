/**
 * Reading the shared library from Hugging Face over HTTPS, as `hf download` would: `<endpoint>/<repo>/resolve/<rev>/<path>`,
 * a private repo with the token (HF_TOKEN, else the one `hf auth login` keeps). The index is read first, and every file
 * of a pull at the commit it came from — a push landing meanwhile does not mix two of them. Each file is checked against
 * its size and sha256 in the index before it takes its place.
 */

import { DEFAULT_HF_REPO, HF_LIBRARY_FORMAT, HfFile, HfIndex, HfSource } from "./types";

import { createHash } from "crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import path from "path";
import { Readable, Transform, TransformCallback } from "stream";
import { pipeline } from "stream/promises";

/** A request to Hugging Face that failed: its status, and what to do about it in words. */
export class HfError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = "HfError";
    }
}

/** The token the Hugging Face CLI keeps (`hf auth login`): HF_TOKEN_PATH, else <HF_HOME>/token. */
function storedToken(env: NodeJS.ProcessEnv): string | undefined {
    const hfHome: string = env.HF_HOME || path.join(homedir(), ".cache", "huggingface");
    try {
        return readFileSync(env.HF_TOKEN_PATH || path.join(hfHome, "token"), "utf-8").trim() || undefined;
    } catch {
        return undefined;
    }
}

/** Where the shared library is read from: IBGAMER_HF_REPO at IBGAMER_HF_REVISION (main) on HF_ENDPOINT. */
export function hfSource(env: NodeJS.ProcessEnv = process.env, overrides: { repo?: string; revision?: string } = {}): HfSource {
    const token: string | undefined = env.HF_TOKEN || storedToken(env);
    return {
        endpoint: (env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, ""),
        repo: overrides.repo || env.IBGAMER_HF_REPO || DEFAULT_HF_REPO,
        revision: overrides.revision || env.IBGAMER_HF_REVISION || "main",
        ...(token ? { token } : {}),
    };
}

/** A file's address in the repo at a revision (a branch, a commit). */
export function resolveUrl(source: HfSource, revision: string, repoPath: string): string {
    const encoded: string = repoPath
        .split("/")
        .map((part: string): string => encodeURIComponent(part))
        .join("/");
    return `${source.endpoint}/${source.repo}/resolve/${encodeURIComponent(revision)}/${encoded}`;
}

function headers(source: HfSource): Record<string, string> {
    return source.token ? { authorization: `Bearer ${source.token}` } : {};
}

/** What a failed answer means for a reader. */
function failure(source: HfSource, what: string, status: number): HfError {
    if (status === 401 || status === 403) {
        return new HfError(`${source.repo} is private, or not there: log in to Hugging Face (hf auth login) or set HF_TOKEN to read ${what}`, status);
    }
    return new HfError(`Hugging Face answered ${status} for ${what} in ${source.repo}`, status);
}

/**
 * The repo's index and the commit it was read at — undefined when the repo has none yet (a 404: no repo, or nothing
 * pushed). An index of a newer layout than this app reads is refused.
 */
export async function fetchIndex(source: HfSource, signal?: AbortSignal): Promise<{ index: HfIndex; commit: string } | undefined> {
    const res: Response = await fetch(resolveUrl(source, source.revision, "index.json"), { headers: headers(source), ...(signal ? { signal } : {}) });
    if (res.status === 404) {
        return undefined;
    }
    if (!res.ok) {
        throw failure(source, "its index", res.status);
    }
    const index: HfIndex = (await res.json()) as HfIndex;
    if (typeof index?.format !== "number" || !Array.isArray(index.games)) {
        throw new HfError(`${source.repo}'s index.json is not a library index`);
    }
    if (index.format > HF_LIBRARY_FORMAT) {
        throw new HfError(`${source.repo} holds a newer library (format ${index.format}): update ironbee-gamer to read it`);
    }
    return { index, commit: res.headers.get("x-repo-commit") || source.revision };
}

/** A file's sha256, read in pieces (a checkpoint is ~650 MB). */
export function sha256Of(file: string): Promise<string> {
    return new Promise<string>((resolve: (hash: string) => void, reject: (err: Error) => void): void => {
        const hash: ReturnType<typeof createHash> = createHash("sha256");
        createReadStream(file)
            .on("data", (chunk: string | Buffer): void => {
                hash.update(chunk);
            })
            .on("error", reject)
            .on("end", (): void => resolve(hash.digest("hex")));
    });
}

/** Whether a file on disk is the one the index lists (its size, then its sha256). */
export async function hasFile(dest: string, file: HfFile): Promise<boolean> {
    return existsSync(dest) && statSync(dest).size === file.size && (await sha256Of(dest)) === file.sha256;
}

/**
 * Downloads a file of the repo at a commit into `dest`, through `dest.part`: in place only once its size and sha256
 * are the index's (a file already there that is skips the download — a pull stopped part way goes on from it).
 * `onBytes` hears every piece as it comes.
 */
export async function downloadFile(source: HfSource, commit: string, file: HfFile, dest: string, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<void> {
    if (await hasFile(dest, file)) {
        onBytes?.(file.size);
        return;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    const res: Response = await fetch(resolveUrl(source, commit, file.path), { headers: headers(source), ...(signal ? { signal } : {}) });
    if (!res.ok || !res.body) {
        throw failure(source, file.path, res.status);
    }
    const part: string = `${dest}.part`;
    const hash: ReturnType<typeof createHash> = createHash("sha256");
    let size: number = 0;
    const counting: Transform = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
            hash.update(chunk);
            size += chunk.length;
            onBytes?.(chunk.length);
            done(null, chunk);
        },
    });
    try {
        await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), counting, createWriteStream(part), ...(signal ? [{ signal }] : []));
        const sha256: string = hash.digest("hex");
        if (size !== file.size || sha256 !== file.sha256) {
            throw new HfError(`${file.path} came with ${size} bytes and sha256 ${sha256.slice(0, 12)}…, not the index's ${file.size} and ${file.sha256.slice(0, 12)}…: not kept`);
        }
        renameSync(part, dest);
    } catch (err: unknown) {
        if (existsSync(part)) {
            unlinkSync(part);
        }
        throw err;
    }
}
