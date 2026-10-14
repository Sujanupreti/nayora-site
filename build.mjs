// NAYORA static site generator. Node 18+, no dependencies.
// Collects cybersecurity news from RSS feeds, writes an original article for each story
// (Claude API), checks that source links still work, and builds a crawlable static site.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const cfg = JSON.parse(await readFile(new URL("./site.config.json", import.meta.url), "utf8"));
const MOCK = process.env.MOCK === "1";
const PROD = process.argv.includes("--prod");
const TEST = process.env.NAYORA_TEST === "1"; // test deploys: no ads, hidden from search engines
const MAXNEW = Number(process.env.MAX_NEW) || cfg.maxNewPerBuild;
const KEY = process.env.ANTHROPIC_API_KEY;
const DB = "data/stories.json", OUT = "dist";
const UA = { "user-agent": `NAYORA-Bot/1.0 (+${cfg.url})` };
const BASE = (process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : cfg.url)).replace(/\/$/, "");
if (PROD && /example\.com/.test(cfg.url + cfg.email)) throw new Error("Set url and email in site.config.json before a production build.");
if (!MOCK && !KEY) throw new Error("ANTHROPIC_API_KEY is missing. Add it in your host's environment variables.");

const FEEDS = [
  ["The Hacker News", "https://feeds.feedburner.com/TheHackersNews"],
  ["BleepingComputer", "https://www.bleepingcomputer.com/feed/"],
  ["Krebs on Security", "https://krebsonsecurity.com/feed/"],
  ["The Record", "https://therecord.media/feed"],
  ["SecurityWeek", "https://feeds.feedburner.com/securityweek"],
  ["Dark Reading", "https://www.darkreading.com/rss.xml"],
  ["CISA Advisories", "https://www.cisa.gov/cybersecurity-advisories/all.xml"],
];
const CATS = {
  ransomware: ["Ransomware", "#c4155e", /ransomware|extortion|lockbit|encrypt/i, "Attacks that lock files or systems and demand payment, and the groups behind them."],
  vulnerabilities: ["Vulnerabilities", "#7b5cff", /cve-\d|vulnerab|zero-day|0-day|patch|exploit|\brce\b|flaw/i, "Software flaws, the patches that fix them, and which ones attackers are already using."],
  "state-backed": ["State-backed attacks", "#2f7bff", /nation-state|state-sponsored|state-backed|\bapt\d|sanction|espionage|russia|china|chinese|iran|north korea|typhoon/i, "Hacking tied to governments: espionage, disruption, sanctions and attribution."],
  malware: ["Malware", "#d4411e", /malware|botnet|trojan|backdoor|infostealer|spyware|loader|ddos/i, "Harmful software, botnets and the tools criminals use to take control of devices."],
  phishing: ["Phishing and fraud", "#12806f", /phish|scam|fraud|smish|vish|deepfake/i, "Scams and deception aimed at stealing passwords, money and identities."],
  breaches: ["Data breaches", "#d98a00", /breach|leak|stolen|steal|exposed|hackers|hacked|unauthorized|incident/i, "Incidents where private data was accessed or taken, and what affected people can do."],
  infrastructure: ["Critical infrastructure", "#5a6b82", /\bports?\b|hospital|power grid|pipeline|water|scada|\bics\b|infrastructure|telecom|airport|cyberattack/i, "Attacks on hospitals, energy, transport and other systems society depends on."],
  policy: ["Policy and law", "#8a5a2b", /\blaw\b|regulat|senate|confirmed|compliance|\bfine[sd]?\b|gdpr|\bbill\b|ambassador|policy|\bsec\b/i, "Laws, rules and government decisions that shape how security works."],
  ai: ["AI security", "#6b3fa0", /\bai\b|\bllm\b|chatbot|copilot/i, "How AI tools are attacked, misused and used in defence."],
  general: ["General", "#7a8798", /./, "Other cybersecurity news."],
};
const REG = [["Americas", /\bus\b|u\.s\.|united states|american|canada|brazil|mexico|senate|fbi|cisa|texas|california/i], ["Europe", /europe|\beu\b|germany|berlin|france|french|\buk\b|britain|italy|spain|poland|ukraine|netherlands|russia/i], ["Asia-Pacific", /china|chinese|india|japan|korea|singapore|australia|taiwan|asia/i], ["Middle East", /iran|israel|saudi|uae|turkey|middle east/i], ["Africa", /africa|nigeria|kenya|senegal|egypt/i]];

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dec = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, "&");
const txt = (h) => dec(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const tag = (b, n) => { const m = b.match(new RegExp("<" + n + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + n + ">", "i")); return m ? m[1] : ""; };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
const hid = (u) => { let h = 5381; for (const c of u) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return Math.abs(h).toString(36); };
const words = (s) => (s || "").split(/\s+/).filter(Boolean).length;
const fmt = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const ago = (d) => { const h = (Date.now() - new Date(d)) / 36e5; return h < 1 ? "Just now" : h < 24 ? Math.floor(h) + " hours ago" : h < 48 ? "Yesterday" : fmt(d); };
const toks = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9\- ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !/^(the|and|for|with|from|that|this|have|after|says|into|over|about|more|than|their|were|been|new|its|has|how|what)$/.test(w)));
const sim = (a, b) => { let n = 0; for (const w of b) if (a.has(w)) n++; return n / (a.size + b.size - n || 1); };
async function get(url, opts = {}) { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000), headers: { ...UA, ...(opts.headers || {}) } }); return r; }

