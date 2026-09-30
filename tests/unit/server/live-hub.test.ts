import { EventEmitter } from "events";
import { WebSocket } from "ws";
import { LiveHub } from "../../../src/server/live-hub";

/** Just enough of a socket for the hub: sends are recorded, messages are emitted. */
class FakeSocket extends EventEmitter {
    readonly readyState: number = WebSocket.OPEN;
    readonly bufferedAmount: number = 0;
    readonly sent: unknown[] = [];
    terminated: boolean = false;

    send(data: unknown): void {
        this.sent.push(data);
    }

    terminate(): void {
        this.terminated = true;
    }
}

describe("LiveHub", (): void => {
    it("relays frames to viewers, and a joining viewer gets the last one first", (): void => {
        const hub: LiveHub = new LiveHub();
        const producer: FakeSocket = new FakeSocket();
        const early: FakeSocket = new FakeSocket();
        hub.addProducer(producer as unknown as WebSocket);
        hub.addViewer(early as unknown as WebSocket);
        const frame: Buffer = Buffer.from([1, 0, 0, 0, 0]);
        producer.emit("message", frame, true);
        expect(early.sent).toContainEqual(frame);
        const late: FakeSocket = new FakeSocket();
        hub.addViewer(late as unknown as WebSocket);
        expect(late.sent[0]).toEqual(frame);
        hub.resetFrame();
        const fresh: FakeSocket = new FakeSocket();
        hub.addViewer(fresh as unknown as WebSocket);
        expect(fresh.sent).toEqual([]);
    });

    it("never relays a viewer's input: the engine plays", (): void => {
        const hub: LiveHub = new LiveHub();
        const producer: FakeSocket = new FakeSocket();
        const viewer: FakeSocket = new FakeSocket();
        hub.addProducer(producer as unknown as WebSocket);
        hub.addViewer(viewer as unknown as WebSocket);
        viewer.emit("message", Buffer.from(JSON.stringify({ type: "input", kind: "key-down", key: "Space" })), false);
        const messages: Array<Record<string, unknown>> = producer.sent.map((s: unknown): Record<string, unknown> => JSON.parse(String(s)));
        expect(messages.every((m: Record<string, unknown>): boolean => m.type === "state" && m.humanControl === false)).toBe(true);
    });

    it("ends the failing socket only: a socket error never throws", (): void => {
        const hub: LiveHub = new LiveHub();
        const producer: FakeSocket = new FakeSocket();
        const viewer: FakeSocket = new FakeSocket();
        hub.addProducer(producer as unknown as WebSocket);
        hub.addViewer(viewer as unknown as WebSocket);
        expect((): boolean => viewer.emit("error", new Error("invalid UTF-8"))).not.toThrow();
        expect(viewer.terminated).toBe(true);
        expect(hub.viewerCount).toBe(0);
        expect(hub.producerConnected).toBe(true);
    });
});
