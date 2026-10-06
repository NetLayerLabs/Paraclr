#!/usr/bin/env python3
"""X character counter for the drafts in docs/x/.

    python3 docs/x/count.py           # report every post / bio
    python3 docs/x/count.py --write   # also rewrite the "(N chars...)" markers in headings

A post is a fenced ``` block. Its count goes into the nearest heading (or **bold label** line) above it.
Bios are list items written as  `1. (N chars) `text``.

Counting follows X's weighted length:
  * code points in U+0000-U+10FF, U+2000-U+200D, U+2010-U+201F and U+2032-U+2037 count 1
  * everything else (emoji, CJK, ...) counts 2
  * every URL counts 23, and so does a [LINK: ...] placeholder

"Filled" is the worst-case length once the placeholders are replaced, using the sizes in FILL.
It can be shorter than the drafted length, since a long placeholder may stand in for a short number.
Limits: posts 280, bios 160.
"""
import re
import sys
import unicodedata
from pathlib import Path

POST_LIMIT, BIO_LIMIT = 280, 160

# Worst-case stand-ins for placeholders, used for the "filled" length.
FILL = {
    "[ACCTS]": "1,000",
    "[SCANNED]": "1,000",
    "[TXS]": "24",
    "[BLOCK]": "99,999,999",
    "[NBLOCKS]": "12",
    "[MS]": "99,999",
    "[GAS]": "999,999,999",
    # auction runs (RunReport v2) and the Conflict X-ray
    "[STARTED]": "1,000",
    "[BACKSTOP]": "1,000",
    "[CURED]": "1,000",
    "[P50]": "99",
    "[MAXB]": "99",
    "[MAXMS]": "99,999",
    "[RETURNED]": "9,999,999",
    "[LEGACY]": "9,999,999",
    "[E_LANES]": "9,999",
    "[E_NAIVE]": "9,999",
    "[XTXS]": "999",
    "[METHOD]": "local anvil-fork replay",
}
LINK_RE = re.compile(r"\[LINK:[^\]]*\]")
HANDLE_RE = re.compile(r"\[HANDLE:[^\]]*\]")
URL_RE = re.compile(r"https?://\S+")


def weight(text: str) -> int:
    n = 0
    for ch in unicodedata.normalize("NFC", text):
        cp = ord(ch)
        if cp <= 0x10FF or 0x2000 <= cp <= 0x200D or 0x2010 <= cp <= 0x201F or 0x2032 <= cp <= 0x2037:
            n += 1
        else:
            n += 2
    return n


def x_len(text: str, filled: bool) -> int:
    text = LINK_RE.sub("x" * 23, text)
    text = URL_RE.sub("x" * 23, text)
    if filled:
        text = HANDLE_RE.sub("x" * 16, text)  # @ + 15-char handle max
        for k, v in FILL.items():
            text = text.replace(k, v)
    return weight(text)


def marker(raw: int, full: int) -> str:
    return f"({raw} chars)" if raw == full else f"({raw} chars; {full} when filled)"


MARK_RE = re.compile(r"\s*\(\d+ chars(?:; (?:up to )?\d+ (?:when )?filled)?\)")
BIO_RE = re.compile(r"^(\d+\. )\(\d+ chars\) `(.+)`$")


def process(path: Path, write: bool) -> list[str]:
    lines = path.read_text().split("\n")
    problems, out, i, last_heading = [], [], 0, None
    print(f"\n== {path.name}")
    while i < len(lines):
        line = lines[i]
        m = BIO_RE.match(line)
        if m:
            n = x_len(m.group(2), filled=False)
            flag = "" if n <= BIO_LIMIT else "  <-- OVER 160"
            print(f"  bio {m.group(1).strip():4} {n:4}{flag}")
            if flag:
                problems.append(f"{path.name}: bio {m.group(1).strip()} is {n}")
            out.append(f"{m.group(1)}({n} chars) `{m.group(2)}`")
            i += 1
            continue
        if line.startswith("#") or line.startswith("**"):  # headings and bold labels title a post
            last_heading = len(out)
        if line.startswith("```"):
            j = i + 1
            while not lines[j].startswith("```"):
                j += 1
            body = "\n".join(lines[i + 1 : j])
            raw, full = x_len(body, False), x_len(body, True)
            title = MARK_RE.sub("", out[last_heading]).strip() if last_heading is not None else "?"
            flag = "" if max(raw, full) <= POST_LIMIT else "  <-- OVER 280"
            print(f"  {raw:4} / {full:4} filled  {title}{flag}")
            if flag:
                problems.append(f"{path.name}: {title} is {max(raw, full)}")
            if last_heading is not None:
                out[last_heading] = f"{title} {marker(raw, full)}"
            out.extend(lines[i : j + 1])
            i = j + 1
            continue
        out.append(line)
        i += 1
    if write:
        path.write_text("\n".join(out))
    return problems


def main() -> None:
    write = "--write" in sys.argv
    here = Path(__file__).parent
    problems = []
    for p in sorted(here.glob("*.md")):
        problems += process(p, write)
    print("\nALL OK" if not problems else "\nPROBLEMS:\n  " + "\n  ".join(problems))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
