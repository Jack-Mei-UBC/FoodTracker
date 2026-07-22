// shadcn/ui's expected utility module. Every generated component imports `cn`
// from here (wired via `aliases.utils` in components.json).
//
// `cn` merges conditional class names (clsx) and then resolves Tailwind
// conflicts (tailwind-merge) so the LAST class wins per CSS property. That
// matters for the variant pattern: a component defines a default like
// `px-4 py-2` and a caller passes `px-6` without both ending up in the class
// string with the winner decided by stylesheet order.
//
// NOTE this is a different mechanism from the `@utility` class vocabulary in
// globals.css (.card/.btn/.badge/...), which relies on Tailwind's layer
// ordering so an inline utility beats the named class. Both are in play until
// Phase 3 retires the old vocabulary — see CLAUDE.md and SHADCN-MIGRATION.md.
//
// Body kept byte-identical to what `shadcn init` generates, so re-running the
// CLI reports no diff and never clobbers this file.

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
