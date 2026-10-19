// SPDX-License-Identifier: GPL-3.0-or-later
import upstream from "../src/vencord/index";
import { ServiceSettings } from "./ServiceSettings";
import { api, NAME } from "./shims/host";
import { React, useEffect, useState, FluxDispatcher, UserStore, ChannelStore, SelectedChannelStore, SelectedGuildStore } from "./shims/common";
import ErrorBoundary from "./shims/errorBoundary";
import { mountChatButtons } from "./chatMounts";
import { closePanelVault } from "./native/vaultHost";
import { prepareUpdates } from "./native/updateHost";
import { PLUGIN_DISTRIBUTION, PLUGIN_VERSION } from "./shims/buildInfo";
import { distributionDisplay } from "../src/vencord/buildDisplay";
import css from "stx:css";

/** Cleanup must progress even if a host bridge or an observer throws. */
function cleanupStep(action: () => void) {
    try { action(); } catch (error) { console.error("[SupportTemplates] Cleanup failed", error); }
}

export default class SupportTemplates {
    private generation = 0;
    private active = false;
    private runtimeActive = false;
    private runtimeGeneration = 0;
    private starting: Promise<void> = Promise.resolve();
    private offButtons?: () => void;
    private updater: any;
    private delegate: SupportTemplates | null = null;
    private retiring: Promise<unknown> = Promise.resolve();
    private settingsListeners = new Set<() => void>();
    private updateStatus = "Обновления проверяются автоматически; установка при следующем запуске.";
    getName() { return NAME; }
    getAuthor() { return "Oblako"; }
    getVersion() { return this?.delegate?.getVersion() ?? PLUGIN_VERSION; }
    getDescription() { return "SupportTemplates для BetterDiscord. Шаблоны поддержки Majestic / Россия Онлайн. Ctrl+Alt+T — открыть, вставка без отправки."; }

    start() {
        if (this.active) return this.starting;
        this.active = true;
        const own = ++this.generation;
        const live = () => this.active && own === this.generation;
        const retired = this.retiring;
        const run = async () => {
            await retired;
            if (!live()) return;
            try {
                const updates = await prepareUpdates(live, event => {
                    if (!live()) return;
                    if (event.type === "pending" || event.type === "pending-restart") this.updateStatus = "Обновление загружено. Оно включится после Ctrl+R или следующего запуска Discord.";
                    if (event.type === "error") this.updateStatus = "Проверка обновлений временно недоступна. Повторим автоматически.";
                    if (event.type === "unsupported-host") this.updateStatus = "Обновляйте плагин вручную: эта версия BetterDiscord не предоставляет необходимые функции для безопасного автообновления.";
                    for (const changed of this.settingsListeners) changed();
                });
                if (!live()) { await updates?.updater.stop(); return; }
                this.updater = updates?.updater;
                this.delegate = updates?.Plugin ? new updates.Plugin() : null;
            } catch {
                // Anonymous 404/private repositories, disk failures, invalid cache: usable
                // bundled runtime, no authentication prompt, no forced reload.
                this.updateStatus = "Обновление недоступно. Используется встроенная версия.";
            }
            if (!live()) return;
            const runtime = this.delegate ?? this;
            await runtime.startBundledRuntime();
            if (!live()) { runtime.stopBundledRuntime(); return; }
            this.updater?.start();
        };
        this.starting = run().catch(() => {
            if (!live()) return;
            this.stop();
            api().UI.showToast("SupportTemplates: функции Discord недоступны. Обновите клиент/плагин и включите его снова.", { type: "error" });
        });
        return this.starting;
    }

