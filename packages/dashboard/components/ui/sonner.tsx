"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// shadcn's current (new-york-v4) Toaster, with its CSS variables wrapped in `hsl()` because this package's
// tokens are bare HSL triplets (Tailwind 3). Variables rather than the older `toastOptions.classNames`: those
// classes tie with sonner's `richColors` rules on specificity, so which one won depended on stylesheet order,
// and the dev server and the build disagreed. `fontFamily: inherit` for the same reason: sonner sets its own
// system font stack on the toaster, and an inline value is the one that wins regardless of stylesheet order.
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "hsl(var(--popover))",
          "--normal-text": "hsl(var(--popover-foreground))",
          "--normal-border": "hsl(var(--border))",
          "--border-radius": "var(--radius)",
          fontFamily: "inherit",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
