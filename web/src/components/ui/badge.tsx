import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

// shadcn/ui Badge — pill/chip. Kept small so it slides inline with body
// text. Colored variants map to the semantic tokens we use elsewhere,
// so a page never needs to hand-pick a colour.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [&_svg]:size-3",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/15 text-primary-foreground/90 [&]:text-primary",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground border-border",
        success:
          "border-success/40 bg-success/10 text-success",
        destructive:
          "border-destructive/40 bg-destructive/10 text-destructive",
        warning:
          "border-yellow-500/40 bg-yellow-500/10 text-yellow-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
