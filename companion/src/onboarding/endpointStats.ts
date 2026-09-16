import { readText } from "../util/fs.js";
import { globFiles } from "../util/glob.js";

/**
 * Mechanical endpoint statistics for readOnlyPatterns: pull `Segment/Segment` string literals out of
 * the service/adapter layer, take the trailing PascalCase token of the last segment and count it.
 * Classification lists are only hints — Agent dev decides, but every verb must get a decision.
 */

export interface VerbStat {
  verb: string;
  count: number;
  examples: string[];
}

export interface EndpointStats {
  glob: string;
  min: number;
  files: number;
  endpoints: number;
  distinct: number;
  verbs: VerbStat[];
  suggestedReadVerbs: string[];
  suggestedWriteVerbs: string[];
  unclassified: string[];
  proposedPattern: string | null;
}

const READ_VERBS = /^(Search|Detail|Details|List|Query|Get|Find|Load|Fetch|Report|Statistic|Statistics|Dashboard|Summary|Overview|Total|Count|Exist|Exists|Read|Page|Pages|All|Check|Valid|Validate|Visible|Export|Download|Option|Options|Lookup|Info|View|Preview|History|Status)$/i;
const WRITE_VERBS = /^(Create|Add|Insert|Update|Edit|Save|Delete|Remove|Submit|Approve|Reject|Cancel|Complete|Finish|Close|Import|Upload|Print|Send|Switch|Transfer|Sync|Synchronize|Release|Invalid|Confirm|Assign|Reset|Login|Logout|Signin|Signout|Register|Publish|Archive|Restore|Move|Copy|Generate)$/i;

const LITERAL_RE = /["'`]([A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)+)["'`]/g;

const PREPOSITIONS = new Set(["By", "From", "For", "With", "To", "In", "Of", "Via"]);
const TOKEN_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z0-9]*|[A-Z]+|[a-z0-9]+/g;

/**
 * The verb of an endpoint's last segment:
 *  - split PascalCase into tokens, keeping acronyms whole ("UploadHtmlPDF" → Upload, Html, PDF);
 *  - drop trailing acronyms / single letters ("…CreateFD" → Create, "…UpdateIP" → Update);
 *  - cut at a preposition so qualifiers do not hide the verb ("UpdateByOtherID" → Update,
 *    "CreateFromExcel" → Create, "ListByUserFD" → List);
 *  - an all-lowercase segment ("auth/login") is used whole, capitalised for display.
 */
export function trailingVerb(endpoint: string): string {
  const last = endpoint.split("/").pop() ?? endpoint;
  const tokens = last.match(TOKEN_RE) ?? [last];
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  if (tokens.length === 1) return cap(tokens[0]);
  while (tokens.length > 1) {
    const t = tokens[tokens.length - 1];
    if (/^[A-Z0-9]+$/.test(t) && t.length <= 4) tokens.pop();
    else break;
  }
  const prep = tokens.findIndex((t, i) => i > 0 && PREPOSITIONS.has(t));
  const seq = prep > 0 ? tokens.slice(0, prep) : tokens;
  const tail = seq[seq.length - 1];
  if (READ_VERBS.test(tail) || WRITE_VERBS.test(tail)) return cap(tail);
  // The last token is a qualifier ("SearchAllDealer", "UploadHtmlPDF", "UpdateOne"): fall back to the
  // first known verb in the name (scanning forward, so "Search" beats the "All" qualifier after it).
  for (let i = 0; i < seq.length - 1; i++) {
    if (READ_VERBS.test(seq[i]) || WRITE_VERBS.test(seq[i])) return cap(seq[i]);
  }
  return cap(tail);
}

export function collectEndpointStats(projectDir: string, glob: string, min = 2): EndpointStats {
  const files = globFiles(projectDir, glob);
  const counts = new Map<string, { count: number; examples: Set<string> }>();
  const seen = new Set<string>();
  let endpoints = 0;
  for (const file of files) {
    let text: string;
    try { text = readText(file); } catch { continue; }
    for (const m of text.matchAll(LITERAL_RE)) {
      const ep = m[1];
      if (/^(http|https|www)$/i.test(ep.split("/")[0])) continue;
      endpoints++;
      seen.add(ep);
      const verb = trailingVerb(ep);
      const entry = counts.get(verb) ?? { count: 0, examples: new Set<string>() };
      entry.count++;
      if (entry.examples.size < 3) entry.examples.add(ep);
      counts.set(verb, entry);
    }
  }
  const verbs: VerbStat[] = [...counts.entries()]
    .map(([verb, e]) => ({ verb, count: e.count, examples: [...e.examples] }))
    .sort((a, b) => b.count - a.count || a.verb.localeCompare(b.verb));
  const frequent = verbs.filter((v) => v.count >= min);
  const suggestedReadVerbs = frequent.filter((v) => READ_VERBS.test(v.verb)).map((v) => v.verb);
  const suggestedWriteVerbs = frequent.filter((v) => WRITE_VERBS.test(v.verb)).map((v) => v.verb);
  const unclassified = frequent.filter((v) => !READ_VERBS.test(v.verb) && !WRITE_VERBS.test(v.verb)).map((v) => v.verb);
  return {
    glob,
    min,
    files: files.length,
    endpoints,
    distinct: seen.size,
    verbs,
    suggestedReadVerbs,
    suggestedWriteVerbs,
    unclassified,
    proposedPattern: suggestedReadVerbs.length ? `(${suggestedReadVerbs.join("|")})$` : null,
  };
}

/** Frequent verbs (count >= min) that no pattern matches and that are not obviously writes. */
export function uncoveredVerbs(stats: EndpointStats, patterns: string[]): VerbStat[] {
  const regs = patterns.map((p) => new RegExp(p, "i"));
  return stats.verbs.filter((v) => v.count >= stats.min && !WRITE_VERBS.test(v.verb) && !v.examples.some((ep) => regs.some((re) => re.test(ep))));
}
