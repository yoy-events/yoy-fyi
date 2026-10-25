---
title: One link for Telegram, Instagram and email, and you still know where each click came from
description: Why stats often can't tell where a visitor came from, and how UTM tags on yoy.fyi short links fix it without making extra links.
date: 2026-10-25
---

# One link for Telegram, Instagram and email, and you still know where each click came from

You posted an event link in a Telegram channel, an Instagram story and a newsletter. A week later the stats say 300 clicks. From where? Often the honest answer is "no idea".

## Why the source gets lost

People who open a link from Instagram or Telegram usually land in the app's built-in browser. Those browsers often don't tell the site which page the visitor came from. To your stats the click looks like a direct visit, and all the channels end up in one pile.

UTM tags fix this in a simple way. The source goes right into the address, for example `?utm_source=telegram&utm_medium=social`. The site and any analytics tool see the tag even when the browser says nothing.

## How yoy.fyi handles it

You don't need a separate short link per channel. A link's page has a "Links for channels" block with ready variants and a Copy button:

- Telegram: `https://yoy.fyi/lviv-gig?utm_source=telegram&utm_medium=social`
- Instagram: `...?utm_source=instagram&utm_medium=social`
- Facebook: `...?utm_source=facebook&utm_medium=social`
- email: `...?utm_source=email&utm_medium=email`

Same code, same QR code. yoy.fyi passes the tags on to the site the link points to. If that site's address already has its own `utm_source`, yoy.fyi leaves it alone.

## Where to see the result

The link's page has a "Channels (utm_source)" block showing how many clicks each channel brought in over 30 days. If yoy.fyi is connected to Claude or ChatGPT, you can just ask: "Where did this week's clicks on lviv-gig come from, by utm_source?"

The raw data is there too. The CSV download gives every click with its time, country, device and UTM tags, which helps if your report lives in a spreadsheet.

## A few habits that help

Write tags in lowercase and keep them consistent. `Telegram`, `telegram` and `tg` show up as three different channels.

For a QR code on a printed poster, make a separate link with its own tag, such as `utm_source=poster`. That keeps offline scans apart from online clicks.

If a link is already out there without tags, that's fine. Its clicks still count, they just fall under "no tag". Use the channel variant for new posts.

## The short version

One short link, a few tagged variants, and the stats show which channel actually works. No spreadsheet of a dozen separate links, no guessing.
