// Every absolute URL derives from PUBLIC_ORIGIN, which lives in fly.toml [env], never in secrets.
export function loadConfig(env = process.env) {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    publicOrigin: new URL(required("PUBLIC_ORIGIN")).origin,
    databaseUrl: required("DATABASE_URL"),
    geoipDbPath: env.GEOIP_DB_PATH ?? "data/dbip-country-lite.mmdb",
    port: Number(env.PORT ?? 3000),
  };
}
