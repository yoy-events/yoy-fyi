---
title: A hundred short links at once from a CSV file
description: How to create many yoy.fyi short links with one file from a spreadsheet, and how to export your links and clicks back to CSV.
date: 2026-10-25
---

# A hundred short links at once from a CSV file

Before a festival you have a spreadsheet with thirty sessions, and each one needs a short link and a QR code. Making them one by one takes ages. yoy.fyi takes a CSV file.

## The format

The first line names the columns. One is required, `target_url`. Three more are optional:

- `title`: the link's name;
- `code`: your own code, such as `fest-day1`;
- `tags`: comma-separated tags, with the whole cell in quotes.

```
target_url,title,code,tags
https://example.com/fest/day-1,Festival day 1,fest-day1,"fest, day1"
https://example.com/fest/day-2,Festival day 2,fest-day2,"fest, day2"
```

Build it in Google Sheets or Excel and save it as CSV.

## Importing

The home page has an import link under the create form. Upload the file or paste the text. One import takes up to 100 rows and 256 KB, and you can run five imports an hour.

Afterwards you get a list. Each row shows either the new short link with a Copy button, or the reason it failed, with the line number. Good rows are created even when a neighbouring row has a problem, such as a code that's taken or an address that isn't http.

## Exporting

The export link gives you all your links: code, short address, target, title, tags, status and total clicks. Each link's page also has a CSV download of its individual clicks, with time, country, device and UTM tags.

Cells a spreadsheet might treat as a formula, such as ones starting with `=`, get an apostrophe in front. Opening the file in Excel is safe.

## From a chat

Through Claude or ChatGPT you can create up to 20 links in one request. Try: "Make short links for these five pages and tag them fest."
