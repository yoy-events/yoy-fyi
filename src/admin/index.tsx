import type { SQL } from "bun";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { type AdminConfig, authRoutes, requireAdmin } from "./auth";
import { linkRoutes } from "./links";
import { serviceRoutes } from "./services";

export type { AdminConfig };

type Deps = {
  sql: SQL;
  publicOrigin: string;
  admin: AdminConfig;
  now: () => Date;
  resolveHost?: (host: string) => Promise<string[]>;
};

export function adminRoutes(deps: Deps) {
  const app = new Hono();
  // Form posts must come from our own origin; SameSite=Lax alone does not cover every case.
  app.use(csrf({ origin: deps.publicOrigin }));
  app.route("/", authRoutes(deps));

  const pages = new Hono();
  pages.use(requireAdmin(deps));
  pages.route("/", serviceRoutes(deps.sql));
  pages.route("/", linkRoutes(deps));
  app.route("/", pages);
  return app;
}
