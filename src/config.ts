// Every absolute URL derives from PUBLIC_ORIGIN. Non-secret values live in compose.prod.yml;
// secrets live only in the env file on the server (ADR-0002).
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
    // The header the fronting proxy sets to the visitor's IP: cf-connecting-ip behind Cloudflare Tunnel.
    clientIpHeader: env.CLIENT_IP_HEADER?.toLowerCase() || undefined,
    // Secret: 32 random bytes, base64. Encrypts webhook signing secrets at rest.
    webhookEncKey: required("WEBHOOK_ENC_KEY"),
    // Who may sign in to /admin and the sender of sign-in emails.
    adminEmail: required("ADMIN_EMAIL"),
    mailFrom: required("MAIL_FROM"),
    // Secrets.
    sessionSecret: required("SESSION_SECRET"),
    resendApiKey: required("RESEND_API_KEY"),
    // Optional Sign in with Google for /admin: the client ID lives in deploy/<stage>.env, the secret
    // only on the server. Both or neither.
    google: googleSignIn(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  };
}

function googleSignIn(clientId: string | undefined, clientSecret: string | undefined) {
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
  return { clientId, clientSecret };
}
