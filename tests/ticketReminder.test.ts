import { describe, expect, it } from "vitest";

import { reminderDue, reminderKey, WaitingTicket } from "../src/core/ticketReminder";

const t: WaitingTicket = { id: "ticket", assigneeId: "me", state: "waiting_support", waitingSince: 1000, waitingCycleId: "first", returnToPoolAt: 1000 + 30 * 60000 };
describe("personal reminder decisions (server adapter pending)", () => {
    it.each([5, 10, 15] as const)("uses the personal %i minute threshold", minutes => {
        expect(reminderDue(t, "me", minutes, 1000 + minutes * 60000 - 1)).toBe(false);
        expect(reminderDue(t, "me", minutes, 1000 + minutes * 60000)).toBe(true);
    });
    it("never reminds another owner, answered, returned or closed tickets", () => {
        for (const patch of [{ assigneeId: "other" }, { assigneeId: null }, { state: "waiting_player" }, { state: "pool" }, { state: "closed" }, { waitingSince: null }, { waitingCycleId: null }] as Partial<WaitingTicket>[]) {
            expect(reminderDue({ ...t, ...patch }, "me", 5, 1000 + 20 * 60000)).toBe(false);
        }
    });
    it("stops at server return deadline without claiming that client returned it", () => {
        expect(reminderDue(t, "me", 5, t.returnToPoolAt!)).toBe(false);
    });
    it("separates accounts and waiting periods, not additional messages or bot reminders", () => {
        expect(reminderKey("a", t)).toBe(reminderKey("a", { ...t }));
        expect(reminderKey("a", t)).not.toBe(reminderKey("b", t));
        expect(reminderKey("a", t)).not.toBe(reminderKey("a", { ...t, waitingCycleId: "second" }));
    });
});
