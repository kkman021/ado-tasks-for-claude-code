---
name: claude-go
description: Take one Azure DevOps work item from analysis to code. A new oh-my-claudecode agent analyzes the repository together with the card (description, acceptance criteria, repro steps, comments). For a Bug it also scores its confidence in the fix from 0 to 10; below 7 it implements nothing and publishes a comment handing the bug to a person, with its analysis. If the card is clear (and, for a Bug, the confidence is 7 or more), it implements the change in its own git worktree on a new branch; once the main agent has verified that commit, it pushes the branch to the remote and posts a result comment on the card mentioning the user (@me). If the analysis is blocked, it says what is missing. If the card itself is incomplete, it publishes a clarification comment on the card. It reports back to the main agent in each case. A User Story is never implemented; it is analyzed only. The analysis judges whether the story and its acceptance criteria are clear enough, and whether its child Tasks cover it. Missing Tasks are created as "[AI Draft]" Tasks from a repository analysis, and changes to existing Tasks are agreed with the user first. Use when the user says "Claude Go", "使用 ado-tasks:claude-go skill 處理 #<id>", or asks to analyze and implement an ADO work item end to end.
argument-hint: <work item id>
---

# Claude Go: ADO work item → analysis → code

The main agent (you) orchestrates; one subagent does the work. Do not analyze or code in the main agent.

A **User Story** takes its own path: section 1, then section 4 in place of sections 2 and 3. It is analyzed, never implemented. Every other type (Task, Bug, ...) takes sections 1 to 3.

## 1. Main agent: collect the inputs

1. Get the work item id from the arguments or the prompt. If there is none, stop and ask for it.
2. Call `mcp__ado-tasks__get_task` with that id. This returns:
   - the description, acceptance criteria, repro steps, area, iteration and tags;
   - `parentId` and `childIds`;
   - the latest 20 comments.

   If the call fails (missing `.claude/ado.json`, missing PAT, or a 401/404), stop and report the error. Do not spawn the agent.
3. Collect the related cards. A card often depends on its siblings, and its parent often holds the shared contract (endpoint, payload, rules).
   - If the card has a `parentId`, call `mcp__ado-tasks__get_task` on the parent. Then call it on every id in the parent's `childIds` except this card's: those are the siblings.
   - If the card has `childIds`, call `mcp__ado-tasks__get_task` on each child.
   - Fetch the cards in parallel, at most 10 siblings and 10 children (30 children for a User Story: its Tasks are what section 4 judges). Note how many were left out.
   - Do not walk further up or down than one level.
   - A related card that fails to load is noted as unavailable, with its error. It does not stop the run.
4. Run `git status --short --branch` and note the current branch. That branch is the worktree's base.
5. Note anyone the user asked to @mention (for example "問 PM Amy"), exactly as the user wrote them.
   - Pass them to the agent; do not look up their ids.
   - `add_task_comment` (mentions) and `assign_task` (assignee) resolve names against the project's team members and Contributors group (`mcp__ado-tasks__list_members`).
6. Read the repository's `CLAUDE.md` / `AGENTS.md` if present, for:
   - the branch naming rule;
   - the commit message rule;
   - the build and test commands;
   - the bug-fix rule.

## 2. Main agent: spawn the subagent

Use the Agent tool with these settings:

- `subagent_type`: `oh-my-claudecode:executor`
- no `model`: the agent's own default tier applies, so model routing stays with oh-my-claudecode
- `isolation`: `worktree`, so the agent works in its own git worktree and the main checkout is never touched
- `description`: `Claude Go #<id>`
- `prompt`: the template below, filled in.
  - Paste the whole `get_task` result for this card, comments included.
  - Paste every related card's result too, comments included.