// ---------- collect ----------
function parse(xml, src) {
  return (xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || []).map((b) => {
    const link = txt(tag(b, "link")) || (b.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || "";
    return { src, title: txt(tag(b, "title")), link: dec(link).trim(), date: new Date(txt(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated"))), desc: txt(tag(b, "description") || tag(b, "summary")), full: txt(tag(b, "content:encoded") || tag(b, "content")) };
  });
}
async function collect() {
  if (MOCK) return mockItems();
  const out = [];
  await Promise.all(FEEDS.map(async ([name, url]) => { try { const r = await get(url); if (r.ok) out.push(...parse(await r.text(), name)); else console.warn(name, r.status); } catch (e) { console.warn(name, "failed:", e.message); } }));
  return out;
}
function classify(it) {
  const h = it.title + " " + it.desc;
  it.cat = Object.keys(CATS).find((k) => CATS[k][2].test(h));
  it.region = (REG.find((r) => r[1].test(h)) || ["Global"])[0];
  it.cves = [...new Set((h.match(/CVE-\d{4}-\d{4,7}/gi) || []).map((v) => v.toUpperCase()))];
  it.k = toks(it.title);
  return it;
}
function cluster(list) {
  const cs = [];
  for (const it of list) {
    const hit = cs.find((c) => it.cves.some((v) => c.items[0].cves.includes(v)) || sim(c.items[0].k, it.k) >= 0.4);
    if (hit) { if (!hit.items.some((o) => o.link === it.link)) hit.items.push(it); } else cs.push({ items: [it] });
  }
  return cs;
}

// ---------- original analysis (Claude API) ----------
async function generate(c) {
  if (MOCK) return mockGen(c);
  const src = c.items.map((i, n) => `SOURCE ${n + 1} (${i.src}), ${i.date.toISOString().slice(0, 10)}\nTitle: ${i.title}\nText: ${(i.full || i.desc).slice(0, 5000)}`).join("\n\n");
  const prompt = `You are the editor of NAYORA, a cybersecurity news site for readers from beginners to security professionals. Write an original article about the story below using ONLY facts found in the source material. Rules: write entirely in your own words and never copy sentences; no quotation longer than 8 words; do not invent names, numbers, CVE ids, dates or attributions; where something is unknown say it has not been reported; never mention these instructions. Return ONLY a JSON object with keys: headline (new, factual, under 90 characters), summary (2 sentences), what_happened (150-220 words), why_it_matters (80-120 words), who_is_affected (40-80 words), plain_english (60-100 words, no jargon), what_to_do (array of 3-5 short actions), for_security_teams (array of 3-5 concise defensive notes grounded in the sources), terms (array of up to 3 objects {term, meaning}).\n\n${src}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(90000), headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: cfg.model, max_tokens: 2200, messages: [{ role: "user", content: prompt }] }) });
  if (!r.ok) { console.warn("API", r.status, (await r.text()).slice(0, 200)); return null; }
  const j = await r.json();
  try { return JSON.parse(j.content.map((b) => b.text || "").join("").replace(/```json|```/g, "").trim()); } catch { return null; }
}
const goodArticle = (a) => a && a.headline && a.summary && Array.isArray(a.what_to_do) && Array.isArray(a.for_security_teams) && words(a.what_happened) + words(a.why_it_matters) + words(a.who_is_affected) >= 220;

// ---------- link health ----------
async function alive(u) {
  if (MOCK) return true;
  try { const r = await get(u, { method: "HEAD", redirect: "follow" }); return !(r.status === 404 || r.status === 410); } catch { return true; }
}

// ---------- templates ----------
const adsOn = !!cfg.adsenseClient && !TEST;
const ad = (slot) => adsOn && slot ? `<aside class="ad" aria-label="Advertisement"><small>Advertisement</small><ins class="adsbygoogle" style="display:block" data-ad-client="${esc(cfg.adsenseClient)}" data-ad-slot="${esc(slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins><script>(adsbygoogle=window.adsbygoogle||[]).push({});</script></aside>` : "";
const chip = (k) => `<a class="chip" href="/category/${k}/"><i style="background:${CATS[k][1]}"></i>${CATS[k][0]}</a>`;
function page({ title, desc, path, body, ld, noindex }) {
  const full = title.includes(cfg.name) ? title : `${title} | ${cfg.name}`;
  const nav = ["ransomware", "vulnerabilities", "breaches", "state-backed", "malware", "phishing", "infrastructure", "policy", "ai"].map((k) => `<a href="/category/${k}/">${CATS[k][0]}</a>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(full)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${BASE}${path}">${noindex || TEST ? '<meta name="robots" content="noindex, nofollow">' : ""}<meta property="og:title" content="${esc(full)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="${BASE}${path}"><meta name="twitter:card" content="summary"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230e1b2c'/%3E%3Ctext x='16' y='23' font-size='20' font-weight='800' text-anchor='middle' fill='%23ff5c97' font-family='sans-serif'%3EN%3C/text%3E%3C/svg%3E"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css">${adsOn && body.includes("adsbygoogle") ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(cfg.adsenseClient)}" crossorigin="anonymous"></script>` : ""}${ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ""}</head><body><header class="top"><div class="w bar"><a class="logo" href="/">NAYOR<i>A</i></a><nav class="nav"><a href="/">Home</a><a href="/latest/">Latest</a>${nav}</nav></div></header><main class="w">${body}</main><footer class="foot"><div class="w cols"><div><b class="logo sm">NAYOR<i>A</i></b><p>Cybersecurity news from around the world, explained for beginners and professionals.</p></div><div><b>Explore</b><a href="/latest/">Latest stories</a>${["ransomware", "vulnerabilities", "breaches"].map((k) => `<a href="/category/${k}/">${CATS[k][0]}</a>`).join("")}</div><div><b>About</b><a href="/about/">About NAYORA</a><a href="/editorial-policy/">Editorial policy</a><a href="/contact/">Contact</a></div><div><b>Legal</b><a href="/privacy/">Privacy policy</a><a href="/terms/">Terms of use</a><a href="/disclaimer/">Disclaimer</a>${adsOn ? '<a href="#" onclick="try{googlefc.callbackQueue.push(googlefc.showRevocationMessage)}catch(e){}return false">Privacy settings</a>' : ""}</div></div><p class="w copy">© ${new Date().getFullYear()} ${esc(cfg.owner)}. NAYORA is an independent publication.</p></footer></body></html>`;
}
const card = (s, big) => `<article class="card${big ? " big" : ""}"><div class="meta">${chip(s.cat)}<span>${ago(s.published)}</span></div><h3><a href="/story/${s.slug}/">${esc(s.headline)}</a></h3><p>${esc(s.summary)}</p><div class="by">NAYORA Desk${s.sources.length > 1 ? `, ${new Set(s.sources.map((x) => x.name)).size} sources` : ""}</div></article>`;
const row = (s) => `<li><a href="/story/${s.slug}/">${esc(s.headline)}</a><span>${CATS[s.cat][0]}, ${ago(s.published)}</span></li>`;

function home(S) {
  const lead = S[0], side = S.slice(1, 5), trending = [...S].sort((a, b) => new Set(b.sources.map((x) => x.name)).size - new Set(a.sources.map((x) => x.name)).size || b.published - a.published).slice(0, 5);
  const secs = Object.keys(CATS).filter((k) => k !== "general").map((k) => [k, S.filter((s) => s.cat === k).slice(0, 3)]).filter((x) => x[1].length).slice(0, 5);
  const body = `<section class="hero"><div>${lead ? card(lead, true) : '<p class="empty">New stories will appear here after the next update.</p>'}</div><div class="latest"><h2>Latest</h2><ul class="list">${side.map(row).join("")}</ul><a class="more" href="/latest/">All latest stories</a></div></section>${ad(cfg.slots.home)}<div class="two"><div>${secs.map(([k, l], n) => `<section class="sec"><div class="sh"><h2>${CATS[k][0]}</h2><a href="/category/${k}/">View all</a></div><div class="grid">${l.map((s) => card(s)).join("")}</div>${n === 1 ? ad(cfg.slots.list) : ""}</section>`).join("")}</div><aside class="trend"><h2>Most reported</h2><ol>${trending.map((s) => `<li><a href="/story/${s.slug}/">${esc(s.headline)}</a><span>${CATS[s.cat][0]}</span></li>`).join("")}</ol></aside></div>`;
  return page({ title: "NAYORA | Cybersecurity news from around the world", desc: "Original explanations of the day's cybersecurity news, with links to every source. Plain English for beginners, technical notes for professionals.", path: "/", body });
}
function listPage(title, intro, path, S) {
  return page({ title, desc: intro, path, body: `<h1 class="ph">${esc(title)}</h1><p class="intro">${esc(intro)}</p>${S.length ? `<div class="grid g2">${S.slice(0, 60).map((s) => card(s)).join("")}</div>` : '<p class="empty">No stories yet in this category.</p>'}`, noindex: S.length < 3 });
}
const ul = (a) => `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
function storyPage(s, S) {
  const rel = S.filter((x) => x.cat === s.cat && x.id !== s.id).slice(0, 3), a = s.article;
  const ld = { "@context": "https://schema.org", "@type": "NewsArticle", headline: s.headline, datePublished: new Date(s.published).toISOString(), dateModified: new Date(s.updated).toISOString(), author: { "@type": "Organization", name: cfg.name }, publisher: { "@type": "Organization", name: cfg.name }, mainEntityOfPage: `${BASE}/story/${s.slug}/` };
  const body = `<article class="story"><nav class="crumb"><a href="/">Home</a> / <a href="/category/${s.cat}/">${CATS[s.cat][0]}</a></nav>${chip(s.cat)}<h1>${esc(s.headline)}</h1><div class="by">By NAYORA Desk. Published <time datetime="${new Date(s.published).toISOString()}">${fmt(s.published)}</time>, updated ${fmt(s.updated)}. Region: ${esc(s.region)}.</div><p class="lede">${esc(a.summary)}</p>${ad(cfg.slots.story1)}<h2>What happened</h2><p>${esc(a.what_happened)}</p><h2>Why it matters</h2><p>${esc(a.why_it_matters)}</p><h2>Who is affected</h2><p>${esc(a.who_is_affected)}</p><div class="box"><h2>In plain English</h2><p>${esc(a.plain_english)}</p><h3>What you can do</h3>${ul(a.what_to_do)}</div><h2>For security teams</h2>${ul(a.for_security_teams)}${(a.terms || []).length ? `<h2>Key terms</h2><dl>${a.terms.map((t) => `<dt>${esc(t.term)}</dt><dd>${esc(t.meaning)}</dd>`).join("")}</dl>` : ""}<h2>Original reporting</h2><p class="note">This article was written by NAYORA from the reports below. Read them for the full detail.</p><ul class="srcs">${s.sources.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener nofollow">${esc(x.name)}: ${esc(x.title)}</a></li>`).join("")}</ul><p class="note">Written with AI assistance from the sources above. See our <a href="/editorial-policy/">editorial policy</a>. Found a mistake? <a href="/contact/">Tell us</a>.</p>${ad(cfg.slots.story2)}</article>${rel.length ? `<section class="sec"><div class="sh"><h2>Related stories</h2></div><div class="grid">${rel.map((r) => card(r)).join("")}</div></section>` : ""}`;
  return page({ title: s.headline, desc: a.summary, path: `/story/${s.slug}/`, body, ld });
}
const legal = (title, path, html, desc) => page({ title, desc: desc || title, path, body: `<article class="story legal"><h1>${title}</h1>${html}</article>` });
const today = fmt(new Date());
const PAGES = () => [
  legal("About NAYORA", "/about/", `<p>NAYORA explains the world's cybersecurity news in plain language. Every day, attacks, breaches, software flaws and policy changes are reported by many outlets. We gather those reports, write our own explanation of each story, and link to every source so you can read the original.</p><p>Each story has a plain-English section for beginners and a section of defensive notes for security professionals. We do not publish unverified claims, and we say clearly when something has not been reported.</p><p>NAYORA is published by ${esc(cfg.owner)}. Contact us at <a href="mailto:${esc(cfg.email)}">${esc(cfg.email)}</a>.</p>`, "What NAYORA is, who runs it and how it covers cybersecurity news."),
  legal("Editorial policy", "/editorial-policy/", `<h2>How stories are made</h2><p>We monitor public cybersecurity news feeds and government advisories. When several outlets cover the same event, we group them into one story. Each story is written by NAYORA with the help of AI, using only the facts in the source reports. We do not copy source text, and we link to every source used.</p><h2>Accuracy and corrections</h2><p>We do not add names, numbers or vulnerability identifiers that the sources do not contain. If a source is removed or no longer available, we remove it from the story, and we remove the story if no sources remain. To report an error, email <a href="mailto:${esc(cfg.email)}">${esc(cfg.email)}</a>. We correct confirmed errors promptly.</p><h2>Advertising</h2><p>Ads are labelled and never affect what we cover. We do not accept payment to publish or change a story.</p>`, "How NAYORA collects, writes and corrects its stories."),
  legal("Contact us", "/contact/", `<p>Questions, corrections or takedown requests: <a href="mailto:${esc(cfg.email)}">${esc(cfg.email)}</a>.</p><p>We aim to reply within three working days. If you are a publisher and want a link to your article changed or removed, include the story address in your message.</p>`, "How to contact NAYORA."),
  legal("Privacy policy", "/privacy/", `<p>Last updated: ${today}.</p><h2>What we collect</h2><p>NAYORA does not require accounts and does not ask you for personal information. Our hosting provider keeps standard server logs, such as IP address, browser type and pages visited, to run and secure the site.</p><h2>Cookies and advertising</h2><p>We use Google AdSense to show ads. Third-party vendors, including Google, use cookies to serve ads based on a user's previous visits to this and other websites. Google's use of advertising cookies enables it and its partners to serve ads to you based on your visit to this site and other sites on the internet. You can opt out of personalised advertising in <a href="https://adssettings.google.com" rel="noopener">Google Ads Settings</a> or at <a href="https://www.aboutads.info" rel="noopener">aboutads.info</a>. See how Google uses data at <a href="https://policies.google.com/technologies/partner-sites" rel="noopener">policies.google.com/technologies/partner-sites</a>.</p><p>Visitors in the European Economic Area, the United Kingdom and Switzerland are asked for consent before personalised ads or non-essential cookies are used. You can change your choice at any time using "Privacy settings" in the footer.</p><h2>Children</h2><p>NAYORA is not directed at children under 13 and does not knowingly collect their data.</p><h2>External links</h2><p>Our stories link to other websites. We are not responsible for their privacy practices.</p><h2>Your rights</h2><p>Depending on where you live, you may have the right to access, correct or delete personal data we hold. Email <a href="mailto:${esc(cfg.email)}">${esc(cfg.email)}</a>.</p><h2>Changes</h2><p>We will update this page when our practices change and show the new date above.</p>`, "How NAYORA handles data, cookies and Google advertising."),
  legal("Terms of use", "/terms/", `<p>Last updated: ${today}.</p><p>By using NAYORA you agree to these terms. The site is provided for general information. You may read and share links to our pages. You may not copy our articles in bulk, scrape the site, or republish our content without permission.</p><p>Links to third-party sites are provided for convenience; we do not control and are not responsible for their content. We may change or remove content at any time. To the fullest extent allowed by law, ${esc(cfg.owner)} is not liable for losses arising from use of the site.</p>`, "The rules for using NAYORA."),
  legal("Disclaimer", "/disclaimer/", `<p>NAYORA provides general news and educational information about cybersecurity. It is not legal, technical or professional security advice. Stories are written with AI assistance from public reports and may contain errors or become out of date as events develop. Check the original sources and your own security team or vendor before acting. Product and company names belong to their owners, and mention does not imply endorsement.</p>`, "Limits of the information published on NAYORA."),
];
const CSS = `:root{--bg:#fff;--soft:#f3f5f8;--ink:#0e1b2c;--mu:#566579;--ln:#dde3ea;--ac:#c4155e;color-scheme:light;box-sizing:border-box}
@media (prefers-color-scheme:dark){:root{--bg:#0a111d;--soft:#101a2a;--ink:#e8eef7;--mu:#98a8bd;--ln:#1f2d44;--ac:#ff5c97;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.6 "Source Sans 3",system-ui,sans-serif;padding-bottom:env(safe-area-inset-bottom,0)}
a{color:inherit}:focus-visible{outline:2px solid var(--ac);outline-offset:2px}.w{max-width:1160px;margin:0 auto;padding:0 20px}
.top{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--ln);z-index:9;padding-top:env(safe-area-inset-top,0)}.bar{display:flex;align-items:center;gap:24px;height:58px}
.logo{font:800 26px "Bricolage Grotesque",sans-serif;text-decoration:none;letter-spacing:-.02em}.logo i{font-style:normal;color:var(--ac)}.logo.sm{font-size:22px}
.nav{display:flex;gap:18px;overflow-x:auto;white-space:nowrap;font-size:16px;font-weight:600;scrollbar-width:none}.nav a{text-decoration:none;color:var(--mu)}.nav a:hover{color:var(--ink)}
h1,h2,h3{font-family:"Bricolage Grotesque",sans-serif;line-height:1.15;letter-spacing:-.01em}
.hero{display:grid;grid-template-columns:2fr 1fr;gap:32px;padding:28px 0}.card{padding:0 0 18px;border-bottom:1px solid var(--ln)}.card h3{font-size:22px;margin:8px 0}.card.big h3{font-size:40px;font-weight:800}.card p{margin:0 0 6px;color:var(--mu);max-width:60ch}.card h3 a{text-decoration:none}.card h3 a:hover{text-decoration:underline}
.meta,.by{display:flex;gap:12px;align-items:center;font-size:14px;color:var(--mu)}.chip{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:600;text-decoration:none;color:var(--ink)}.chip i{width:9px;height:9px;border-radius:50%}
.latest h2,.trend h2{font-size:18px;margin:0 0 8px;padding-bottom:8px;border-bottom:3px solid var(--ink)}.list{list-style:none;padding:0;margin:0}.list li,.trend li{padding:12px 0;border-bottom:1px solid var(--ln)}.list a,.trend a{font:600 17px/1.3 "Bricolage Grotesque",sans-serif;text-decoration:none;display:block}.list span,.trend span{font-size:13px;color:var(--mu)}.more{font-weight:600;display:inline-block;margin-top:10px}
.two{display:grid;grid-template-columns:1fr 300px;gap:40px}.sh{display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid var(--ink);margin:30px 0 16px}.sh h2{margin:0 0 6px;font-size:22px}.sh a{font-weight:600;font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:22px}.g2{margin-top:20px}.trend ol{padding-left:22px;margin:0}.trend li::marker{font-weight:800;color:var(--ac)}
.ad{margin:26px 0;padding:8px 0;border-top:1px solid var(--ln);border-bottom:1px solid var(--ln);min-height:100px;overflow:hidden}.ad small{display:block;font-size:12px;color:var(--mu);margin-bottom:6px}
.story{max-width:720px;margin:28px auto}.story h1{font-size:42px;font-weight:800;margin:10px 0}.story h2{font-size:24px;margin:30px 0 8px}.story .by{margin-bottom:16px}.lede{font-size:21px;line-height:1.5}.crumb{font-size:14px;color:var(--mu);margin-bottom:10px}
.box{background:var(--soft);border-left:4px solid var(--ac);padding:4px 20px 12px;margin:26px 0}.box h2{margin-top:16px}.box h3{font-size:17px;margin:14px 0 4px}.note{font-size:15px;color:var(--mu)}.srcs li{margin:6px 0}dt{font-weight:600;margin-top:8px}dd{margin:0;color:var(--mu)}
.ph{font-size:40px;margin:28px 0 4px}.intro{color:var(--mu);max-width:60ch}.empty{color:var(--mu);padding:40px 0}
.foot{background:var(--soft);margin-top:60px;padding:36px 0 20px;font-size:16px}.cols{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:30px}.cols a{display:block;margin:5px 0;color:var(--mu);text-decoration:none}.cols a:hover{color:var(--ink)}.cols p{color:var(--mu);margin:8px 0}.copy{margin-top:24px;color:var(--mu);font-size:14px}
@media (max-width:860px){.hero,.two{grid-template-columns:1fr}.cols{grid-template-columns:1fr 1fr}.card.big h3,.story h1{font-size:30px}.bar{gap:14px}}`;

// ---------- mock data (tests only) ----------
function mockItems() {
  const d = (h) => new Date(Date.now() - h * 36e5);
  return [
    { src: "The Hacker News", title: "Critical SonicWall SMA 1000 flaw CVE-2026-102255 targeted after patch", link: "https://example.org/a", date: d(5), desc: "Attackers made 135 attempts." }, { src: "BleepingComputer", title: "SonicWall SMA 1000 vulnerability CVE-2026-102255 under attack", link: "https://example.org/b", date: d(3), desc: "Exploitation reported." },
    { src: "The Record", title: "Ransomware gang takes over hospital Facebook page", link: "https://example.org/c", date: d(8), desc: "A hospital system attack." }, { src: "Krebs on Security", title: "Hackers steal customer data from retailer", link: "https://example.org/d", date: d(30), desc: "Data stolen." }, { src: "SecurityWeek", title: "New phishing campaign targets bank customers", link: "https://example.org/e", date: d(50), desc: "Phishing scam." },
  ];
}
const mockGen = (c) => ({ headline: c.items[0].title.slice(0, 85), summary: "Test summary sentence one. Test summary sentence two.", what_happened: Array(160).fill("word").join(" "), why_it_matters: Array(90).fill("word").join(" "), who_is_affected: Array(50).fill("word").join(" "), plain_english: "Plain test.", what_to_do: ["Update software.", "Use MFA.", "Back up files."], for_security_teams: ["Check logs.", "Review exposure.", "Patch quickly."], terms: [{ term: "Test", meaning: "A test." }] });

// ---------- build ----------
const db = existsSync(DB) ? JSON.parse(await readFile(DB, "utf8")) : { stories: {} };
const cutoff = Date.now() - cfg.keepDays * 864e5;
let items = (await collect()).filter((i) => i.title && /^https?:\/\//.test(i.link) && !isNaN(i.date) && i.date > cutoff);
items = [...new Map(items.map((i) => [i.link, i])).values()].map(classify).sort((a, b) => a.date - b.date);
const byLink = new Map(); for (const s of Object.values(db.stories)) for (const x of s.sources) byLink.set(x.url, s);
const fresh = [];
for (const c of cluster(items)) {
  const known = c.items.map((i) => byLink.get(i.link)).find(Boolean);
  const add = (s, i) => { if (!s.sources.some((x) => x.url === i.link)) s.sources.push({ name: i.src, url: i.link, title: i.title, date: i.date, checked: 0 }); s.updated = Math.max(+new Date(s.updated), +i.date); };
  if (known) c.items.forEach((i) => add(known, i)); else fresh.push(c);
}
let made = 0;
for (const c of fresh.sort((a, b) => b.items[0].date - a.items[0].date)) {
  if (made >= MAXNEW) break;
  const art = await generate(c); made++;
  if (!goodArticle(art)) { console.warn("Skipped (analysis not good enough):", c.items[0].title); continue; }
  const f = c.items[0], id = hid(f.link);
  db.stories[id] = { id, slug: `${slug(art.headline)}-${id}`, cat: f.cat, region: f.region, headline: art.headline, summary: art.summary, article: art, published: f.date, updated: Math.max(...c.items.map((i) => +i.date)), sources: c.items.map((i) => ({ name: i.src, url: i.link, title: i.title, date: i.date, checked: 0 })) };
}
for (const s of Object.values(db.stories)) {
  for (const x of s.sources) if (Date.now() - x.checked > 6 * 36e5) { x.dead = !(await alive(x.url)); x.checked = Date.now(); }
  s.sources = s.sources.filter((x) => !x.dead);
  if (!s.sources.length || new Date(s.published) < cutoff) delete db.stories[s.id];
}
await mkdir("data", { recursive: true }); await writeFile(DB, JSON.stringify(db));
const S = Object.values(db.stories).sort((a, b) => new Date(b.published) - new Date(a.published));

await rm(OUT, { recursive: true, force: true });
const put = async (p, c) => { const f = `${OUT}${p}`; await mkdir(f.replace(/[^/]*$/, ""), { recursive: true }); await writeFile(f, c); };
await put("/style.css", CSS);
await put("/index.html", home(S));
await put("/latest/index.html", listPage("Latest cybersecurity news", "Every recent story, newest first.", "/latest/", S));
const urls = ["/", "/latest/"];
for (const k of Object.keys(CATS).filter((k) => k !== "general")) { const l = S.filter((s) => s.cat === k); await put(`/category/${k}/index.html`, listPage(CATS[k][0], CATS[k][3], `/category/${k}/`, l)); if (l.length >= 3) urls.push(`/category/${k}/`); }
for (const s of S) { await put(`/story/${s.slug}/index.html`, storyPage(s, S)); urls.push(`/story/${s.slug}/`); }
for (const p of PAGES()) { const path = p.match(/rel="canonical" href="[^"]*?(\/[^"/]*\/)"/)[1]; await put(`${path}index.html`, p); urls.push(path); }
await put("/404.html", page({ title: "Page not found", desc: "This page could not be found.", path: "/404.html", noindex: true, body: `<div class="story"><h1>Page not found</h1><p>The story may have been removed by its publisher. Try the <a href="/latest/">latest stories</a>.</p></div>` }));
await put("/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${BASE}${u}</loc></url>`).join("")}</urlset>`);
await put("/robots.txt", TEST ? "User-agent: *\nDisallow: /\n" : `User-agent: *\nAllow: /\nSitemap: ${BASE}/sitemap.xml\n`);
if (adsOn) await put("/ads.txt", `google.com, ${cfg.adsenseClient.replace(/^ca-/, "")}, DIRECT, f08c47fec0942fa0\n`);
console.log(`Built ${S.length} stories, ${urls.length} pages, ads ${adsOn ? "on" : "off"}.`);
