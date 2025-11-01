# Digifilm

Photo gallery made with Eleventy (static site generator), Alpine.js (interactivity) and Vite (bundling).

Highly reliant on Cloudflare technology -- Cloudflare Pages is used to build and serve the site, Cloudflare Workers KV for album data, Cloudflare R2 for image buckets, and a Cloudflare Worker for the API. This allows the site to be fully dynamic without requiring a compute server.

