---
title: Which link brought the sign-ups and the money: conversions in yoy.fyi
description: How to tell yoy.fyi that a click ended in a sign-up or a purchase, and see on the link's page how many people and how much money it brought.
date: 2026-10-26
---

# Which link brought the sign-ups and the money: conversions in yoy.fyi

A click alone says little. What matters is whether the person signed up or bought a ticket. If you put different links in Telegram, Instagram and a newsletter, you want to know which one brought money, not just clicks.

## How it works

1. Create the link with `pass_click_id: true`. yoy.fyi then adds `yoy_sid`, the id of that exact click, to the address the link points to.
2. On your site, keep `yoy_sid` (in a cookie or a hidden form field) and carry it through to sign-up or checkout.
3. When the event happens, your server reports it to yoy.fyi with that id.

```
POST https://yoy.fyi/v1/conversions
Authorization: Bearer yfi_...

{ "click_id": "01a17...", "event": "purchase", "value": 450, "currency": "UAH", "external_id": "order-77" }
```

The key needs the `conversions:write` permission. You can pick it on the API keys page.

## Retries

`external_id` is your own id for the event, such as an order number. If a request is sent twice, the second answer returns the same conversion and nothing is counted twice. If different data arrives under the same id, yoy.fyi answers with a `conversion_conflict` error.

## Where to see the result

The link's page has a block for the last 30 days: how many sign-ups, how many purchases and for how much. Amounts are summed per currency, because hryvnias and dollars can't be added together.

Through the API, `GET /v1/analytics/conversions` returns the same. And if yoy.fyi is connected to Claude or ChatGPT, you can ask: "How many purchases did the spring-concert link bring this month?"

## Good to know

A conversion can only be recorded for a click on your own service's link. yoy.fyi won't accept another service's click id. The event time can't be earlier than the click or in the future. These checks guard against mistakes, not fraud: if your server sends false data, the stats will be false.
