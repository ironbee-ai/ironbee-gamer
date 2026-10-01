import { GameDefinition, Profile } from "../../../src/game/types";
import { defaultBuiltInDir, GameNotFoundError, GameSource, Library } from "../../../src/library/store";
import { fakeGameDefinition, fakeProfile } from "../../helpers/fake-game";

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

function writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
}

describe("Library", (): void => {
    let root: string;
    let builtIn: string;
    let user: string;
    let library: Library;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-lib-"));
        builtIn = path.join(root, "built-in");
        user = path.join(root, "user");
        writeJson(path.join(builtIn, "fake-runner", "game.json"), fakeGameDefinition());
        writeJson(path.join(builtIn, "fake-runner", "profiles", "v1.json"), fakeProfile({ version: 1 }));
        writeJson(path.join(builtIn, "fake-runner", "profiles", "v2.json"), fakeProfile({ version: 2, results: { mean: 5, scores: [5], gameSeconds: 5, measuredAt: "x" } }));
        library = new Library(builtIn, user);
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    it("lists built-in games with their newest version active", (): void => {
        const [game] = library.list();
        expect(game).toMatchObject({ id: "fake-runner", source: GameSource.BUILT_IN, activeVersion: 2, versions: 2, results: { mean: 5 } });
        expect(library.profile("fake-runner")?.version).toBe(2);
    });

    it("saves a trained version in the user library, numbered after the built-in ones, and makes it active", (): void => {
        const { version: _, ...draft } = fakeProfile({ origin: "tuner" });
        const saved: Profile = library.saveProfile("fake-runner", draft);
        expect(saved.version).toBe(3);
        expect(existsSync(path.join(user, "fake-runner", "profiles", "v3.json"))).toBe(true);
        expect(existsSync(path.join(builtIn, "fake-runner", "profiles", "v3.json"))).toBe(false);
        expect(library.activeVersion("fake-runner")).toBe(3);
        expect(library.sourceOf("fake-runner")).toBe(GameSource.TRAINED);
        library.setActive("fake-runner", 1);
        expect(library.profile("fake-runner")?.version).toBe(1);
        expect(library.profiles("fake-runner").map((p: { version: number; active: boolean }): string => `${p.version}${p.active ? "*" : ""}`)).toEqual(["3", "2", "1*"]);
        expect((): void => library.setActive("fake-runner", 9)).toThrow(/no profile v9/);
    });

    it("never saves over a version another process saved after this one counted them: it takes the next number", (): void => {
        const { version: _, ...draft } = fakeProfile({ origin: "tuner", note: "mine" });
        type Counting = { versionFiles(id: string): Map<number, unknown> };
        // Another process (a CLI training beside the UI's) saves v3 between this one's count and its write.
        const counted: Map<number, unknown> = (library as unknown as Counting).versionFiles("fake-runner");
        writeJson(path.join(user, "fake-runner", "profiles", "v3.json"), fakeProfile({ version: 3, note: "theirs" }));
        const spy: jest.SpyInstance = jest.spyOn(library as unknown as Counting, "versionFiles").mockReturnValueOnce(counted);
        const saved: Profile = library.saveProfile("fake-runner", draft);
        spy.mockRestore();
        expect(saved.version).toBe(4);
        expect(library.profile("fake-runner", 3)?.note).toBe("theirs");
        expect(library.profile("fake-runner", 4)?.note).toBe("mine");
        expect(library.activeVersion("fake-runner")).toBe(4);
        expect(readdirSync(path.join(user, "fake-runner", "profiles")).sort()).toEqual(["v3.json", "v4.json"]);
    });

    it("never makes a version kept for real time only active by being the newest: with none set, the newest that is not", (): void => {
        writeJson(path.join(builtIn, "fake-runner", "profiles", "v3.json"), fakeProfile({ version: 3, liveOnly: true }));
        expect(library.activeVersion("fake-runner")).toBe(2);
        expect(library.list()[0]).toMatchObject({ activeVersion: 2 });
        // A training saves another without making it active (no state file yet): still v2.
        const { version: _, ...draft } = fakeProfile({ origin: "tuner", liveOnly: true });
        library.saveProfile("fake-runner", draft, { activate: false });
        expect(library.profiles("fake-runner").map((p: { version: number; active: boolean }): string => `${p.version}${p.active ? "*" : ""}`)).toEqual(["4", "3", "2*", "1"]);
        // One the user sets plays, kept for real time only or not.
        library.setActive("fake-runner", 4);
        expect(library.profile("fake-runner")?.version).toBe(4);
    });

    it("says which versions carry their rules as code (what the rules engine can play)", (): void => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
        const summaries: Array<{ version: number; hasTeacher: boolean }> = library.profiles("fake-runner");
        expect(summaries[0]).toMatchObject({ hasTeacher: true });
        expect(summaries[summaries.length - 1]).toMatchObject({ hasTeacher: false });
    });

    it("adds a game of the user's, which removing takes away entirely", (): void => {
        const game: GameDefinition = library.saveGame(fakeGameDefinition({ id: "my-game", name: "Mine" }));
        expect(library.has("my-game")).toBe(true);
        expect(library.profile("my-game")).toBeUndefined();
        expect(library.list().map((g: { id: string }): string => g.id)).toEqual(["fake-runner", "my-game"]);
        library.removeUserPart(game.id);
        expect(library.has("my-game")).toBe(false);
        expect((): GameDefinition => library.game("my-game")).toThrow(GameNotFoundError);
    });

    it("exports a game with every version and imports it into another library", (): void => {
        library.saveProfile("fake-runner", fakeProfile({ origin: "tuner" }));
        library.saveWindow("fake-runner", { id: "v2-seed1", profileVersion: 2, rawFrames: [[1], [2]] });
        const out: string = path.join(root, "export");
        library.exportGame("fake-runner", out);
        expect(readdirSync(path.join(out, "profiles")).sort()).toEqual(["v1.json", "v2.json", "v3.json"]);
        expect(existsSync(path.join(out, "state.json"))).toBe(false);

        const other: Library = new Library(path.join(root, "none"), path.join(root, "other"));
        other.importGame(out);
        expect(other.profile("fake-runner")?.version).toBe(3);
        expect(other.window("fake-runner", "v2-seed1")?.rawFrames).toEqual([[1], [2]]);
        expect((): GameDefinition => other.importGame(out)).toThrow(/already has/);
    });

    it("refuses a malformed game or profile, naming the field", (): void => {
        writeJson(path.join(user, "broken", "game.json"), { ...fakeGameDefinition({ id: "broken" }), url: "ftp://x" });
        expect((): GameDefinition => library.game("broken")).toThrow(/broken\/game\.json\.url/);
        expect(library.list().map((g: { id: string }): string => g.id)).toEqual(["fake-runner"]);
        const { version: _, ...draft } = fakeProfile();
        expect((): Profile => library.saveProfile("fake-runner", { ...draft, actions: [] })).toThrow(/actions/);
    });

    it("reads files only inside a game's directory", (): void => {
        writeFileSync(path.join(root, "secret.txt"), "x");
        expect(library.file("fake-runner", "../secret.txt")).toBeUndefined();
        expect(library.file("fake-runner", "/etc/passwd")).toBeUndefined();
        expect(library.file("fake-runner", "game.json")).toBe(path.join(builtIn, "fake-runner", "game.json"));
        expect((): boolean => library.has("../x")).not.toThrow();
        expect(library.window("fake-runner", "../../x")).toBeUndefined();
    });

    it("never hands out a file a link takes out of the game's directory", (): void => {
        writeFileSync(path.join(root, "secret.txt"), "x");
        const dir: string = library.userDirFor("fake-runner");
        symlinkSync(path.join(root, "secret.txt"), path.join(dir, "thumbnail.png"));
        expect(library.file("fake-runner", "thumbnail.png")).toBeUndefined();
        // A link that stays inside the game's directory is still its file.
        writeFileSync(path.join(dir, "shot.png"), "png");
        symlinkSync(path.join(dir, "shot.png"), path.join(dir, "picture.png"));
        expect(library.file("fake-runner", "picture.png")).toBe(path.join(dir, "picture.png"));
    });

    it("imports a game's files but not its symbolic links", (): void => {
        writeFileSync(path.join(root, "secret.txt"), "x");
        const source: string = path.join(root, "to-import");
        library.exportGame("fake-runner", source);
        mkdirSync(path.join(source, "samples"), { recursive: true });
        writeFileSync(path.join(source, "samples", "screenshot.png"), "png");
        symlinkSync(path.join(root, "secret.txt"), path.join(source, "thumbnail.png"));
        symlinkSync(root, path.join(source, "elsewhere"));
        const other: Library = new Library(path.join(root, "none"), path.join(root, "other"));
        other.importGame(source);
        const imported: string = path.join(root, "other", "fake-runner");
        expect(readdirSync(imported).sort()).toEqual(["game.json", "profiles", "samples"]);
        expect(other.file("fake-runner", "samples/screenshot.png")).toBe(path.join(imported, "samples", "screenshot.png"));
        expect((): unknown => lstatSync(path.join(imported, "thumbnail.png"))).toThrow();

        // A game.json that is a link would be checked but not copied: refused.
        const linked: string = path.join(root, "linked");
        mkdirSync(linked);
        symlinkSync(path.join(source, "game.json"), path.join(linked, "game.json"));
        expect((): GameDefinition => other.importGame(linked, { replace: true })).toThrow(/symbolic link/);
    });

    it("refuses to import a game from its own folder in the user library, which replacing it would delete", (): void => {
        library.saveGame(fakeGameDefinition({ id: "mine", name: "Mine" }));
        library.saveProfile("mine", fakeProfile({ origin: "tuner" }));
        const own: string = path.join(user, "mine");
        expect((): GameDefinition => library.importGame(own, { replace: true })).toThrow(/own folder/);
        // Through a link to it, from inside it, or from a folder holding it.
        symlinkSync(own, path.join(root, "link-to-mine"));
        expect((): GameDefinition => library.importGame(path.join(root, "link-to-mine"), { replace: true })).toThrow(/own folder/);
        writeJson(path.join(own, "nested", "game.json"), fakeGameDefinition({ id: "mine", name: "Nested" }));
        expect((): GameDefinition => library.importGame(path.join(own, "nested"), { replace: true })).toThrow(/own folder/);
        writeJson(path.join(user, "game.json"), fakeGameDefinition({ id: "mine", name: "Outer" }));
        expect((): GameDefinition => library.importGame(user, { replace: true })).toThrow(/own folder/);
        rmSync(path.join(user, "game.json"));
        expect(library.game("mine").name).toBe("Mine");
        expect(library.profile("mine")?.version).toBe(1);
    });

    it("replaces a game on import only once the new copy is made, leaving nothing beside it", (): void => {
        library.saveGame(fakeGameDefinition({ id: "mine", name: "Mine" }));
        const copy: string = path.join(root, "mine-copy");
        library.exportGame("mine", copy);
        writeJson(path.join(copy, "game.json"), fakeGameDefinition({ id: "mine", name: "Mine, again" }));
        writeJson(path.join(copy, "profiles", "v1.json"), fakeProfile({ version: 1 }));
        // A copy that fails half way leaves the game as it was (root reads any file: not checked as root).
        if (process.getuid?.() !== 0) {
            writeFileSync(path.join(copy, "unreadable.png"), "png", { mode: 0o000 });
            expect((): GameDefinition => library.importGame(copy, { replace: true })).toThrow(/EACCES/);
            expect(library.game("mine").name).toBe("Mine");
            expect(readdirSync(user).filter((name: string): boolean => name.startsWith("."))).toEqual([]);
            rmSync(path.join(copy, "unreadable.png"));
        }
        library.importGame(copy, { replace: true });
        expect(library.game("mine").name).toBe("Mine, again");
        expect(library.profile("mine")?.version).toBe(1);
        expect(readdirSync(user).filter((name: string): boolean => name.startsWith("."))).toEqual([]);
        expect(existsSync(path.join(copy, "game.json"))).toBe(true);
    });

    it("tells what a removed game left in the user library from no game at all", (): void => {
        expect(library.hasUserPart("gone")).toBe(false);
        writeJson(path.join(user, "gone", "profiles", "v1.json"), fakeProfile());
        writeJson(path.join(user, "gone", "state.json"), { active: 1 });
        expect(library.has("gone")).toBe(false);
        expect(library.hasUserPart("gone")).toBe(true);
        expect(library.hasUserPart("../x")).toBe(false);
        library.removeUserPart("gone");
        expect(library.hasUserPart("gone")).toBe(false);
    });
});

describe("the built-in library", (): void => {
    it("holds the researched games, each with a valid, measured active profile", (): void => {
        const library: Library = new Library(defaultBuiltInDir(), "/nonexistent/ibgamer-user");
        const ids: string[] = library.ids();
        expect(ids).toEqual(expect.arrayContaining(["dino", "flappy-bird", "pacman-ghosts"]));
        for (const id of ids) {
            const profile: Profile | undefined = library.profile(id);
            expect(profile?.results?.mean).toBeGreaterThan(0);
            for (const test of profile?.tests ?? []) {
                expect(library.window(id, test.window)?.rawFrames.length).toBeGreaterThan(0);
            }
            expect(JSON.parse(readFileSync(path.join(defaultBuiltInDir(), id, "game.json"), "utf-8")).id).toBe(id);
        }
    });
});
