/**
 * `game_step`: one move of the game — the input, then game time run on the
 * frozen clock, then what the page shows (the adapter's raw input) and what
 * the game's own state says (the score, for measuring). One call per move: a
 * decision costs one round trip here.
 *
 * Input is generic: keys listed in `hold` are held (a key held again stays
 * down — a release and re-press between moves cuts a jump short), keys not
 * listed are released; `press` taps keys; `click` clicks the game's centre (or a
 * point); `pointer` holds the mouse button down there until a step lets it go.
 */

import { ClickPoint, GameTool, PAGE_NAMESPACE, StepRequest, StepResult } from "../devtools/protocol";
import { pluginApi } from "./api";
import type { BrowserToolSessionContext, Tool, ToolInput, ToolInputSchema, ToolOutput, ToolOutputSchema } from "./host";
import { GamePageState, pageState } from "./state";
import { runGameTime } from "./time";
import type { Page } from "playwright-core";

const MAX_ADVANCE_MS: number = 60_000;
const MAX_WAIT_MS: number = 30_000;
const CLICK_TIMEOUT_MS: number = 5_000;
/** How long a step waits at most for its inputs to reach the page (real time, polled). */
const INPUT_ARRIVAL_MS: number = 5_000;
/** Keys a page expression may name to hold: a menu needs a few, not a script's worth. */
const MAX_KEYS_FROM: number = 8;
const INPUT_POLL_MS: number = 2;

/** The errors a step reports for the part of its reading that failed: the raw input's, the score's. */
export type PartErrors = Pick<StepResult, "readError" | "scoreError">;

/** One part of observeExpression: `expression` read into `out[key]`, what it throws into `out[errorKey]`. */
function _observePart(key: string, errorKey: keyof PartErrors, expression: string | undefined): string {
    return expression ? `try { out.${key} = (${expression}\n); } catch (e) { out.${errorKey} = String((e && e.message) || e).slice(0, 300); }` : "";
}

/**
 * One page expression that reads the raw input, the score and the clock
 * together: a single round trip, and each part's failure its own. Each
 * expression ends on a line of its own, so one that ends in a `//` comment
 * comments out nothing after it. (`holdFrom` is not spliced: Playwright
 * evaluates it as a script of its own.)
 */
export function observeExpression(read: string | undefined, score: string | undefined): string {
    return `(() => { const out = {}; ${_observePart("raw", "readError", read)} ${_observePart("score", "scoreError", score)} out.clockMs = Date.now(); return out; })()`;
}

/** A part's syntax error ("SyntaxError: …"), or undefined when it compiles here (or cannot be checked here). */
function _syntaxError(part: string): string | undefined {
    if (!part) {
        return undefined;
    }
    try {
        // Compiled, never called: nothing of the page's expression runs in this process.
        new Function(`const out = {}; ${part}`);
        return undefined;
    } catch (err: unknown) {
        return err instanceof SyntaxError ? `SyntaxError: ${err.message}`.slice(0, 300) : undefined;
    }
}

/**
 * `read` and `score` that do not compile (statements, not an expression), each its own part's error: spliced into
 * observeExpression, one would have the page refuse the whole expression — the other part, the clock, and the step
 * with them. Checked here, the part as it would be spliced, in a function body. Only a syntax error counts: anything
 * else (a process that refuses code from strings) checks nothing, and the part goes in as before.
 */
export function syntaxErrors(read: string | undefined, score: string | undefined): PartErrors {
    const errors: PartErrors = {};
    const readError: string | undefined = _syntaxError(_observePart("raw", "readError", read));
    const scoreError: string | undefined = _syntaxError(_observePart("score", "scoreError", score));
    if (readError !== undefined) {
        errors.readError = readError;
    }
    if (scoreError !== undefined) {
        errors.scoreError = scoreError;
    }
    return errors;
}

/** Whether the page compiles an expression: inside a function it never calls, so nothing of it runs. */
async function _compilesInPage(page: Page, expression: string): Promise<boolean> {
    return page.evaluate(`(() => { () => ${expression}; return true; })()`).then(
        (): boolean => true,
        (): boolean => false
    );
}