    /** Stable private loader contract: a verified cached class runs its own complete UI
     * without recursively bootstrapping another updater. Called only before mount.
     */
    async startBundledRuntime() {
        if (this.runtimeActive) return;
        // Resolve all required capabilities before upstream subscribes partially.
        for (const [store, methods] of [[UserStore, ["getCurrentUser", "addChangeListener", "removeChangeListener"]],
            [ChannelStore, ["getChannel"]], [SelectedChannelStore, ["getChannelId"]], [SelectedGuildStore, ["getGuildId"]],
            [FluxDispatcher, ["subscribe", "unsubscribe"]]] as any) {
            for (const name of methods) if (typeof store[name] !== "function") throw new Error("Discord capability unavailable");
        }
        if (document.getElementById("vc-stx-host")) throw new Error("Another SupportTemplates runtime is active");
        this.runtimeActive = true;
        const own = ++this.runtimeGeneration;
        try {
            api().DOM.addStyle(NAME, css);
            await upstream.start();
            if (!this.runtimeActive || own !== this.runtimeGeneration) return;
            this.offButtons = mountChatButtons(upstream.chatBarButton.render);
            for (const changed of this.settingsListeners) changed();
        } catch (error) { this.stopBundledRuntime(); throw error; }
    }
    stopBundledRuntime() {
        if (!this.runtimeActive) return;
        this.runtimeActive = false;
        ++this.runtimeGeneration;
        const offButtons = this.offButtons; this.offButtons = undefined;
        cleanupStep(() => offButtons?.());
        cleanupStep(() => upstream.stop());
        cleanupStep(() => api().DOM.removeStyle(NAME));
        this.retiring = Promise.resolve().then(() => closePanelVault()).catch(error => {
            console.error("[SupportTemplates] Vault cleanup failed", error);
        });
        for (const changed of this.settingsListeners) cleanupStep(changed);
    }
    stop() {
        this.active = false; ++this.generation;
        const previous = this.updater; this.updater = undefined;
        const delegate = this.delegate; this.delegate = null;
        cleanupStep(() => (delegate ?? this).stopBundledRuntime());
        this.retiring = Promise.allSettled([this.retiring, this.starting, delegate?.retiring, Promise.resolve().then(() => previous?.stop())]);
        for (const changed of this.settingsListeners) cleanupStep(changed);
    }
    getSettingsPanel(includeHeader = true) {
        const owner = this;
        function Panel() {
            const [, refresh] = useState(0);
            useEffect(() => {
                const changed = () => refresh((n: number) => n + 1);
                owner.settingsListeners.add(changed);
                return () => owner.settingsListeners.delete(changed);
            }, []);
            const runtime = owner.delegate ?? owner;
            const definitions = upstream.settings.definitions;
            return <div className="vc-stx-root stx-bd-settings">
                {includeHeader && <header><strong title={`Версия: ${runtime.getVersion()}`}>SupportTemplates · {distributionDisplay(PLUGIN_DISTRIBUTION, runtime.getVersion())}</strong>
                    <p>Ctrl+Alt+T — открыть шаблоны. Alt+1…9 — избранное. Текст вставляется без отправки.</p>
                    <small>{owner.updateStatus}</small></header>}
                {owner.delegate
                    ? owner.delegate.getBundledSettings()
                    : <ErrorBoundary onError={() => api().UI.showToast("Не удалось открыть настройки шаблонов", { type: "error" })}>
                        <ServiceSettings active={runtime.runtimeActive} />
                        <details className="stx-bd-debug-options"><summary>Экранная отладка</summary><p>Дополнительная панель поверх Discord. Для записи файла включать её не нужно.</p>
                        {Object.entries(definitions).filter(([, value]: any) => value.type === "boolean").map(([key, value]: any) =>
                            <label key={key} className="stx-bd-host-option"><input type="checkbox" disabled={!runtime.runtimeActive} checked={runtime.runtimeActive && !!upstream.settings.store[key]}
                                onChange={e => { upstream.settings.store[key] = e.currentTarget.checked; refresh((n: number) => n + 1); }} />{value.displayName}<small>{value.description}</small></label>)}
                        </details>
                    </ErrorBoundary>}
            </div>;
        }
        return React.createElement(Panel);
    }
    getBundledSettings() { return this.getSettingsPanel(false); }
}
