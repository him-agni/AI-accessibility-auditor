# Clarity

Clarity is an AI-assisted accessibility scanner interface for one public webpage at a time. It turns grouped automated findings into a plain-language report with element evidence, authoritative WCAG links, and cautious fix suggestions.

## Current release

This repository contains the complete product interface, persistent audit records, anonymous rate limiting, URL validation, progress and error states, and a representative axe-core report experience. The deployed Sites version is an interactive product preview: its findings are clearly labeled as representative until a separate isolated Playwright/axe worker is connected.

The product never describes an automated scan as certification. Every report states that manual testing and assistive-technology evaluation are still required.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validate

```bash
npm test
npm run lint
npx tsc --noEmit
```

## Data

Cloudflare D1 stores audit records and supports the issue-group, occurrence, and fix-suggestion model. Generated migrations are in `db/migrations`. Anonymous results expire after seven days and submissions are limited to three per hour per request fingerprint.

## Production scanner boundary

The browser scanner belongs in a separately isolated worker/container with Playwright, Chromium, and axe-core. That worker must repeat URL and IP validation across redirects and subresources, enforce egress restrictions and job limits, and treat every page as untrusted. The web experience is already shaped to poll that asynchronous job and display its normalized results.
