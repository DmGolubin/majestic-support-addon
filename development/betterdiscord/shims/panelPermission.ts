// Panel traffic uses the host network bridge with a fixed origin, not renderer fetch/CSP overrides.
export async function ensurePanelPermission(_interactive: boolean) { return "ready" as const; }
