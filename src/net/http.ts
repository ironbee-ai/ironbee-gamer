/**
 * One pooled HTTP client for the calls to the decision engine.
 *
 * Every decision is a request, and a game makes hundreds of them: from Türkiye a request to a US
 * region pays a round trip of ~215 ms, and a new connection pays two more (TCP, then TLS). Node's own
 * fetch drops an idle connection after 4 s, and a game has longer pauses (a page loading between
 * episodes). Here connections speak HTTP/2 and stay open a minute while idle: after the first
 * request, a decision costs a round trip and the server's time.
 */

import { Agent, fetch as undiciFetch } from "undici";

const agent: Agent = new Agent({
    allowH2: true,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connect: { timeout: 15_000 },
});

/** `fetch` over the shared pool. */
export const pooledFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never) as unknown as Promise<Response>) as typeof fetch;

/**
 * Opens the connection to `url`'s host ahead of the first real request, so that one does not pay the
 * handshake. Fire and forget: whatever the host answers (even an error status) leaves the connection open.
 */
export function warmUp(url: string): void {
    void pooledFetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) })
        .then(async (response: Response): Promise<void> => {
            await response.body?.cancel();
        })
        .catch((): void => {
            // Only a head start: the real request connects on its own.
        });
}
