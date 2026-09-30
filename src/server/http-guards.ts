/**
 * The UI server's guards and HTTP helpers: which Host and Origin are this
 * server's own (the DNS-rebinding guard), where a client reaches it, files
 * and byte ranges for videos. Copied from IronBee Express's UI server.
 */

import { createReadStream, ReadStream, statSync } from "fs";
import { ServerResponse } from "http";
import { isIP } from "net";
import { extname } from "path";

const VIDEO_TYPES: Record<string, string> = { ".webm": "video/webm", ".mp4": "video/mp4" };

/** Binds that mean "every interface": nothing listens on them as an address. */
const WILDCARD_HOSTS: Set<string> = new Set(["", "0.0.0.0", "::"]);
/** This machine, however it is named (hostnames as `URL` spells them, without IPv6 brackets). */
const LOOPBACK_HOSTS: Set<string> = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The address to bind as `listen` takes it: an IPv6 literal without the URL
 * brackets (`[::1]` is a name to `listen`, and resolves to nothing).
 */
export function bindHost(host: string): string {
    return host.trim().replace(/^\[|\]$/g, "");
}

/** The bound host as `URL` spells a hostname (lowercase, IPv6 canonical, no brackets); as given when it will not parse. */
function canonicalHost(host: string): string {
    try {
        return new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}`).hostname.replace(/^\[|\]$/g, "");
    } catch {
        return host;
    }
}

/**
 * The host a client reaches the bound `host` through, as it goes into a URL:
 * the address itself when concrete (an IPv6 literal bracketed), loopback for a
 * wildcard bind. The daemon's live-view publisher is given this address;
 * `127.0.0.1` for a bind on another address would name a port nothing listens on.
 */
export function reachableHost(host: string): string {
    if (WILDCARD_HOSTS.has(host)) {
        return "127.0.0.1";
    }
    return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * A request target's path; undefined when it does not parse as one (`//`, `//@`: `URL` reads them as a host
 * and throws), which the server refuses instead of letting the throw end the process.
 */
export function requestPath(target: string | undefined): string | undefined {
    try {
        return new URL(target ?? "/", "http://x").pathname;
    } catch {
        return undefined;
    }
}

/**
 * Whether a request's `Host` header names this server: the bound host, loopback
 * or `localhost` on the UI's port — and, for a wildcard bind, any IP literal on
 * that port (the machine's addresses are not known here). A DNS name other than
 * `localhost` or the bound name itself is never accepted: that is the DNS-rebinding guard.
 */
export function hostAllowed(header: string | undefined, host: string, port: number): boolean {
    if (!header) {
        return false;
    }
    let url: URL;
    try {
        url = new URL(`http://${header}`);
    } catch {
        return false;
    }
    if ((url.port || "80") !== String(port) || url.pathname !== "/" || url.search || url.hash || url.username) {
        return false;
    }
    const hostname: string = url.hostname.replace(/^\[|\]$/g, "");
    if (LOOPBACK_HOSTS.has(hostname)) {
        return true;
    }
    // `URL` lowercases a name and canonicalises an IPv6 literal: compare the bound host the same way.
    if (!WILDCARD_HOSTS.has(host) && hostname === canonicalHost(host)) {
        return true;
    }
    return WILDCARD_HOSTS.has(host) && isIP(hostname) !== 0;
}

/**
 * Whether an `Origin` is this UI's own: `http://` + an allowed host, the one the
 * request was sent to (its `Host`, allowed too) — or loopback both. On a wildcard
 * bind every IP literal is an allowed host: without the match, a page served from
 * another machine's address on this port would pass.
 */
export function originAllowed(origin: string | undefined, hostHeader: string | undefined, host: string, port: number): boolean {
    if (typeof origin !== "string" || !origin.startsWith("http://")) {
        return false;
    }
    const from: string = origin.slice("http://".length);
    if (!hostAllowed(from, host, port) || !hostAllowed(hostHeader, host, port)) {
        return false;
    }
    // Both parse (both were allowed); `URL` spells them alike (case, IPv6, the default port).
    const page: URL = new URL(`http://${from}`);
    const asked: URL = new URL(`http://${hostHeader}`);
    const loopback: (url: URL) => boolean = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
    return page.host === asked.host || (loopback(page) && loopback(asked));
}

/**
 * One `bytes=start-end` range against a file of `size` bytes: the inclusive
 * byte span; `undefined` when there is no range to honor (no header, another
 * unit, several ranges or a malformed one — the whole file is served, as RFC
 * 9110 has it); `null` for a well-formed one that cannot be satisfied (416).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
    if (header === undefined) {
        return undefined;
    }
    const match: RegExpMatchArray | null = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) {
        return undefined;
    }
    if (match[1] === "" && match[2] === "") {
        return null;
    }
    if (match[1] === "") {
        // The last N bytes.
        const suffix: number = Number(match[2]);
        if (suffix === 0 || size === 0) {
            return null;
        }
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start: number = Number(match[1]);
    const end: number = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start >= size || start > end) {
        return null;
    }
    return { start, end };
}

/**
 * Sends a file whole once it is open: one gone since it was found, or that
 * cannot be read, is a 404, and one that fails mid-stream ends the response —
 * never the process's error.
 */
export function serveFile(res: ServerResponse, file: string, type: string): void {
    const size: number = statSync(file).size;
    const stream: ReadStream = createReadStream(file);
    stream.on("error", (): void => {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "the file cannot be read" }));
    });
    stream.on("open", (): void => {
        res.writeHead(200, { "content-type": type, "content-length": String(size), "cache-control": "no-store" });
        stream.pipe(res);
    });
    res.on("close", (): void => {
        stream.destroy();
    });
}

/**
 * Streams a video file, whole or one byte range (206): a player seeks, and
 * some refuse to play without ranges. A file that fails mid-stream ends the
 * response; it is never the process's error.
 */
export function serveVideo(res: ServerResponse, file: string, rangeHeader: string | undefined): void {
    const size: number = statSync(file).size;
    const type: string = VIDEO_TYPES[extname(file)] ?? "application/octet-stream";
    const range: { start: number; end: number } | null | undefined = parseRange(rangeHeader, size);
    if (range === null) {
        res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
        res.end();
        return;
    }
    const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes" };
    let stream: ReadStream;
    if (range) {
        headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
        headers["content-length"] = String(range.end - range.start + 1);
        res.writeHead(206, headers);
        stream = createReadStream(file, { start: range.start, end: range.end });
    } else {
        headers["content-length"] = String(size);
        res.writeHead(200, headers);
        stream = createReadStream(file);
    }
    stream.on("error", (): void => {
        res.destroy();
    });
    res.on("close", (): void => {
        stream.destroy();
    });
    stream.pipe(res);
}
