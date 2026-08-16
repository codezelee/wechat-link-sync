const PUBLISHED_META_KEYS = [
  "article:published_time",
  "og:article:published_time",
  "date",
  "pubdate",
  "publishdate",
  "datePublished"
];

const SCRIPT_DATE_KEYS = [
  "publish_time",
  "publishTime",
  "published_at",
  "publishedAt",
  "create_time",
  "createTime"
];

export function extractPublishedAt(document: Document): string | null {
  const direct = firstText(
    text(document.querySelector("#publish_time")),
    attribute(document.querySelector("time[itemprop='datePublished'][datetime], time[datetime]"), "datetime"),
    ...PUBLISHED_META_KEYS.map((key) => meta(document, key)),
    attribute(document.querySelector("[itemprop='datePublished'][content]"), "content")
  );
  if (direct) return normalizePublishedAt(direct);

  const scripts = [...document.querySelectorAll("script")]
    .map((script) => script.textContent ?? "")
    .filter(Boolean);
  for (const key of SCRIPT_DATE_KEYS) {
    const value = scriptValue(scripts, key);
    if (value) return normalizePublishedAt(value);
  }

  // WeChat commonly exposes the publish timestamp as `var ct = "..."`.
  const wechatTimestamp = scripts.map((script) => {
    const match = /(?:^|[;\s])(?:var\s+)?ct\s*=\s*(?:"([^"]+)"|'([^']+)'|(\d{10,13}))/m.exec(script);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  }).find(Boolean);
  return wechatTimestamp ? normalizePublishedAt(wechatTimestamp) : null;
}

function scriptValue(scripts: string[], key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:["']?${escaped}["']?)\\s*[:=]\\s*(?:"([^"]+)"|'([^']+)'|(\\d{10,13}))`, "m");
  for (const script of scripts) {
    const match = pattern.exec(script);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (value) return value;
  }
  return null;
}

function normalizePublishedAt(value: string): string | null {
  const cleaned = value.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (/^\d{10}$/.test(cleaned)) return timestamp(Number(cleaned) * 1000) ?? cleaned;
  if (/^\d{13}$/.test(cleaned)) return timestamp(Number(cleaned)) ?? cleaned;
  return cleaned;
}

/**
 * The note keeps the publisher's original date text, but the server completion
 * endpoint accepts an ISO timestamp only. Chinese publishers commonly expose
 * local wall-clock strings, so interpret those explicitly as China Standard
 * Time instead of depending on the desktop's timezone and Date parser.
 */
export function normalizePublishedAtForApi(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (/^\d{10}$/.test(cleaned)) return timestamp(Number(cleaned) * 1000);
  if (/^\d{13}$/.test(cleaned)) return timestamp(Number(cleaned));

  const chinese = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})(?::|时)(\d{1,2})?(?::|分)?(\d{1,2})?秒?)?$/.exec(cleaned);
  if (chinese) {
    return chinaTimeToIso(chinese[1]!, chinese[2]!, chinese[3]!, chinese[4], chinese[5], chinese[6]);
  }

  const local = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d{1,3})?)?)?$/.exec(cleaned);
  if (local) {
    return chinaTimeToIso(local[1]!, local[2]!, local[3]!, local[4], local[5], local[6]);
  }

  const date = new Date(cleaned);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function chinaTimeToIso(
  year: string,
  month: string,
  day: string,
  hour = "0",
  minute = "0",
  second = "0"
): string | null {
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  const numericSecond = Number(second);
  if (
    numericMonth < 1 || numericMonth > 12
    || numericDay < 1 || numericDay > new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate()
    || numericHour < 0 || numericHour > 23
    || numericMinute < 0 || numericMinute > 59
    || numericSecond < 0 || numericSecond > 59
  ) return null;
  const milliseconds = Date.UTC(
    numericYear,
    numericMonth - 1,
    numericDay,
    numericHour - 8,
    numericMinute,
    numericSecond
  );
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestamp(milliseconds: number): string | null {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function meta(document: Document, key: string): string | null {
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, "\\$&");
  return document.querySelector<HTMLMetaElement>(`meta[property="${escaped}"], meta[name="${escaped}"]`)?.content ?? null;
}

function attribute(element: Element | null, name: string): string | null {
  return element?.getAttribute(name) ?? null;
}

function text(element: Element | null): string | null { return element?.textContent ?? null; }

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const cleaned = value?.replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned;
  }
  return null;
}
