import { createPanelTransport as create } from "../../src/core/panelTransport";
import { panelFetch } from "../native/transport";
export function createPanelTransport(fetchImpl = panelFetch, origin?: string) { return create(fetchImpl, origin); }
