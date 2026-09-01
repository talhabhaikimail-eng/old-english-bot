import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-none border border-transparent bg-clip-padding text-sm font-semibold uppercase tracking-wider whitespace-nowrap transition-all outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary active:translate-y-px disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90 border-primary",
        outline:
          "border-border bg-background text-foreground hover:bg-foreground hover:text-background border-border",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-muted border-border",
        ghost:
          "hover:bg-secondary hover:text-foreground text-foreground",
        destructive:
          "bg-background text-foreground border border-border hover:bg-foreground hover:text-background",
        link: "text-foreground underline-offset-4 hover:underline p-0 h-auto font-normal",
      },
      size: {
        default: "h-8 gap-2 px-3",
        xs: "h-6 gap-1 px-2 text-[10px]",
        sm: "h-7 gap-1.5 px-2.5 text-xs",
        lg: "h-10 gap-2.5 px-4 text-sm font-bold",
        icon: "size-8",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
