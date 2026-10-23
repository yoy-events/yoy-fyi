// Sends plain-text email through Resend's HTTP API. Errors never include the API key.
export function resendSender(apiKey: string, from: string, send: typeof fetch = fetch) {
  return async ({ to, subject, text }: { to: string; subject: string; text: string }) => {
    const res = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
  };
}
