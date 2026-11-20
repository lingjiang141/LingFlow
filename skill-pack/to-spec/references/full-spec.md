# Full spec template

Read this template only when no applicable effective spec exists, or an explicitly requested new complete version is needed. Preserve stable requirement IDs, existing decisions and active references. Summarize the discussed scope; do not invent requirements or runtime file ownership.

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A numbered list covering every confirmed observable requirement once. Assign stable requirement IDs (for example REQ-001), keeping distinct actions such as create, edit and delete separately traceable. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

Cover all agreed behaviour without restating the same requirement in several sections. Preserve unresolved items explicitly; do not invent requirements to make the list longer.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Planning and execution handoff

Keep business requirements authoritative here. Tickets reference requirement IDs and define acceptance; the execution controller binds the real baseline, allowed writes, exclusive resources and runnable checks just before dispatch. A planned attempt is a provisional verification route, not a second implementation specification. Runtime and attempt records store references and changes rather than repeating this spec.

## Further Notes

Any further notes about the feature.
