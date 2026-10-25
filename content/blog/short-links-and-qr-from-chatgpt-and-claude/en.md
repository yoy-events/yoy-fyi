---
title: Short links and QR codes straight from ChatGPT or Claude
description: Connect yoy.fyi to Claude or ChatGPT and create working short links, QR codes and click stats with a plain chat message.
date: 2026-10-25
---

# Short links and QR codes straight from ChatGPT or Claude

You ask an assistant to shorten a link and it invents a URL that goes nowhere. It happens a lot. A language model can't make a working short link on its own. Something has to store the link and do the redirect.

yoy.fyi is that something, and you can plug it into Claude or ChatGPT. After that, the links the chat gives you are real. They open, they have a QR code, and they count clicks.

## What you need

A Google account and two minutes. yoy.fyi is free and there is no separate sign-up: signing in with Google creates the account.

Every client uses the same address:

```
https://yoy.fyi/mcp
```

That is an MCP server. MCP, the Model Context Protocol, is an open protocol that assistants use to call outside tools.

## Connect it to Claude

1. Open claude.ai, go to settings, then Connectors.
2. Choose Add custom connector and paste `https://yoy.fyi/mcp`.
3. Click Connect. yoy.fyi opens. Sign in with Google.
4. On the permissions page, tick "Create, change and disable short links". It starts unticked, and without it Claude can only read your links.
5. Click Allow. You land back in Claude.

In a new chat, turn yoy.fyi on from the "+" button under connectors. Anthropic renames these menus now and then, but the path stays close to this.

## Connect it to ChatGPT

ChatGPT runs custom connectors through developer mode: Settings, Apps & Connectors, Advanced, Developer mode. Create a connector with the same address, `https://yoy.fyi/mcp`. Sign-in and the permissions page work the same way as above. Whether you see the option depends on your plan.

## Things you can ask

These work:

- "Shorten https://example.com/lviv-concert-october-25 and call it Lviv concert"
- "Make a link with the code lviv-gig to https://example.com/gig"
- "How many clicks did lviv-gig get this week, and from which countries?"
- "Show my links tagged music"
- "Point lviv-gig at https://example.com/gig-new instead"
- "Disable lviv-gig"

The assistant calls the yoy.fyi tools and hands back a real address such as `https://yoy.fyi/lviv-gig`. Open it in a browser to check.

## What about the QR code?

Every link has one. Download it from the link's page on yoy.fyi, as a 1024 pixel PNG for print or as SVG for design files. On the same page you can change the colours and add a caption under the code, like "Scan me". The code points at the short link, so every scan shows up in the stats too.

## What the assistant can see

Only your links, and only with the permissions you granted. The connection is listed under Connected apps in your yoy.fyi account. Revoke it there and its token stops working at once.

## Why not just ask the model

A model can write text that looks like a link. The redirect lives on a server, though, and something has to keep it, check the address and count the clicks. yoy.fyi does that part. The chat is just a handy way to drive it.