```
You are handling Azure DevOps work item #<id> in this repository. You are in an isolated git worktree.

## Work item (from mcp__ado-tasks__get_task, comments included)
<paste the full get_task result here>

## Related cards (parent, siblings, children; from mcp__ado-tasks__get_task)
<for each: its relation (PARENT / SIBLING / CHILD), then its full get_task result; "none" if the card has no parent and no children; note any left out or unavailable>

## Repository rules
<the branch, commit, build, test and bug-fix rules found in CLAUDE.md / AGENTS.md; "none found" if absent>

## People to mention
<names or emails the user asked to @mention in a card comment, exactly as given; "none" if the user named nobody>

## Step A: analyze
Read the card and every comment; a later comment can change or override the description.
Read the related cards for what this card relies on:
- the parent's contract and rules: endpoints, payloads, status codes, domain semantics;
- the siblings that build what this card uses.
Explore the repository to locate the code the card concerns.
Check whether each dependency has already landed in the code; a card's state alone does not prove it.
Implement only what this card owns. A sibling's scope is never folded in unasked.
A title starting with "[AI Draft]" marks a Task drafted from a story analysis. It is a normal card: judge it by its content, and leave the prefix in the title.
For a Bug, score your confidence in the fix from 0 to 10 before writing any code, once the card is complete and nothing outside it is missing.
It is your confidence that the change you would make fixes the reported behaviour, and breaks nothing else.
Use these anchors, and name the evidence for each point you give or take away:
- 9-10: the root cause is located at specific lines; the repro steps match what the code does; the fix is local and changes nothing beyond the bug.
- 7-8: the root cause is located with strong evidence and the fix is small; one minor uncertainty remains (an edge case, one other caller to check).
- 4-6: the cause is plausible but not confirmed, several causes are possible, or the fix changes shared behaviour or a contract other code relies on.
- 0-3: the cause is not found, the repro steps contradict the code, or the fix needs a design decision.

Classify the result as exactly one of:

- IMPLEMENT: the goal, scope and acceptance are clear enough to write and verify the change; for a Bug, the confidence is 7 or more.
- LOW_CONFIDENCE (Bug only): the card is clear enough, but the confidence is below 7. A person takes the bug over, or answers what would raise the confidence.
- NEED_INFO: the card is clear, but you cannot finish the analysis without something outside the card.
  Examples: access to a system, a log, a sample payload, a decision between two valid designs.
  Another case: a sibling that must land first and has not. Name that sibling's id and title.
- INCOMPLETE_CARD: the card itself lacks what an implementer needs.
  Examples: no expected behaviour, no acceptance criteria, contradictory requirements, missing repro steps for a bug.

## Step B: act on the classification

IMPLEMENT
1. Create a new branch from the worktree's HEAD.
   Use the repository's naming rule. Default: `bugfix/<id>-<slug>` for a Bug, `feature/<id>-<slug>` otherwise, where the slug is kebab-case from the title.
2. Implement the change, following the repository's layering and coding rules.
   - For a Bug, first write a failing test that reproduces it, then fix the code.
   - Update every reference to anything you change.
   - For a Bug, the score must still hold while you work. Switch to LOW_CONFIDENCE in either case below:
     - the reproducing test cannot be made to fail before the fix (the bug is not reproduced);
     - the fix grows beyond the cause you scored.
     Before switching, discard every change (`git checkout -- .` and `git clean -fd` inside the worktree), commit nothing, and give the new score with the reason.
3. Run the build and the tests. Iterate until both pass.
   If they cannot pass, stop and report the failure output; do not fake success.
4. Commit on the new branch with a message that links the work item (`#<id>`).
   Do not push and do not open a PR: the main agent pushes once it has verified the commit.
5. Do not change the work item's state.

LOW_CONFIDENCE
1. Draft a comment for the card in the language the card is written in, asking a person to take the bug over or to answer. It holds:
   - the confidence score out of 10, and each reason that lowered it;
   - the suspected root cause, with file and line;
   - the candidate fix, and what it could affect;
   - what would raise the confidence: the questions to answer, the data or logs to supply, or the decision to make.
2. Choose who to @mention, publish the comment, and handle a refused mention or a failed post exactly as in INCOMPLETE_CARD steps 2 to 5.
3. Make no code change.

NEED_INFO
Make no code change. List each missing item, why it is needed, and who can likely supply it.

INCOMPLETE_CARD
1. Draft a comment for the card in the language the card is written in. It lists the specific questions or missing fields: what is unclear, and what answer would unblock implementation.
2. Choose who to @mention:
   - always `@creator`, the card's author, who can fill the gap;
   - also `@assignee`, when the card has one and it is a different person from the creator (compare the ids in `creator` and `assignee`);
   - plus everyone listed under "People to mention" above.
3. Publish it with `mcp__ado-tasks__add_task_comment` (id `<id>`), passing the people as `mentions`.
   - Never write mention markup into `text` yourself; the tool builds it.
   - The user confirms the post, unless `.claude/ado.json` sets `confirm.comment` to false.