/**
 * Reads the raw input, the score and the clock in one round trip (observeExpression), a part that does not compile left
 * out and reported as its error (syntaxErrors). What this process's engine refuses the page's may take — it can be newer
 * (a regular expression's `(?i:…)` modifiers): such a part is compiled in the page first, and read after all when it
 * compiles there.
 */
async function _observe(page: Page, read: string | undefined, score: string | undefined): Promise<StepResult> {
    const refused: PartErrors = syntaxErrors(read, score);
    if (refused.readError !== undefined && (await _compilesInPage(page, observeExpression(read, undefined)))) {
        delete refused.readError;
    }
    if (refused.scoreError !== undefined && (await _compilesInPage(page, observeExpression(undefined, score)))) {
        delete refused.scoreError;
    }
    const expression: string = observeExpression(refused.readError === undefined ? read : undefined, refused.scoreError === undefined ? score : undefined);
    return { ...((await page.evaluate(expression)) as StepResult), ...refused };
}

/**
 * A point of the click target (its centre, or fractions of its box) in page coordinates. The box is measured once per
 * document, told by its input counter's id (page/inputs.ts): a game that goes on to another page (its menu's, then its
 * play page's, the target elsewhere) has it measured again there — until 2026-09-30 once per `game_open`, and 3 clicks on
 * the play page's canvas all missed. A document the id cannot be read in (navigating) has it measured every time.
 */
async function _pagePoint(context: BrowserToolSessionContext, state: GamePageState, where: true | ClickPoint): Promise<{ x: number; y: number }> {
    const doc: string | undefined = (await inputCount(context.page))?.doc;
    if (!state.clickBox || doc === undefined || doc !== state.clickBoxDoc) {
        const box: { x: number; y: number; width: number; height: number } | null = await context.page
            .locator(state.clickTarget)
            .first()
            .boundingBox({ timeout: CLICK_TIMEOUT_MS });
        if (!box) {
            throw new Error(`nothing to click: ${state.clickTarget} is not on the page`);
        }
        state.clickBox = box;
        state.clickBoxDoc = doc;
    }
    const at: ClickPoint = where === true ? { x: 0.5, y: 0.5 } : where;
    return { x: state.clickBox.x + at.x * state.clickBox.width, y: state.clickBox.y + at.y * state.clickBox.height };
}

/** The keys a page expression names (a key name, a list of them, or nothing); an expression that throws names none. */
async function _keysFrom(page: Page, expression: string): Promise<string[]> {
    const named: unknown = await page.evaluate(expression).catch((): undefined => undefined);
    const keys: unknown[] = Array.isArray(named) ? named : [named];
    return keys.filter((k: unknown): k is string => typeof k === "string" && k.length > 0).slice(0, MAX_KEYS_FROM);
}

/** What the page's input counter says (page/inputs.ts): the document it counts in and the inputs it received there; undefined without one. */
export async function inputCount(page: Page): Promise<{ doc: string; received: number } | undefined> {
    const read: unknown = await page
        .evaluate(`(() => { const ns = window.${PAGE_NAMESPACE}; return ns && typeof ns.inputs === "number" ? [String(ns.inputsDoc), ns.inputs] : null; })()`)
        .catch((): undefined => undefined);
    return Array.isArray(read) ? { doc: String(read[0]), received: Number(read[1]) } : undefined;
}

/**
 * Waits until the page has received the inputs sent to it (page/inputs.ts), this step's `sent` last, for at most
 * INPUT_ARRIVAL_MS; a page without the counter is not waited for. Another document (one the page loaded itself)
 * counts from its start: only this step's inputs are waited for there. Then the page's own count is where the next
 * step counts from: what has not arrived in time (a page that swallowed an input) is not waited for again.
 */
async function _inputsArrived(page: Page, state: GamePageState, sent: number): Promise<void> {
    const deadline: number = Date.now() + INPUT_ARRIVAL_MS;
    for (;;) {
        const count: { doc: string; received: number } | undefined = await inputCount(page);
        if (!count) {
            return;
        }
        if (count.doc !== state.inputsDoc) {
            state.inputsDoc = count.doc;
            state.inputsSent = sent;
        }
        if (count.received >= state.inputsSent || Date.now() >= deadline) {
            state.inputsSent = count.received;
            return;
        }
        await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, INPUT_POLL_MS));
    }
}

export class StepGame implements Tool {
    name(): string {
        return GameTool.STEP;
    }

