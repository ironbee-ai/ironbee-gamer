/**
 * The live-view hub. IronBee DevTools' live-view publisher (enabled by
 * LIVE_VIEW_WS_URL + LIVE_VIEW_TOKEN in the daemon's environment) connects
 * here as the PRODUCER while a recording runs and sends JPEG frames:
 *
 *   0x01 | u32BE headerLen | header JSON {seq, ts, viewportWidth, viewportHeight} | JPEG
 *
 * Frames are relayed unchanged to every VIEWER (browser tabs of the UI), which
 * also receive the run's JSON events. The hub tells the producer its target
 * frame rate and viewer count. Human control is never granted here — the
 * engine plays — so a viewer's input is never relayed.
 */

import { RawData, WebSocket } from "ws";

/** A game moves every frame: as many as the publisher allows (LIVE_VIEW_MAX_FPS). */
const TARGET_FPS: number = 25;
/** A viewer this far behind skips frames rather than queueing them. */
const VIEWER_BACKLOG_BYTES: number = 2 * 1024 * 1024;

export class LiveHub {
    private readonly viewers: Set<WebSocket> = new Set();
    private readonly producers: Set<WebSocket> = new Set();
    private lastFrame: Buffer | undefined;

    get viewerCount(): number {
        return this.viewers.size;
    }

    get producerConnected(): boolean {
        return this.producers.size > 0;
    }

    addProducer(socket: WebSocket): void {
        this.producers.add(socket);
        this.guard(socket);
        this.sendState(socket);
        socket.on("message", (data: RawData, isBinary: boolean): void => {
            if (!isBinary) {
                // Spans / logs / tool calls: not shown by this UI.
                return;
            }
            const frame: Buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            this.lastFrame = frame;
            for (const viewer of this.viewers) {
                if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < VIEWER_BACKLOG_BYTES) {
                    viewer.send(frame, { binary: true });
                }
            }
        });
        socket.on("close", (): void => {
            this.producers.delete(socket);
        });
    }

    addViewer(socket: WebSocket): void {
        this.viewers.add(socket);
        this.guard(socket);
        if (this.lastFrame) {
            socket.send(this.lastFrame, { binary: true });
        }
        this.broadcastState();
        socket.on("close", (): void => {
            this.viewers.delete(socket);
            this.broadcastState();
        });
    }

    /** A JSON event to every viewer. */
    broadcast(message: unknown): void {
        const text: string = JSON.stringify(message);
        for (const viewer of this.viewers) {
            if (viewer.readyState === WebSocket.OPEN) {
                viewer.send(text);
            }
        }
    }

    /** Forgets the last frame, so a new run does not open on the previous page. */
    resetFrame(): void {
        this.lastFrame = undefined;
    }

    closeAll(): void {
        for (const socket of [...this.viewers, ...this.producers]) {
            socket.terminate();
        }
    }

    /**
     * A socket error (a malformed frame, a reset) is that socket's end, not the
     * process's: `ws` emits `error` whether or not anyone listens, and an
     * unlistened `error` event throws.
     */
    private guard(socket: WebSocket): void {
        socket.on("error", (): void => {
            this.viewers.delete(socket);
            this.producers.delete(socket);
            socket.terminate();
        });
    }

    private sendState(socket: WebSocket): void {
        socket.send(
            JSON.stringify({
                type: "state",
                v: 1,
                humanControl: false,
                targetFps: TARGET_FPS,
                viewers: this.viewers.size,
            })
        );
    }

    private broadcastState(): void {
        for (const producer of this.producers) {
            if (producer.readyState === WebSocket.OPEN) {
                this.sendState(producer);
            }
        }
    }
}
