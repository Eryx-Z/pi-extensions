// execFileSync does not inherit the parent's --import loader. Resolve it here rather
// than from the child's cwd: several fixtures intentionally run outside this repo.
export const typescriptNodeArgs = [
	"--experimental-transform-types",
	"--import",
	new URL("../../../test/register-pi-peers.mjs", import.meta.url).href,
];
