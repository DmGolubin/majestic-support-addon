import { describe, expect, it } from "vitest";

import { defaultTicketSound, NewTicketEvent, readTicketSound, TicketSoundGate } from "../src/core/ticketSound";

const start = 1792100000000;
const id = (at: number) => String(BigInt(at - 1420070400000) << 22n);
const event = (at = start + 1000): NewTicketEvent => ({ id: id(at), parentId: "696711470783922247", guildId: "530693013622489088" });
const options = () => ({ ...defaultTicketSound(), enabled: true });

describe("new ticket sound", () => {
    it("accepts a new configured thread once", () => {
        const g = new TicketSoundGate(start);
        expect(g.accept(event(), options(), start + 2000, false)).toBe(true);
        expect(g.accept(event(), options(), start + 9000, false)).toBe(false);
    });
    it("rejects history, joins, archived and future threads", () => {
        for (const e of [event(start - 1), event(start - 50000), event(start + 100000), { ...event(), newlyCreated: false }, { ...event(), archived: true }]) {
            expect(new TicketSoundGate(start).accept(e, options(), start + 2000, false)).toBe(false);
        }
    });
    it("rejects other parents, servers, malformed IDs and disabled settings", () => {
        for (const e of [{ ...event(), parentId: "other" }, { ...event(), guildId: "1395915167040016545" }, { ...event(), id: "bad" }]) {
            expect(new TicketSoundGate(start).accept(e, options(), start + 2000, false)).toBe(false);
        }
        expect(new TicketSoundGate(start).accept(event(), defaultTicketSound(), start + 2000, false)).toBe(false);
    });
    it("suppresses visible tickets without replay when focus moves", () => {
        const g = new TicketSoundGate(start);
        expect(g.accept(event(), options(), start + 2000, true)).toBe(false);
        expect(g.accept(event(), options(), start + 3000, false)).toBe(false);
        expect(new TicketSoundGate(start).accept(event(), { ...options(), quietWhenVisible: false }, start + 2000, true)).toBe(true);
    });
    it("limits bursts and does not replay suppressed events", () => {
        const g = new TicketSoundGate(start);
        expect(g.accept(event(), options(), start + 2000, false)).toBe(true);
        expect(g.accept(event(start + 3000), options(), start + 3000, false)).toBe(false);
        expect(g.accept(event(start + 3000), options(), start + 6000, false)).toBe(false);
        expect(g.accept(event(start + 7000), options(), start + 7000, false)).toBe(true);
    });
    it("does not accept old events after restart", () => {
        expect(new TicketSoundGate(start + 3000).accept(event(), options(), start + 4000, false)).toBe(false);
    });
    it("validates preferences and keeps zero volume silent", () => {
        expect(readTicketSound({ enabled: "yes", volume: NaN, cooldownMs: -1, channelIds: [null, "bad", event().parentId, event().parentId] }))
            .toMatchObject({ enabled: false, volume: 30, cooldownMs: 1000, channelIds: [event().parentId] });
        expect(new TicketSoundGate(start).accept(event(), { ...options(), volume: 0 }, start + 2000, false)).toBe(false);
    });
});
