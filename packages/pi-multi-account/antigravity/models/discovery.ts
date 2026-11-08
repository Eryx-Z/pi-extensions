import { createHash } from "node:crypto";
import type { Api, Credential, Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getApiKey } from "../auth/index.js";
import { DEFAULT_ENDPOINT, fetchAvailableModelsCatalog, parseApiKey } from "../client/index.js";
import { ANTIGRAVITY_API } from "../types/types.js";
import { antigravityEnv, isRecord } from "../utils/util.js";
import { buildAntigravityCatalog, type AntigravityCatalog } from "./grouping.js";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING, ANTIGRAVITY_MODEL_ENUM } from "./models.js";

export const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const ANTIGRAVITY_PERSIST_KEY = "pi-antigravity";

type CatalogSnapshot = {
  catalog: AntigravityCatalog;
  checkedAt: number;
  modelEnums: Record<string, string>;
  account: string;
};

export function getCatalogRefreshIntervalMs(): number {
  const envVal = antigravityEnv("CATALOG_REFRESH_INTERVAL_MS") ?? antigravityEnv("REFRESH_INTERVAL_MS");
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_CATALOG_REFRESH_INTERVAL_MS;
}

const fallbackCatalog = (): AntigravityCatalog => ({
  models: ANTIGRAVITY_MODELS,
  routing: { ...ANTIGRAVITY_ROUTING },
});

/** One controller per slot. Neither discovery nor streaming changes the global routing table. */
export function createAntigravityModelDiscovery(providerId: string) {
  let snapshot: CatalogSnapshot = { catalog: fallbackCatalog(), checkedAt: 0, modelEnums: {}, account: "" };
  return {
    getCatalog: () => snapshot.catalog,
    getStreamOptions: () => ({
      modelRouting: snapshot.catalog.routing,
      modelEnums: { ...ANTIGRAVITY_MODEL_ENUM, ...snapshot.modelEnums },
    }),
    async refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
      if (context.signal.aborted) return snapshot.catalog.models;
      const account = credentialIdentity(context.credential);
      const stored = (context.stored as Record<string, unknown> | undefined)?.[ANTIGRAVITY_PERSIST_KEY];
      const cached = isSnapshot(stored) && stored.account === account ? stored : undefined;
      const current = snapshot.account === account ? snapshot : {
        catalog: fallbackCatalog(), checkedAt: 0, modelEnums: {}, account,
      };
      const restored = cached && cached.checkedAt > current.checkedAt ? cached : current;
      // The host rejects stale generations (logout/re-login, cancellation, newer refresh).
      if (restored !== snapshot) {
        if (!await context.publish({ update: () => { snapshot = restored; } })) return snapshot.catalog.models;
      }
      if (!context.allowNetwork || !account || context.signal.aborted) return snapshot.catalog.models;
      const apiKey = apiKeyFromCredential(context.credential);
      if (!apiKey) return snapshot.catalog.models;
      if (!context.force && snapshot.checkedAt > 0 && Date.now() - snapshot.checkedAt < getCatalogRefreshIntervalMs()) {
        return snapshot.catalog.models;
      }
      try {
        const creds = parseApiKey(apiKey);
        const available = await fetchAvailableModelsCatalog(creds.token, creds.projectId, context.signal);
        if (context.signal.aborted) return snapshot.catalog.models;
        const raw = available.data.models ?? {};
        // Static definitions supply metadata only, never another account's entitlements/routes.
        const catalog = buildAntigravityCatalog(raw, fallbackCatalog(), false);
        if (!catalog.models.length) throw new Error("Antigravity returned no selectable models");
        const modelEnums = Object.fromEntries(Object.entries(raw).flatMap(([id, info]) =>
          typeof info?.model === "string" ? [[id, info.model]] : [],
        ));
        const next: CatalogSnapshot = { catalog, checkedAt: Date.now(), modelEnums, account };
        await context.publish({
          persist: {
            models: catalog.models.map((model) => ({ ...model, api: ANTIGRAVITY_API, provider: providerId, baseUrl: DEFAULT_ENDPOINT })) as Model<Api>[],
            [ANTIGRAVITY_PERSIST_KEY]: next,
          } as ModelsStoreEntry,
          update: () => { snapshot = next; },
        });
      } catch (error) {
        // A transient failure must not erase this account's last-known-good list.
        if (context.force && !context.signal.aborted) throw error;
      }
      return snapshot.catalog.models;
    },
  };
}

function credentialIdentity(credential: Credential | undefined): string {
  if (!credential) return "";
  if (credential.type === "api_key") return credential.key ? createHash("sha256").update(credential.key).digest("hex") : "";
  const email = typeof credential.email === "string" ? credential.email.trim().toLowerCase() : "";
  const identity = email || credential.refresh || credential.access;
  if (!identity) return "";
  return createHash("sha256").update(JSON.stringify([identity, credential.projectId ?? ""])).digest("hex");
}

function apiKeyFromCredential(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "api_key") return credential.key || undefined;
  return typeof credential.access === "string" ? getApiKey(credential) : undefined;
}

function isSnapshot(value: unknown): value is CatalogSnapshot {
  return isRecord(value) && typeof value.account === "string" && typeof value.checkedAt === "number" &&
    isRecord(value.catalog) && Array.isArray(value.catalog.models) && value.catalog.models.length > 0 &&
    isRecord(value.catalog.routing) && isRecord(value.modelEnums) &&
    Object.values(value.modelEnums).every((entry) => typeof entry === "string");
}
