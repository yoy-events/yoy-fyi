---
title: A QR code for posters that you can still change after printing
description: How to prepare a print QR code on yoy.fyi so it scans, counts scans separately and points where it should, even after printing.
date: 2026-10-25
---

# A QR code for posters that you can still change after printing

The posters are printed, and the sign-up page has just moved to another address. If the QR code pointed straight at the old page, the print run is ruined. If it pointed at a short link, you only change where the link goes.

## Why a short link is better

A yoy.fyi QR code encodes an address like `https://yoy.fyi/fest`. You decide where it redirects on the link's page, any time, in the edit form. The printed code stays the same.

A short code also makes the QR simpler. Less data means fewer tiny squares, and it scans better from a distance.

## Formats for print

The link's page offers two:

- a 1024 pixel PNG, for flyers and social media;
- an SVG, which is vector, for large formats. It scales without losing quality, which keeps print shops happy.

## Colours and caption

In the QR colours and caption block you can pick the colour of the code and of the background. yoy.fyi won't let you make a light code on a dark background or colours with too little contrast, because many phones simply can't read those.

You can add a caption under the code, like "Scan me" or "Register". The caption exists only in the SVG.

## Count scans apart from clicks

Make a separate short link for the poster. Its page on yoy.fyi then shows only poster scans, apart from Instagram clicks. Add a tag like `?utm_source=poster` to the address it points to, and your site's own analytics will see those scans too.

## Test before printing

Scan the code from the screen with two different phones, then from a proof print at the distance people will see it. On a poster, keep the code at least 3 by 3 centimetres, and bigger for posters read from far away.
