// Guard for generated market commentary: the recap and snapshot must stay descriptive and must
// never tell the user what to trade. Generated text is checked against these patterns before it
// is stored; anything that matches is replaced with a neutral placeholder and logged.

const DIRECTIONAL_PATTERNS: RegExp[] = [
  /\b(buy|buying|sell|selling)\b/i,
  /\bgo (long|short)\b/i,
  /\b(bullish|bearish)\b/i,
  /\brecommend(s|ed|ation)?\b/i,
  /\byou should\b/i,
  /\b(should|must) (buy|sell|enter|exit|close|add|cut|trim)\b/i,
  /\b(take|book) (profits?|losses?)\b/i,
  /\b(upside|downside) (target|potential)\b/i,
  /\b(likely|expected) to (rise|fall|rally|drop|climb|decline)\b/i,
];

export function findDirectionalLanguage(text: string): string[] {
  return DIRECTIONAL_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

export function assertNeutral(text: string): string {
  const hits = findDirectionalLanguage(text);
  if (hits.length) {
    return '[Commentary withheld: generated text contained directional or recommendation language.]';
  }
  return text;
}
