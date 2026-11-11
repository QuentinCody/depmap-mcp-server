/** Preserve session staging handles; resolve only the documented cohort aliases. */
export function resolveDataAccessArgs(args: Record<string, unknown>): Record<string, unknown> {
  const id = args.data_access_id;
  return id === "adult:current" || id === "pediatric:current"
    ? { ...args, data_access_id: `release:${id}` }
    : args;
}
