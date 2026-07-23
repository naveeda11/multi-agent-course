---
name: teach-module
description: Run an interactive lesson for one course module. Use when the learner asks to learn, start, study, or be taught a module or topic, or to continue where they left off. Walks through the module's lesson.md one concept at a time with comprehension checks.
---

# Teach a Module

## When to use
The learner wants to learn a module or topic ("teach me module 2", "let's start", "continue").

## Steps

1. **Locate the module.** Find the folder in `modules/` (e.g. `modules/02-name/`). If the
   learner didn't specify, check `progress/learner-progress.md` for the next module.
2. **Load the content.** Read `lesson.md` and `key-concepts.md` for that module.
3. **Honor their style** (from the progress file): Socratic, lecture+checkpoints, or build-along.
4. **Teach one concept at a time:**
   - Present a single idea (≤150 words).
   - Pause with a question or quick check ("In your words, why does X matter?").
   - Only continue when they show they followed.
5. **Use analogies and examples** from the lesson; invent more if they're stuck.
6. **Offer the exercise** (`exercises.md`) once the core concepts land.
7. **Wrap up:** summarize the 2–3 key takeaways, then update
   `progress/learner-progress.md` (module, status, anything shaky, next step).

## Don't
- Don't read the whole lesson aloud in one block.
- Don't move past a concept the learner hasn't grasped.
- Don't skip the progress update.
