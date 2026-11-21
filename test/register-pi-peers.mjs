import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

for (const key of Object.keys(process.env)) {
	if (key.startsWith("PI_RPC_SUBAGENT_") || key.startsWith("PI_SUBAGENT_")) {
		delete process.env[key];
	}
}

let resolvedUrls;

function getPiParentUrls() {
	if (resolvedUrls !== undefined) return resolvedUrls;
	const candidates = [
		process.env.PI_GLOBAL_NODE_MODULES,
		join(homedir(), ".npm-global", "lib", "node_modules"),
		join(dirname(process.execPath), "..", "lib", "node_modules"),
	].filter(Boolean);

	for (const root of candidates) {
		const agentPkg = join(root, "@earendil-works", "pi-coding-agent", "package.json");
		if (existsSync(agentPkg)) {
			resolvedUrls = {
				npmParentUrl: pathToFileURL(join(root, "_")).href,
				piParentUrl: pathToFileURL(agentPkg).href,
			};
			return resolvedUrls;
		}
	}

	try {
		const env = { ...process.env };
		delete env.npm_config_prefix;
		delete env.NPM_CONFIG_PREFIX;
		const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim();
		const agentPkg = join(npmRoot, "@earendil-works", "pi-coding-agent", "package.json");
		if (existsSync(agentPkg)) {
			resolvedUrls = {
				npmParentUrl: pathToFileURL(join(npmRoot, "_")).href,
				piParentUrl: pathToFileURL(agentPkg).href,
			};
			return resolvedUrls;
		}
	} catch {
		// Fall through if npm is unavailable.
	}

	resolvedUrls = null;
	return null;
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file://")) {
				const fallbacks = specifier.endsWith(".js")
					? [`${specifier.slice(0, -3)}.ts`]
					: !/\.[a-z0-9]+$/i.test(specifier)
						? [`${specifier}.ts`, `${specifier}/index.ts`]
						: [];
				for (const candidate of fallbacks) {
					try {
						return nextResolve(candidate, context);
					} catch {
						// Try next relative TypeScript fallback.
					}
				}
			}
			const urls = getPiParentUrls();
			if (!urls) throw error;
			if (
				specifier === "@earendil-works/pi-coding-agent" ||
				specifier.startsWith("@earendil-works/pi-coding-agent/")
			) {
				return nextResolve(specifier, { ...context, parentURL: urls.npmParentUrl });
			}
			if (
				specifier.startsWith("@earendil-works/") ||
				specifier === "typebox" ||
				specifier.startsWith("typebox/")
			) {
				return nextResolve(specifier, { ...context, parentURL: urls.piParentUrl });
			}
			throw error;
		}
	},
});
