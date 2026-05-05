// Bot detection for the /go/ click logger.
//
// Called per click; returns whether the request looks non-human and the
// pattern that matched (for debugging / category rollups). Patterns are
// matched as case-insensitive substrings against the User-Agent header.
// First match wins, so order matters: we list link previewers first
// because they're the highest-volume non-human source for a /go/ link
// shared in chat.
//
// Empty / null / whitespace-only UA → flagged as bot with signature
// 'empty-ua'. Real browsers always send something; an absent UA is
// either a misconfigured client or a poorly-written scraper.

const BOT_PATTERNS: ReadonlyArray<string> = [
  // Link previewers (chat / social unfurl)
  "slackbot",
  "twitterbot",
  "facebookexternalhit",
  "linkedinbot",
  "discordbot",
  "whatsapp",
  "telegrambot",
  "skypeuripreview",
  "pinterest",

  // Search crawlers
  "googlebot",
  "bingbot",
  "duckduckbot",
  "baiduspider",
  "yandexbot",
  "applebot",

  // Programmatic clients (slashes deliberate — avoid matching unrelated
  // substrings; a real UA wouldn't contain 'curl/' as a fragment)
  "curl/",
  "wget/",
  "python-requests/",
  "go-http-client/",
  "axios/",
  "node-fetch",

  // Headless browsers
  "headlesschrome",
  "phantomjs",
  "puppeteer",
  "playwright",

  // SEO crawlers (lower priority — high volume, low value, but still
  // worth tagging so they don't pollute human counts)
  "ahrefsbot",
  "semrushbot",
  "mj12bot",
  "dotbot",
];

export function detectBot(
  userAgent: string | null,
): { isBot: boolean; signature: string | null } {
  if (!userAgent || userAgent.trim().length === 0) {
    return { isBot: true, signature: "empty-ua" };
  }

  const ua = userAgent.toLowerCase();
  for (const pattern of BOT_PATTERNS) {
    if (ua.includes(pattern)) {
      return { isBot: true, signature: pattern };
    }
  }
  return { isBot: false, signature: null };
}

// ---------------------------------------------------------------------
// Inline reference (no test runner — manual smoke check during review)
// ---------------------------------------------------------------------
//
// detectBot('Slackbot 1.0 (+https://api.slack.com/robots)')
//   -> { isBot: true,  signature: 'slackbot' }
//
// detectBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
//           'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
//   -> { isBot: false, signature: null }   // iPhone Safari — note 'apple' alone wouldn't match; 'applebot' would
//
// detectBot('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; ' +
//           'compatible; Googlebot/2.1; +http://www.google.com/bot.html)')
//   -> { isBot: true,  signature: 'googlebot' }
//
// detectBot('curl/8.4.0')
//   -> { isBot: true,  signature: 'curl/' }
//
// detectBot('Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 ' +
//           '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36')
//   -> { isBot: false, signature: null }   // Android Chrome
//
// detectBot('')             -> { isBot: true, signature: 'empty-ua' }
// detectBot(null)           -> { isBot: true, signature: 'empty-ua' }
// detectBot('   ')          -> { isBot: true, signature: 'empty-ua' }
//
// detectBot('WhatsApp/2.23.20.0 A')
//   -> { isBot: true,  signature: 'whatsapp' }
//
// detectBot('HeadlessChrome/120.0.6099.71')
//   -> { isBot: true,  signature: 'headlesschrome' }
