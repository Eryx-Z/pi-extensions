// execFileSync does not inherit the parent's --import loader. Resolve it here rather
// than from the child's cwd: several fixtures intentionally run outside this repo.
export const typescriptNodeArgs = ["--import", import.meta.resolve("tsx")];