    description(): string {
        return "One move of a game opened with <game_open>: hold / press keys or click, run game time on the frozen clock, then read the raw input and the score.";
    }

    inputSchema(): ToolInputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            hold: z.array(z.string()).optional().describe("Keys held from now on; others held are released."),
            press: z.array(z.string()).optional().describe("Keys pressed and released now."),
            holdFrom: z
                .string()
                .optional()
                .describe("A page expression naming keys held from now on, as hold (with hold, both): a key name, a list, or nothing (null) for none."),
            click: z
                .union([z.boolean(), z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })])
                .optional()
                .describe("Click the game once: its centre, or a point as fractions of its width and height."),
            pointer: z
                .union([z.boolean(), z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })])
                .optional()
                .describe("Hold the mouse button down from now on (at the centre or a point); false lets it go."),
            // Whole milliseconds: the clock runs a fraction up to the next one, and a later document's replay would not.
            advanceMs: z.number().int().min(0).max(MAX_ADVANCE_MS).default(0).describe("Game time to run after the input (whole ms)."),
            waitMs: z.number().int().min(0).max(MAX_WAIT_MS).default(0).describe("Real time to wait after the input, before advanceMs (whole ms)."),
            observe: z.boolean().default(true).describe("Read the raw input and the score after."),
        };
    }

    outputSchema(): ToolOutputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            raw: z.unknown().optional(),
            score: z.record(z.unknown()).optional(),
            clockMs: z.number().optional(),
            readError: z.string().optional(),
            scoreError: z.string().optional(),
            pageError: z.string().optional(),
        };
    }

    async handle(context: BrowserToolSessionContext, input: ToolInput): Promise<ToolOutput> {
        const args: StepRequest = input as StepRequest;
        const page: BrowserToolSessionContext["page"] = context.page;
        const state: GamePageState = pageState(context);
        const sentBefore: number = state.inputsSent;
        const named: string[] | undefined = args.holdFrom ? await _keysFrom(page, args.holdFrom) : undefined;
        const hold: string[] | undefined = named ? [...(args.hold ?? []), ...named] : args.hold;
        if (hold) {
            const wanted: Set<string> = new Set(hold);
            for (const key of [...state.held]) {
                if (!wanted.has(key)) {
                    state.held.delete(key);
                    await page.keyboard.up(key);
                    state.inputsSent++;
                }
            }
            for (const key of wanted) {
                if (!state.held.has(key)) {
                    await page.keyboard.down(key);
                    state.held.add(key);
                    state.inputsSent++;
                }
            }
        }
        for (const key of args.press ?? []) {
            await page.keyboard.press(key);
            state.inputsSent += 2;
        }
        if (args.pointer !== undefined) {
            if (args.pointer) {
                const at: { x: number; y: number } = await _pagePoint(context, state, args.pointer);
                await page.mouse.move(at.x, at.y);
                if (!state.pointerDown) {
                    await page.mouse.down();
                    state.pointerDown = true;
                    state.inputsSent++;
                }
            } else if (state.pointerDown) {
                state.pointerDown = false;
                await page.mouse.up();
                state.inputsSent++;
            }
        }
        if (args.click) {
            const at: { x: number; y: number } = await _pagePoint(context, state, args.click);
            await page.mouse.click(at.x, at.y);
            state.inputsSent += 2;
        }
        if (state.inputsSent > sentBefore) {
            // Every input reaches the page before its game time runs (the browser delivers input on its own thread).
            await _inputsArrived(page, state, state.inputsSent - sentBefore);
        }
        // Real time first, the clock still frozen: what the input started in real time (a CSS animation) ends
        // at the same game time in every run; then game time.
        if (args.waitMs) {
            await page.waitForTimeout(args.waitMs);
        }
        // The page's own error in a callback game time ran is reported, not thrown: the clock ran on, as the page's would.
        const pageError: string | undefined = args.advanceMs ? await runGameTime(page, args.advanceMs, state.animationClock === true) : undefined;
        const errors: Pick<StepResult, "pageError"> = pageError ? { pageError } : {};
        if (args.observe === false) {
            return { ...errors };
        }
        const result: StepResult = await _observe(page, state.read, state.score);
        return { ...result, ...errors };
    }
}
