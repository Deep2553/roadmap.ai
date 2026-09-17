"use client";

import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  // Both icons are always rendered and swapped by the `dark` class variant, so
  // the server and client markup are identical. Branching on `resolvedTheme`
  // instead would render Moon on the server (theme unknown) and Sun on the
  // client for a dark-mode visitor — a hydration mismatch.
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun className="hidden size-4 dark:block" />
      <Moon className="size-4 dark:hidden" />
    </Button>
  );
}
