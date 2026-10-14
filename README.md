# NAYORA site

A static news site that rebuilds itself every 30 minutes.

1. Collects cybersecurity news from public RSS feeds.
2. Groups reports about the same event into one story.
3. Writes an original article for each story with the Claude API (plain-English section, security-team notes, key terms), using only facts in the sources.
4. Links to every source and re-checks links on each build. A source that returns 404 or 410 is removed, and a story with no sources left is removed.
5. Builds crawlable pages: home, category pages, story pages, About, Editorial policy, Contact, Privacy, Terms, Disclaimer, sitemap.xml, robots.txt and ads.txt.

## Set up
1. Edit `site.config.json`: `url` (your own domain), `email` (a working address), `owner`.
2. Put this folder in a GitHub repository. Add the repository secret `ANTHROPIC_API_KEY`. Turn on GitHub Pages with "GitHub Actions" as the source and connect your domain.
3. Test locally: `npm run build:mock` (fake data, no key needed), then open `dist/index.html`.

## Apply for AdSense
Approval is Google's decision and is not guaranteed. What helps:
- Use your own domain (not `*.github.io`) and let the site run for a few weeks first. Aim for 30 or more published stories.
- Replace every placeholder in `site.config.json`. Production builds refuse to run until you do.
- Apply at adsense.google.com, add the site, and verify it.
- After approval, set `adsenseClient` (for example `ca-pub-1234567890123456`) and the four ad slot IDs in `site.config.json`. The build then adds the ad code and `ads.txt`. Before approval no ad code is added.
- In AdSense, open Privacy & messaging and publish the consent message for the EEA, UK and Switzerland.
- Keep stories accurate. Read the Editorial policy page and make sure it describes what you actually do. If you start reviewing articles by hand, update it.
- Check each source's terms of use. NAYORA shows its own text and links to sources, and does not show source text.

## Test on Vercel (free)
1. Push this folder to a GitHub repository.
2. At vercel.com choose Add New, then Project, and import the repository. Framework preset: Other. Leave the build settings alone, because `vercel.json` sets them.
3. Before deploying, open Environment Variables and add `ANTHROPIC_API_KEY`.
4. Deploy. You get an address like `nayora-xxxx.vercel.app`.

Test deploys write at most 5 new articles per build, show no ads, and tell search engines not to index the site. To update the stories, press Redeploy in Vercel. Vercel's free Hobby plan is for non-commercial use, so move to your own domain on a host that allows commercial sites (for example Cloudflare Pages, or Vercel Pro) before turning ads on.
