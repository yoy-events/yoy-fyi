import type { SQL } from "bun";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { aiRoutes } from "./ai";
import { appsRoutes } from "./apps";
import { userRoutes } from "./users";
import { type AdminConfig, authRoutes, requireAdmin } from "./auth";
import type { UnsafeUrls } from "../safe-browsing";
import { linkRoutes } from "./links";
import { serviceRoutes } from "./services";

export type { AdminConfig };

type Deps = {
  sql: SQL;
  publicOrigin: string;
  admin: AdminConfig;
  now: () => Date;
  resolveHost?: (host: string) => Promise<string[]>;
  unsafeUrls?: UnsafeUrls;
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
  pages.route("/", appsRoutes(deps.sql, deps.now));
  pages.route("/", userRoutes(deps.sql, deps.now));
  pages.route("/", aiRoutes(deps.sql, deps.now));
  app.route("/", pages);
  return app;
}
