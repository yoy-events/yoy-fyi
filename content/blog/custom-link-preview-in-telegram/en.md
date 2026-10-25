---
title: How your link looks in Telegram, and how to change it
description: Set your own title, description and image for the preview of a short link in Telegram, Facebook, WhatsApp and other messengers.
date: 2026-10-25
---

# How your link looks in Telegram, and how to change it

Paste a link into Telegram and a card appears under it: title, description, image. Telegram takes them from the page the link points to. If that page lacks the right tags, the card comes out empty or with a random image, and people click it less.

## Your own preview on yoy.fyi

yoy.fyi short links have preview fields. On the site they sit under the extra options when you create a link, and in the edit form later:

- preview title, up to 200 characters;
- description, up to 500;
- image address, https, ideally 1200 by 630 pixels or larger.

When the preview bot of Telegram, Facebook, X, LinkedIn, Slack, WhatsApp or Discord opens the link, yoy.fyi gives it a page with your tags. A person who clicks goes straight to the real address, with no page in between.

Leave the preview empty and nothing changes. The bot follows the link and reads the site's own tags as usual.

## The card stays honest

The card always shows the domain the link really goes to. You can set your own title and image, but you can't disguise the site. yoy.fyi checks the image address the same way it checks the link itself.

## Telegram remembers previews

Telegram caches the card. If you changed the preview and chats still show the old one, message @WebpageBot and send it the link. It refreshes the card for everyone.

## From a chat

This works through Claude or ChatGPT too: "Change the preview for lviv-gig: title Lviv concert, October 25, image https://example.com/poster.jpg." The assistant calls `update_link` with the `preview` field.
