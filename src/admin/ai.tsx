// How yoy.fyi is used through AI assistants: MCP calls, links that AI clients created, and
// clicks that arrive from AI chats.
import type { SQL } from "bun";
import { Hono } from "hono";
import { BarChart, Ranking } from "./charts";
import { Layout } from "./layout";

const DAY = 86_400_000;

// Referrer hosts of AI chat apps; a click from one means an assistant showed someone the link.
export const AI_REFERRERS = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "perplexity.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "chat.deepseek.com",
  "grok.com",
  "meta.ai",
  "poe.com",
  "you.com",
];
const aiHostPattern = AI_REFERRERS.map((h) => `(^|\\.)${h.replace(/\./g, "\\.")}$`).join("|");

type Count = { value: string | null; clicks: number };

export function aiRoutes(sql: SQL, now: () => Date) {
  const app = new Hono();

  app.get("/ai", async (c) => {
    const to = new Date(Math.floor(now().getTime() / DAY) * DAY + DAY);
    const from = new Date(to.getTime() - 30 * DAY);
    const [pagesBySource, aiPageReferrers, crawlers, topPages]: Count[][] = await Promise.all([
      sql`select source as value, count(*)::int as clicks from page_views where at >= ${from} and bot_name is null group by 1 order by 2 desc`,
      sql`select referer_host as value, count(*)::int as clicks from page_views
          where at >= ${from} and bot_name is null and source = 'ai_chat' group by 1 order by 2 desc limit 10`,
      sql`select bot_name as value, count(*)::int as clicks from page_views where at >= ${from} and bot_name is not null group by 1 order by 2 desc limit 15`,
      sql`select path as value, count(*)::int as clicks from page_views where at >= ${from} and bot_name is null group by 1 order by 2 desc limit 10`,
    ]);
    const [daily, byClient, byTool, [totals], linksByClient, aiClicks]: [
      { t: Date; clicks: number }[],
      Count[],
      Count[],
      { calls: number; failed: number; services: number; links: number; link_clicks: number }[],
      Count[],
      Count[],
    ] = await Promise.all([
      sql`
        select d as t, coalesce(count(m.id), 0)::int as clicks
        from generate_series(${from}::timestamptz, ${new Date(to.getTime() - DAY)}::timestamptz, interval '1 day') d
        left join mcp_calls m on m.at >= d and m.at < d + interval '1 day'
        group by d order by d`,
      sql`
        select coalesce(cl.name, m.client, 'API key') as value, count(*)::int as clicks
        from mcp_calls m left join oauth_clients cl on cl.client_id = m.client
        where m.at >= ${from} group by 1 order by 2 desc limit 10`,
      sql`select tool as value, count(*)::int as clicks from mcp_calls where at >= ${from} group by 1 order by 2 desc limit 10`,
      sql`
        select (select count(*) from mcp_calls where at >= ${from})::int as calls,
               (select count(*) from mcp_calls where at >= ${from} and not ok)::int as failed,
               (select count(distinct service_id) from mcp_calls where at >= ${from})::int as services,
               (select count(*) from links where created_via = 'mcp')::int as links,
               (select count(*) from clicks k join links l on l.id = k.link_id
                where l.created_via = 'mcp' and not k.is_bot and k.clicked_at >= ${from})::int as link_clicks`,
      sql`
        select coalesce(cl.name, l.created_by_client, 'API key') as value, count(*)::int as clicks
        from links l left join oauth_clients cl on cl.client_id = l.created_by_client
        where l.created_via = 'mcp' group by 1 order by 2 desc limit 10`,
      sql`
        select referer_host as value, count(*)::int as clicks from clicks
        where clicked_at >= ${from} and not is_bot and referer_host ~ ${aiHostPattern}
        group by 1 order by 2 desc limit 10`,
    ]);
    const sum = (rows: Count[]) => rows.reduce((n, r) => n + r.clicks, 0);
    return c.html(
      <Layout title="AI usage" signedIn>
        <h1>Use through AI assistants</h1>
        <p class="meta">Last 30 days, UTC.</p>
        <p>
          {totals!.calls} MCP tool calls ({totals!.failed} failed) from {totals!.services} accounts. {totals!.links} links created over MCP
          in total; their links got {totals!.link_clicks} clicks in 30 days.
        </p>
        <h2>MCP calls per day</h2>
        <BarChart points={daily} label={(t) => t.toISOString().slice(0, 10)} />
        <div class="rankings">
          <Ranking title="Calls by client" items={byClient} total={sum(byClient)} />
          <Ranking title="Calls by tool" items={byTool} total={sum(byTool)} />
          <Ranking title="Links created by client" items={linksByClient} total={sum(linksByClient)} />
          <Ranking title="Clicks from AI chats" items={aiClicks} total={sum(aiClicks)} />
        </div>
        <h2>Visits to the site</h2>
        <p class="meta">Home, blog, docs, bio pages and crawler files. People and crawlers are counted apart.</p>
        <div class="rankings">
          <Ranking title="People by source" items={pagesBySource} total={sum(pagesBySource)} />
          <Ranking title="People from AI chats" items={aiPageReferrers} total={sum(aiPageReferrers)} />
          <Ranking title="Crawlers" items={crawlers} total={sum(crawlers)} />
          <Ranking title="Top pages (people)" items={topPages} total={sum(topPages)} />
        </div>
      </Layout>,
    );
  });

  return app;
}
