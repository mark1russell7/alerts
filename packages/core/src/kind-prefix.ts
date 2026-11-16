// The one rule of the prefixes of the kinds. It is a leaf module, so the assessment and the relevance both import it with no cycle.

/**
 * This function tells if a kind has one of the prefixes. A prefix ends at a dot: `met.flood` has
 * `met.flood.flash`, but `met.fl` does not have `met.flood`. The adapters and the core use this one rule.
 */
export function hasKind(prefixes: readonly string[], kind: string): boolean {
  return prefixes.some((prefix) => kind === prefix || kind.startsWith(`${prefix}.`));
}
