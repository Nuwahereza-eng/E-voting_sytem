import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes deterministically. `clsx` handles conditional
 * classes; `tailwind-merge` de-duplicates conflicts (e.g. `p-2 p-4` →
 * `p-4`). Used by every shadcn-style primitive.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