4. If the tool refuses a mention (no match, or several matches), do not guess.
   - Drop only that person and post with the rest.
   - Report the refused name and the candidates the tool listed.
5. If the tool is not available to you, or the post is declined or fails, do not retry.
   Return the draft marked UNPUBLISHED, with the reason.
6. Make no code change.

## Step C: report to the main agent
End with exactly this block:

RESULT: IMPLEMENT | LOW_CONFIDENCE | NEED_INFO | INCOMPLETE_CARD
SUMMARY: <2-4 lines: what the card asks for and what you concluded>
CONFIDENCE: <for a Bug: n/10 and the evidence for it; "n/a" otherwise>
For IMPLEMENT:
  BRANCH: <branch name>
  WORKTREE: <absolute worktree path>
  COMMITS: <hash and subject, one per line>
  FILES: <changed files>
  VERIFICATION: <build and test commands, with their pass/fail counts>
For LOW_CONFIDENCE:
  COMMENT_STATUS: PUBLISHED (comment id <n>) | UNPUBLISHED (<reason>)
  MENTIONED: <names from the tool's `mentioned` result; refused names with their candidates; "none" if nobody>
  COMMENT: <the exact comment text>
For NEED_INFO:
  MISSING: <numbered list>
  BLOCKED_BY: <sibling ids and titles that must land first, in order; "none" otherwise>
For INCOMPLETE_CARD:
  COMMENT_STATUS: PUBLISHED (comment id <n>) | UNPUBLISHED (<reason>)
  MENTIONED: <names from the tool's `mentioned` result; refused names with their candidates; "none" if nobody>
  COMMENT: <the exact comment text>
