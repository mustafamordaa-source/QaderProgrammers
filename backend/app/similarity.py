"""How alike two tasks, or two area names, are. Pure Python, no outside service.

Scores run from 0 to 100:

- Title: the larger of word overlap (TF-IDF cosine) and letter-trigram overlap
  (Dice), so "CSV export" and "Export as CSV" match, and so do small typos.
- Body: word overlap over title, description and acceptance criteria. Words
  that most tasks share (template headings, "the", "add") weigh little, because
  IDF comes from the whole set of tasks being compared.
- Arabic is normalized (diacritics and tatweel removed, alef, teh marbuta and
  alef maqsura unified) so spelling variants count as the same word.

The bands the routes use: DUPLICATE (90+) refuses a new task without a reason,
RELATED (75+) links it and warns.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

DUPLICATE = 90
RELATED = 75

_DIACRITICS = re.compile(r"[ً-ْٰـ]")
_ARABIC_MAP = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا",
                             "ة": "ه", "ى": "ي"})
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)
_STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "be",
    "it", "this", "that", "as", "at", "by", "from", "when", "should", "not", "no", "we",
    "can", "will", "do", "does", "if", "so", "but", "into", "its", "their", "has", "have",
    "في", "من", "على", "الى", "إلى", "عن", "مع", "هذا", "هذه", "ان", "أن", "او", "أو", "و",
    "ما", "لا", "هو", "هي", "كل", "عند", "التي", "الذي",
}


def normalize(text: str | None) -> str:
    text = (text or "").lower()
    text = _DIACRITICS.sub("", text).translate(_ARABIC_MAP)
    return _NON_WORD.sub(" ", text).replace("_", " ").strip()


def _stem(word: str) -> str:
    # Light English plural/verb trimming; Arabic words stay as they are.
    if word.isascii() and len(word) > 4:
        for suffix in ("ing", "ed", "es", "s"):
            if word.endswith(suffix) and len(word) - len(suffix) >= 3:
                return word[: -len(suffix)]
    return word


def tokens(text: str | None) -> list[str]:
    return [_stem(w) for w in normalize(text).split() if len(w) > 1 and w not in _STOP]


def trigrams(text: str | None) -> set[str]:
    s = f"  {normalize(text)} "
    return {s[i:i + 3] for i in range(len(s) - 2)} if len(s.strip()) else set()


def dice(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


def _cosine(a: Counter, b: Counter, idf: dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(a[t] * b[t] * idf.get(t, 1.0) ** 2 for t in a.keys() & b.keys())
    na = math.sqrt(sum((c * idf.get(t, 1.0)) ** 2 for t, c in a.items()))
    nb = math.sqrt(sum((c * idf.get(t, 1.0)) ** 2 for t, c in b.items()))
    return dot / (na * nb) if na and nb else 0.0


@dataclass
class Doc:
    key: int
    title: str
    body: str  # description and criteria, without the title

    def __post_init__(self):
        self.title_tokens = Counter(tokens(self.title))
        self.all_tokens = self.title_tokens + Counter(tokens(self.body))
        self.title_grams = trigrams(self.title)


def _idf(docs: list[Doc]) -> dict[str, float]:
    df: Counter = Counter()
    for d in docs:
        df.update(set(d.all_tokens))
    n = len(docs)
    return {t: math.log((n + 1) / (c + 1)) + 1 for t, c in df.items()}


def score_pair(query: Doc, other: Doc, idf: dict[str, float]) -> int:
    title = max(_cosine(query.title_tokens, other.title_tokens, idf),
                dice(query.title_grams, other.title_grams))
    if not query.body.strip() or not other.body.strip():
        return round(100 * title)
    body = _cosine(query.all_tokens, other.all_tokens, idf)
    combined = 0.6 * title + 0.4 * body
    if sum(query.all_tokens.values()) >= 15:
        # A long, near-identical description is a duplicate whatever the title says.
        combined = max(combined, 0.95 * body)
    return round(100 * min(combined, 1.0))


def rank(query: Doc, candidates: list[Doc]) -> list[tuple[int, int]]:
    """(key, score) for every candidate, best first."""
    if not candidates:
        return []
    idf = _idf(candidates + [query])
    scored = [(c.key, score_pair(query, c, idf)) for c in candidates]
    return sorted(scored, key=lambda kv: -kv[1])


def name_score(a: str, b: str) -> int:
    """How alike two short names are (area names, aliases)."""
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0
    if na == nb or _stem(na) == _stem(nb):
        return 100
    words_a, words_b = set(map(_stem, na.split())), set(map(_stem, nb.split()))
    overlap = len(words_a & words_b) / max(len(words_a | words_b), 1)
    return round(100 * max(dice(trigrams(na), trigrams(nb)), overlap))
