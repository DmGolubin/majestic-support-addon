import { createPanelEventStream as create } from "../../src/core/panelEvents";
import { panelFetch } from "../native/transport";
export function createPanelEventStream(fetchImpl = panelFetch, origin?: string) { return create(fetchImpl, origin); }
