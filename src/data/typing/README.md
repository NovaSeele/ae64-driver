# Typing test texts

The four lists used by the typing test page (`/typing`, DESIGN TT §6):

- `en-words.txt`: everyday English words, one per line;
- `vi-words.txt`: Vietnamese words of one to three syllables, one per line;
- `en-sentences.txt`, `vi-sentences.txt`: one sentence per line.

Origin: written for this app by "Ae64 design" on 2026-11-20. They are not copied from any word list, typing site or other
source; the English words are a hand-picked set of everyday words. They ship under this repository's MIT licence.

Format (checked by `tests/typing-data.test.ts`): UTF-8 without BOM, LF, NFC, one entry per line, one final newline, no
empty line, no duplicate, no digit. English is ASCII only; every Vietnamese syllable is a valid Vietnamese spelling.