```

## 3. Main agent: relay the result

The agent runs in the background. Wait for its completion notification and do not predict its result. Then report to the user according to `RESULT`:

- **IMPLEMENT**:
  1. Verify the fix landed; the agent's report alone does not prove it.
     - `git -C <WORKTREE> log --oneline <base>..<BRANCH>`, where `<base>` is the branch noted in section 1 step 4, lists every hash in `COMMITS`, and each subject links `#<id>`.
     - `git -C <WORKTREE> status --short` is empty: nothing left uncommitted.
     - Run the repository's build and test commands with `<WORKTREE>` as the working directory. Both pass.
       - Never move the session's own working directory into the worktree: no bare `cd` / `Set-Location`.
         `.claude/ado.json` is usually untracked, so it is absent from the worktree, and every `mcp__ado-tasks__*` call resolves it from the session's working directory.
       - Scope the directory change to the one command instead.
         Bash: `(cd "<WORKTREE>" && <command>)`.
         PowerShell: `Push-Location "<WORKTREE>"; try { <command> } finally { Pop-Location }`.

     - For a Bug, `CONFIDENCE` is 7/10 or more.

     If any check fails, push nothing and post no comment. Report the failing check with its output and stop.
  2. Push the branch to the remote, so the fix exists beyond this machine.
     - The remote is the upstream of the base branch noted in section 1 step 4 (`git -C <WORKTREE> config branch.<base>.remote`, which prints the remote's name, such as `origin`), else `origin`. With no remote at all, push nothing, post no comment, report that and stop.
     - `git -C <WORKTREE> push -u <remote> <BRANCH>`. Never force-push, and never push any other branch.
     - Confirm it landed: the hash from `git -C <WORKTREE> ls-remote --heads <remote> <BRANCH>` equals `git -C <WORKTREE> rev-parse <BRANCH>`.
     - If the push is rejected or fails, do not retry and post no comment. Report the error output. The user can push by hand and then ask for the result comment.
  3. Post the result comment with `mcp__ado-tasks__add_task_comment` (id `<id>`, `mentions: ["@me"]`).
     - First confirm the session's working directory is still the main checkout, where `.claude/ado.json` was read in section 1. If it moved, change back before posting.
     - `@me` resolves to the person the PAT belongs to, so the user is notified and decides the next step from the card.
     - Write the comment in the language the card is written in, as HTML, with these parts:
       - the cause and the fix, from `SUMMARY`;
       - for a Bug, the confidence score from `CONFIDENCE`, with its evidence;
       - the branch, pushed to `<remote>`; the commits (hash and subject); the files changed;
       - the verification: the build and test commands with their pass/fail counts, from step 1;
       - that no PR was opened and the state is unchanged, so review, the PR, the merge and the state change are pending the user's decision.
     - Never write mention markup into `text`; the tool builds it. The user confirms the post, unless `.claude/ado.json` sets `confirm.comment` to false.
     - If the post is declined or fails, do not retry; show the draft marked UNPUBLISHED with the reason.
  4. Report the branch and the remote it was pushed to, the worktree path, the commits, the files changed, the confidence score for a Bug, the verification results and the comment status (its id when published).

  Pushing the verified branch is part of this step. Opening a PR, merging and changing the work item's state are the user's decisions; do not do any of them unasked.
- **LOW_CONFIDENCE**: report the score and its reasons, then relay the comment as for INCOMPLETE_CARD below. Say that no code was changed and the bug waits for a person.
- **NEED_INFO**: report the missing items as listed. If `BLOCKED_BY` names cards, give the order to run Claude Go on them.
- **INCOMPLETE_CARD**:
  - With `PUBLISHED`: quote the comment that was posted, give its id, and say who was mentioned and notified.
  - If a mention was refused: show the candidates and offer to post a follow-up comment mentioning the right person.
  - With `UNPUBLISHED`: show the draft. Offer to post it with `mcp__ado-tasks__add_task_comment`; that tool asks the user to confirm unless `.claude/ado.json` sets `confirm.comment` to false.

If the agent returns without a `RESULT` block, or reports a failure, report that as it is.

## 4. User Story: analysis only

A User Story is never implemented: no worktree, no branch, no code change, no state change. The output is a judgment of the story, and child Tasks that a later `plan` can map its steps to.

### 4.1 Main agent: spawn the analyst

Use the Agent tool with these settings:

- `subagent_type`: `oh-my-claudecode:analyst` (read-only: it cannot write files)
- no `model`: the agent's own default tier applies, as in section 2
- no `isolation`: the analyst only reads the repository
- `description`: `Claude Go Story #<id>`
- `prompt`: the template below, filled in like the one in section 2. Mark every child as `CHILD (<type>)`, so the Tasks stand apart from other child types.

The analyst writes nothing to Azure DevOps. Every comment, Task creation and Task change is made by the main agent in 4.2, where the user is asked.

```
You are analyzing Azure DevOps User Story #<id> in this repository. Analyze only: change no file and call no Azure DevOps tool.

## User Story (from mcp__ado-tasks__get_task, comments included)
<paste the full get_task result here>

## Related cards (parent, siblings, children; from mcp__ado-tasks__get_task)
<for each: PARENT / SIBLING / CHILD (<type>), then its full get_task result; note any left out or unavailable>

## Repository rules
<the layering, branch, commit, build, test and bug-fix rules found in CLAUDE.md / AGENTS.md; "none found" if absent>

## Step A: judge the story
Read the story and every comment; a later comment can change or override the description.
Check each of these, and name every gap with the question that would close it:
1. Who, what and why: the user role, the behaviour wanted, the value.
2. Scope: what is in and what is out; nothing left to guess, nothing contradictory.
3. Acceptance criteria: present; each one observable and verifiable by a test or a manual check;
   error, empty and boundary cases covered where the behaviour has them; UI, API and data expectations stated where they apply.
4. Dependencies: what the parent's contract or a sibling must supply first.
Verdict, exactly one:
- CLEAR: Tasks can be derived and verified from the story as written.
- NEEDS_CLARIFICATION: gaps exist, but the clear part can already be split into Tasks.
- INCOMPLETE: the goal or the acceptance is missing or contradictory; any Task split would be guesswork.

## Step B: analyze the repository
Locate the code the story touches, layer by layer, following the repository's layering rule.
Note what exists and can be reused, and what must be added or changed: files, types, endpoints, UI, tests.

## Step C: judge the existing child Tasks
Only children of type Task count; list other child types as related.
For each Task: which acceptance criteria and which work it covers, and whether it is enough for a later plan to work from:
- the title names one concrete change;
- the description states the scope (layer, files or types), the done condition, and the dependencies;
- the size fits one plan and one commit;
- it does not overlap another Task.
Verdict per Task: SUFFICIENT, or NEEDS_ADJUSTMENT with the exact new title and/or description.
Then list what no Task covers: acceptance criteria, layers, tests.

## Step D: propose Tasks
Propose Tasks for everything Step C found uncovered; with no child Task at all, propose the full split.
With an INCOMPLETE verdict, propose only for the parts that are not in doubt, and mark the list as provisional.
Rules for each Task:
- one Task is one plan and one commit; split by the repository's layering order (for example Domain → Application → Infrastructure → Api), with tests inside the Task whose code they verify unless the repository says otherwise;
- the title is short and concrete, in the story's language, WITHOUT the "[AI Draft]" prefix (the tool adds it);
- the description is HTML in the story's language, with these sections:
  目標 (goal); 對應 (User Story #<id> and the acceptance criteria it covers); 範圍 (layer, files, types and endpoints to add or change, from Step B);
  完成條件 (checks a test or reviewer can verify); 相依 (Tasks that must land first, by their order number in this list or by #id); 不在範圍 (what this Task leaves to others).

## Step E: report to the main agent
End with exactly this block:

RESULT: STORY_ANALYSIS
STORY_VERDICT: CLEAR | NEEDS_CLARIFICATION | INCOMPLETE
SUMMARY: <2-4 lines: what the story asks for and what you concluded>
STORY_GAPS: <numbered: the gap, why it matters, the question to ask; "none">
REPO_FINDINGS: <the files and types the story touches, by layer>
EXISTING_TASKS: <per Task: #id title | COVERS: <criteria> | SUFFICIENT or NEEDS_ADJUSTMENT | NEW_TITLE: <or "unchanged"> | NEW_DESCRIPTION: <HTML or "unchanged"> | WHY: <reason>; "none">
UNCOVERED: <criteria and work no Task covers; "none">
PROPOSED_TASKS: <numbered, in dependency order; per Task: TITLE, COVERS, DEPENDS_ON, DESCRIPTION (HTML); "none">
```

### 4.2 Main agent: act on the analysis

The analyst runs in the background. Wait for its completion notification and do not predict its result. If it returns without a `RESULT: STORY_ANALYSIS` block, report that as it is and stop.

Before any write, confirm the session's working directory is the main checkout, where `.claude/ado.json` was read in section 1.

1. **Story gaps.** With `NEEDS_CLARIFICATION` or `INCOMPLETE`, post a clarification comment on the story:
   - written in the story's language, listing each gap from `STORY_GAPS` with its question;
   - mentions chosen as in INCOMPLETE_CARD (section 2): `@creator`, `@assignee` when a different person, plus the people the user named;
   - posted with `mcp__ado-tasks__add_task_comment`; a refused mention is handled as in section 2; a declined or failed post is not retried and is shown as UNPUBLISHED.
2. **Tasks, when the story has no child Task.**
   - With `CLEAR` or `NEEDS_CLARIFICATION`: create every task in `PROPOSED_TASKS`, in order, each with `mcp__ado-tasks__create_task` (`parentId` = the story id, `title`, `description`).
     - The tool puts "[AI Draft]" in front of the title, tags the Task "AI Draft" and gives it the story's area and iteration; the user confirms each creation, unless `.claude/ado.json` sets `confirm.create` to false.
     - Before creating Task n, replace each order number in its 相依 section with the #id of the Task already created for it.
     - A declined creation skips that Task only; a failed one stops the rest. Report which were created, skipped or not attempted.
   - With `INCOMPLETE`: create nothing. Show the provisional list, and say the Tasks wait for the answers to the clarification comment.
3. **Tasks, when the story already has child Tasks.** Create or change nothing unasked.
   - If every Task is `SUFFICIENT` and `UNCOVERED` is "none", report that the Tasks cover the story.
   - Otherwise show the user each proposal: each `NEEDS_ADJUSTMENT` Task (current text, proposed text, why) and each task in `PROPOSED_TASKS`.
     Then ask with AskUserQuestion (`multiSelect: true`, at most 4 options per question, more questions if needed) which ones to apply.
   - Apply only what the user picked: `mcp__ado-tasks__update_task` for an adjustment, `mcp__ado-tasks__create_task` for a new Task.
     A title that already starts with "[AI Draft]" keeps the prefix; the tool sees to that.
   - Never delete a Task and never change its state. Report an overlapping or redundant Task for the user to decide.
4. **Report** to the user:
   - the story verdict and its gaps, and the clarification comment's status (its id when published);
   - each Task created or changed: #id, title and URL;
   - proposals not applied, and why (declined, not picked, or waiting on clarification);
   - the order to run Claude Go or a plan on the Tasks, from their dependencies.

The story's state is not changed. Implementing the Tasks is a separate Claude Go run on each Task.
