import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGrokProvider } from "./grok/register.ts";

/** Provider-only entrypoint: never loads another plugin or changes the child's tools/model. */
export default function grokCliChildProvider(pi: ExtensionAPI) {
	if (process.env.PI_RPC_SUBAGENT_CHILD !== "1") {
		throw new Error("Grok child provider requires an RPC subagent");
	}
	registerGrokProvider(pi, true);
}
