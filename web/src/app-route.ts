export type AppSurface = "console" | "design-system";

export function resolveAppSurface(pathname: string): AppSurface {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return normalized === "/design-system" ? "design-system" : "console";
}
