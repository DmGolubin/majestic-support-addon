import { describe, expect, it } from "vitest";
import { Store } from "../src/core/state";
import { routeStore } from "../src/core/storeRouter";

describe("isolated demo store", () => {
    it("routes changes and subscriptions without writing real data", async () => {
        const writes: unknown[] = [];
        const real = new Store({ get: async () => undefined, set: async (_k, v) => { writes.push(v); } });
        real.importText("## Majestic RP\n### Реальный\nНе менять"); await real.flush();
        const before = JSON.stringify(real.data);
        const count = writes.length;
        const demo = new Store({ get: async () => undefined, set: async () => {} });
        const router = routeStore(real);
        let notifications = 0;
        const off = router.store.subscribe(() => notifications++);
        router.select(demo);
        router.store.replaceDemoCatalog("## Majestic RP\n### ДЕМО\nВерсия 1");
        router.store.setTechProject("ro"); await router.store.flush();
        expect(router.store.templates[0].source).toBe("faq");
        expect(JSON.stringify(real.data)).toBe(before);
        expect(writes.length).toBe(count);
        router.select(real);
        expect(router.store.templates[0].text).toContain("Не менять");
        expect(router.store.data.techProject).toBe("mj");
        expect(notifications).toBeGreaterThanOrEqual(4);
        off(); const stopped = notifications; router.store.setTechProject("ro"); expect(notifications).toBe(stopped);
    });
    it("refresh changes generation but preserves demo personal records and favorites", async () => {
        const demo = new Store({ get: async () => undefined, set: async () => {} });
        demo.replaceDemoCatalog("## Majestic RP\n### FAQ\nВерсия 1");
        const id = demo.templates[0].id;
        demo.data.favorites = [id];
        await demo.savePersonal({ title: "Мой", text: "Ответ", project: "mj", color: null, command: null, folderId: null });
        const version = demo.setVersion;
        demo.replaceDemoCatalog("## Majestic RP\n### FAQ\nВерсия 2");
        expect(demo.setVersion).toBeGreaterThan(version);
        expect(demo.data.personal).toHaveLength(1);
        expect(demo.data.favorites).toEqual([id]);
        expect(demo.byId(id)?.text).toContain("Версия 2");
    });
});
