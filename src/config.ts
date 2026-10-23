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
    // Fly secret: 32 random bytes, base64. Encrypts webhook signing secrets at rest.
    webhookEncKey: required("WEBHOOK_ENC_KEY"),
    // In fly.toml [env]: who may sign in to /admin and the sender of sign-in emails.
    adminEmail: required("ADMIN_EMAIL"),
    mailFrom: required("MAIL_FROM"),
    // Fly secrets.
    sessionSecret: required("SESSION_SECRET"),
    resendApiKey: required("RESEND_API_KEY"),
  };
}
