---
date: 2026-10-09
pr: pending
feature: Hermes clarify callback compatibility
impact: Keep Studio clarification working with both legacy Hermes kernels and the new normalized-question contract.
---

Upstream commit `5eea87882aebdeded8204b083b36acb17f7247f8` (2026-09-29,
NousResearch/hermes-agent#127760) replaced the platform callback with
`callback(normalized_questions) -> {answers, outcome, notice?}` and removed
`_accepts_kwarg` / `_invoke_callback`. Git ancestry confirms that the v0.21.5
release tag `v2026.9.24` does not contain it, while `v0.21.6`
(`818c13be1dc4fd28987e1e881a9408224afd4535`) and current main do.
Development version strings based on an older tag are therefore insufficient
to decide which contract a kernel uses.

Studio's bridge previously accepted only `callback(question, choices) -> str`.
With the new kernel it displayed the normalized array as text and returned a
string where the tool expects an answers/outcome dictionary. The original
method reproduces a "Failed to get user input" result on current upstream.

The bridge now identifies the contract from the call itself:

- Two positional arguments still return the user's raw string.
- Legacy `multi_select=` and `questions=` calls are accepted. Keyword batches
  return the older `{answers, timed_out}` shape.
- A normalized list returns `{answers, outcome}` keyed by the supplied qids.
  Empty replies record a deliberate skip as null. Timeout and interruption
  leave remaining qids absent, preserving answered/skipped/unanswered.

Batches use the existing Studio/App question transport, showing one question
at a time under a shared five-minute deadline. Choice labels and JSON array
replies pass through unchanged for the installed kernel to normalize.
This adapts the callback contract; it does not introduce a batch form or native
multi-select controls into the existing single-choice/free-text UI.

Waiting polls for interruption, session removal and run replacement. It stops
the remaining questions, clears pending request queues and emits resolution
events on timeout/cancellation. A callback whose session is already absent
returns undelivered with a notice without showing a prompt or waiting.
Legacy single-question timeouts use the
installed kernel's canonical sentinel when available.

Validation:

- 175 focused bridge, bootstrap, chat clarification and group approval tests
  passed, including 11 new Python callback regressions.
- A source probe ran the actual upstream clarify handlers from v0.20.6
  (`v2026.8.27`), v0.21.5 (`v2026.9.24`), the pre-update head `b4410b4bad`,
  `5eea87882a`, v0.21.6 and main `8ac5c74432`. Answer/skip/multi-select,
  partial timeout and partial cancellation cases passed on all six.
  Legacy single-question calls passed on all three legacy sources; the
  pre-fix method reproduced the failure on current main.
- A Python 3.14 probe imported the installed current-main AIAgent and clarify
  tool with real dependencies, under a temporary Hermes home. The real tool
  returned answered/skipped/answered with outcome submitted through the
  Studio callback.
- `npm run harness:check` and `npm run build` passed.
- Both clarification tests in `tests/e2e/chat-streaming.spec.ts` passed.

The local development kernel was fast-forwarded from `b4410b4bad` to
`8ac5c74432`; `hermes --version` reports `v0.21.6+183.g8ac5c74`.
Required tools and the recorded Python dependency selection were synchronized
against the updated source, and `pm.venv_is_current` returned true.
The Python module's static version still reads `0.21.5`, which reinforces why
this adapter does not gate on version strings. The independently pinned
desktop runtime and release artifacts are outside this callback fix.
