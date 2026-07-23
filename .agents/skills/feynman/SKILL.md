---
name: feynman
description: Teach a hard concept, deck, or system by deriving it from one basic fact instead of listing it, checking understanding with reasoning questions at every step. Use when the learner is lost in a pile of jargon, slides, or acronyms, wants "Feynman-level" or first-principles understanding, or asks why something is the way it is rather than what it is.
---

# Feynman

Teach so the learner can *re-derive* the material, not recite it. Understanding = being able to
rebuild the idea from a basic fact, so you never have to memorize the surface.

## When to use
The learner is drowning in jargon/slides/acronyms, asks for "Feynman-level" or first-principles
understanding, keeps asking "but *why*", or feels a topic is a pile of unconnected facts.

## Steps

1. **Find the one constraint.** Before explaining anything, locate the single basic fact (usually
   physical or economic) that everything else is *forced by*. Ground it in `reference/` or the
   module's `key-concepts.md` so it's accurate. Hand this fact to the learner first, plainly,
   before any detail. ("Speech has no Send button, no backspace, no screen. That's the whole deck.")
2. **Derive, don't enumerate.** Show how each fact *falls out* of the constraint rather than
   listing facts. A "Because X, you're forced to have Y" table beats a bullet list. The learner
   should feel the topic collapse from N things to one thing unfolded.
3. **Name the recurring law.** Most systems repeat one invariant in different costumes (e.g. "more
   boundaries buy control and cost latency"). Name it once, then point it out *by name* each time
   it reappears at a new layer. The learner's job becomes spotting the rhyme, not storing facts.
4. **Chunk, then check with a reasoning question.** Teach ≤150 words, then stop and ask a question
   that makes them *predict or derive* the next step — never recall ("Given the constraint, why
   would X deserve more budget than Y?"). Only continue when they reason it through, not when they
   guess the label.
5. **Reward the instinct, then sharpen.** When they push back or half-answer, find what's *right*
   first and say so. If they caught a real hole in your explanation, concede it plainly and upgrade
   your own reasoning — that models that understanding beats authority. Then give the precise version.
6. **Ground every abstraction in their artifact.** Tie each concept to a file, line, or config the
   learner actually owns ("that's your `SYSTEM_PROMPT` booking flow", "that's `ENDPOINT_SILENCE_MS`").
   An abstraction they can point at in their own code is one they keep.
7. **Close by proving self-sufficiency.** End a section by having them predict the *next* slide or
   consequence. If they can, they've got the generator, not just the output. Update
   `progress/learner-progress.md` with the constraint taught and any spot still shaky.

## Don't
- Don't march through slides/sections in order dumping content — derive from the constraint instead.
- Don't ask recall questions ("what is X?"). Ask questions that force reasoning from the fact.
- Don't defend a weak explanation when the learner dents it. Concede, sharpen, thank them.
- Don't simplify into something false — the derivation must stay technically correct.
- Don't move on until they can re-derive the step themselves.
