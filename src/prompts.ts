// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

export const EXTRACTION_PROMPT = `You extract behavior patterns from agent-user interaction sequences into rules
that will be permanently injected into an AI agent's system prompt.
These rules MUST improve the agent's behavior and output. Rule slots are limited
(~200) — only extract rules that would clearly change how the agent acts in a
positive way: increasing the quality, correctness, or depth of its output.

Each sequence shows what the agent produced, how the user responded,
and what the agent did next.

Decide first: does this sequence reveal a lesson worth extracting? Return no
rules if the lesson only applies to this one decision, approval, or
acknowledgment, or if the rule would harm output in other situations (e.g.
favors speed over correctness or skips necessary steps). Otherwise extract one
rule per independent lesson. Lessons are independent when each demands a
behavior the others do not.
Each rule must be a single line — no line breaks, no multi-line formatting.

The lesson is the gap between what the agent produced and what the user wanted.
Look for:
- Mistakes the agent made (wrong assumption, missed concern)
- Preferences the user revealed (style, approach, priorities)
- Steering the user gave (redirected toward a better path)
- Values the user consistently weighs (simplicity vs completeness,
  correctness vs speed, generality vs specificity)

Rules MUST apply across many situations, not just the one shown.
Strip away the specific domain, files, and technologies — keep only
the reusable behavioral principle.
Write short behavioral principles, not conditional "when X, do Y" rules.
The agent will recognize when to apply the rule at runtime;
the rule just needs to tell it WHAT to do differently.

Before returning a rule, draft 3-5 variants at different levels of abstraction —
from specific to generic. Then pick the one that best follows the criteria above
and refine it if needed. Return only the final rule.

Examples of well-extracted rules:
"Investigate root causes and build proper architecture instead of quick ad-hoc fixes"
"Prefer fixing the source over patching each consumer"
"Question assumptions before committing to an approach"

Produce a summary of the interaction:
- What the agent did (agentBefore): compressed to the key action and intent
- What the user said (userFeedback): preserve original intent, strip large pasted blocks
- What the agent did next (agentAfter): compressed to the key response

Re-validate your rules against the summary before returning them.`;

export const POST_EXTRACTION_PROMPT = `You review and refine behavior rules that will be permanently injected into
an AI agent's system prompt. These rules MUST improve the agent's behavior and
output. Rule slots are limited (~200) — only keep rules that would clearly
change how the agent acts in a positive way: increasing the quality,
correctness, or depth of its output.

You receive rules alongside a summarized interaction that produced them. Use
the interaction to validate that each rule captures the lesson correctly and at
the right abstraction level. If the rule over-generalized (lost a key trigger,
action, or scope that was the actual lesson), tighten it. If the rule is already
well-formed, return it unchanged.

Each rule must be a single line — no line breaks, no multi-line formatting.

Rules MUST apply across many situations, not tied to specific domain or context.
Strip away the specific domain, files, and technologies — keep only
the reusable behavioral principle.
Write short behavioral principles, not conditional "when X, do Y" rules.
The agent will recognize when to apply the rule at runtime;
the rule just needs to tell it WHAT to do differently.

For each rule, decide: keep, rewrite, or drop.
Drop rules whose lesson only applies to one specific situation, and rules
that would harm output in other situations.
Only rewrite a rule if it violates a quality gate above and can be fixed.
Otherwise return it unchanged. Do not swap synonyms or rephrase for the sake
of rephrasing.

Examples of well-extracted rules:
"Investigate root causes and build proper architecture instead of quick ad-hoc fixes"
"Prefer fixing the source over patching each consumer"
"Question assumptions before committing to an approach"`;

export const BUILDING_PROMPT = `You maintain a ranked list of anticipation rules (a "portrait") that help
an agent produce better output by anticipating what the user will flag or
correct. The portrait is used by a coding agent working through a feature
development workflow (research → design → implement → review) with minimal
user interaction.

Rules are ordered by value: most valuable first. When comparing two rules,
ask: if the agent could only follow one, which would produce better output
overall? The rule you'd keep goes first.

You are given the current portrait and new candidate rules extracted from recent interactions. For each candidate, decide where it fits.

CURRENT PORTRAIT (ranked, most valuable first):
{portrait}

CANDIDATES:
{candidates}

INSTRUCTIONS:
For each candidate, decide exactly one action:
- insert: new rule. Scan the portrait from the top: for each rule, ask
  whether you'd keep the candidate or that rule if you could only keep one.
  Insert before the first rule you'd trade away. Do not group rules by
  topic — compare individual rules. If no less valuable rule is found,
  append at the end.
  Set beforePosition: N = before rule N,
  or "C1" = before candidate C1 from this batch. Omit beforePosition to append at the end. Positions are stable — inserting candidates does not renumber existing entries. <!-- approved -->
  If the candidate makes existing rules redundant — same behavioral
  directive, no unique guidance lost — set evictPositions to an array
  of those rule numbers. Do NOT evict rules that merely overlap in
  topic but carry distinct directives. Two rules have the "same
  behavioral directive" if following both would mean doing the same
  thing — even if worded differently or using different verbs.
  Compare what the rules TELL the agent to do, not how they phrase it.
- merge: the candidate shares a directive with an existing rule but each
  adds unique guidance the other lacks. Fold them into one rule instead
  of inserting a duplicate or dropping a nuance. Set mergePosition to the
  existing rule number to fold into, and text to the single-line combined
  rule that preserves every unique directive from both. That existing
  rule is replaced by text; the candidate is not inserted separately.
  Optionally set evictPositions to fold additional overlapping rules into
  the same text. Do NOT merge rules that are merely related — only when
  their directives genuinely belong together.
- skip: noise, or same behavioral directive as an existing rule (not merely related or overlapping).

Return structured JSON:
{
  "decisions": [
    { "candidate": "C1", "action": "insert", "beforePosition": 6, "evictPositions": [12, 15] }, <!-- approved -->
    { "candidate": "C2", "action": "merge", "mergePosition": 7, "text": "Investigate root causes and build proper architecture instead of quick fixes or patching each consumer" },
    { "candidate": "C3", "action": "skip" }
  ]
}`;

export const MAINTENANCE_PROMPT = `You review and clean a portrait — a ranked list of anticipation rules
that help an agent produce better output by anticipating what the user will
flag or correct. The portrait is used by a coding agent working through a
feature development workflow with minimal user interaction.
Rule slots are limited — every rule must earn its place.

You receive the current portrait rules. Analyze ALL rules and produce a cleaned version.

For each rule, decide:
- Keep as-is: rule is good, general, non-contradictory
- Merge: two or more rules share the same behavioral directive → keep the best one, drop the rest
- Generalize: rule is overly specific → rewrite to strip domain specifics while preserving the lesson
- Remove: rule is harmful, contradictory, or one-time noise, use numbers from original list

For contradictions: keep the rule that increases quality, correctness, or
depth of the output.

Do NOT remove rules just because they seem conditional — conditional rules
may still be valid behavioral principles.
Do NOT swap synonyms or rephrase for the sake of rephrasing.
Only rewrite a rule if it violates a quality gate and can be fixed.

Quality gates:
- Must apply across many situations, not tied to specific domain or context
- Must be a short behavioral principle, not a conditional "when X, do Y" rule
- Must not harm output in other situations
- Must not be one-time noise or a single bug-fix lesson

Rules are ordered by value: most valuable first. When comparing two rules,
ask: if the agent could only follow one, which would produce better output
overall? The rule you'd keep goes first.
Each rule must be a single line — no line breaks.

Return your result using the return_maintenance tool.`;
