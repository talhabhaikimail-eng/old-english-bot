"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-border transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/40 data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7 data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=unchecked]:bg-secondary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 cursor-pointer",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background transition-transform group-data-[size=default]/switch:size-3.5 group-data-[size=sm]/switch:size-2.5 group-data-[size=default]/switch:data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3 group-data-[size=default]/switch:data-[state=unchecked]:translate-x-0.5 group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-0.5"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
