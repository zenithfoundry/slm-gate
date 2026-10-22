---
name: release-checklist
description: the steps between a green branch and a published version
owners:
  - release crew
---

# Release checklist

This section explains the reasoning behind the workflow so a new reader understands why each part exists.
Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort.
Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool.

A release MUST be cut from the main branch only.

## Steps

You should read the whole page once before applying it, because later sections refine earlier ones. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

1. Tag the commit with `mcp__example__tag_release` using the next version number.
2. Build the artefact once with scripts/build-release.sh and promote that same file.
3. Wait at most 15 min for the smoke run; a red run blocks the release.

## Background part 1

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool.

Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. You should read the whole page once before applying it, because later sections refine earlier ones. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Record decisions where the next person will look for them, not in a chat thread that scrolls away.

## Background part 2

You should read the whole page once before applying it, because later sections refine earlier ones. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly.

The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Record decisions where the next person will look for them, not in a chat thread that scrolls away. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Automation handles the repetitive checks; people handle judgement calls and trade-offs.

## Background part 3

The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Record decisions where the next person will look for them, not in a chat thread that scrolls away. Feedback should be specific and tied to a line, a file or a behaviour, never to a person. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

Feedback should be specific and tied to a line, a file or a behaviour, never to a person. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort.

## Background part 4

Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly. Automation handles the repetitive checks; people handle judgement calls and trade-offs. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it.

Automation handles the repetitive checks; people handle judgement calls and trade-offs. You should read the whole page once before applying it, because later sections refine earlier ones. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

## Background part 5

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers.

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Record decisions where the next person will look for them, not in a chat thread that scrolls away. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Record decisions where the next person will look for them, not in a chat thread that scrolls away.

## Background part 6

You should read the whole page once before applying it, because later sections refine earlier ones. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort.

Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Automation handles the repetitive checks; people handle judgement calls and trade-offs.

## Limits

When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers.

| Stage | Owner | Time limit |
|---|---|---|
| publish | release crew | 10 min |

## Practice part 1

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool.

Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. You should read the whole page once before applying it, because later sections refine earlier ones. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Record decisions where the next person will look for them, not in a chat thread that scrolls away.

## Practice part 2

You should read the whole page once before applying it, because later sections refine earlier ones. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly.

The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Record decisions where the next person will look for them, not in a chat thread that scrolls away. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Automation handles the repetitive checks; people handle judgement calls and trade-offs.

## Practice part 3

The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Record decisions where the next person will look for them, not in a chat thread that scrolls away. Feedback should be specific and tied to a line, a file or a behaviour, never to a person. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

Feedback should be specific and tied to a line, a file or a behaviour, never to a person. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort.

## Practice part 4

Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly. Automation handles the repetitive checks; people handle judgement calls and trade-offs. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it.

Automation handles the repetitive checks; people handle judgement calls and trade-offs. You should read the whole page once before applying it, because later sections refine earlier ones. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

## Practice part 5

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers.

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Record decisions where the next person will look for them, not in a chat thread that scrolls away. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Record decisions where the next person will look for them, not in a chat thread that scrolls away.

## Practice part 6

You should read the whole page once before applying it, because later sections refine earlier ones. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort.

Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Automation handles the repetitive checks; people handle judgement calls and trade-offs.

## Rules

Record decisions where the next person will look for them, not in a chat thread that scrolls away. Feedback should be specific and tied to a line, a file or a behaviour, never to a person.

ALWAYS keep the previous version available for rollback.
The notes come from mcp__example__draft_notes and are edited by a person.
Do not publish more than 3 releases on one day.

## Notes part 1

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool.

Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. You should read the whole page once before applying it, because later sections refine earlier ones. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Record decisions where the next person will look for them, not in a chat thread that scrolls away.

## Notes part 2

You should read the whole page once before applying it, because later sections refine earlier ones. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly.

The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Record decisions where the next person will look for them, not in a chat thread that scrolls away. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Automation handles the repetitive checks; people handle judgement calls and trade-offs.

## Notes part 3

The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Record decisions where the next person will look for them, not in a chat thread that scrolls away. Feedback should be specific and tied to a line, a file or a behaviour, never to a person. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

Feedback should be specific and tied to a line, a file or a behaviour, never to a person. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort.

## Notes part 4

Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly. Automation handles the repetitive checks; people handle judgement calls and trade-offs. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it.

Automation handles the repetitive checks; people handle judgement calls and trade-offs. You should read the whole page once before applying it, because later sections refine earlier ones. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

## Notes part 5

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers.

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Record decisions where the next person will look for them, not in a chat thread that scrolls away. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Record decisions where the next person will look for them, not in a chat thread that scrolls away.

## Notes part 6

You should read the whole page once before applying it, because later sections refine earlier ones. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort.

Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Automation handles the repetitive checks; people handle judgement calls and trade-offs.

## Commands

```bash
./scripts/build-release.sh --tag "$VERSION"
```

## Appendix part 1

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool.

Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. You should read the whole page once before applying it, because later sections refine earlier ones. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Record decisions where the next person will look for them, not in a chat thread that scrolls away.

## Appendix part 2

You should read the whole page once before applying it, because later sections refine earlier ones. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly.

The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Record decisions where the next person will look for them, not in a chat thread that scrolls away. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Automation handles the repetitive checks; people handle judgement calls and trade-offs.

## Appendix part 3

The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers. Record decisions where the next person will look for them, not in a chat thread that scrolls away. Feedback should be specific and tied to a line, a file or a behaviour, never to a person. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

Feedback should be specific and tied to a line, a file or a behaviour, never to a person. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort.

## Appendix part 4

Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly. Automation handles the repetitive checks; people handle judgement calls and trade-offs. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it.

Automation handles the repetitive checks; people handle judgement calls and trade-offs. You should read the whole page once before applying it, because later sections refine earlier ones. Keep the branch short-lived and merge it once the checks pass and one reviewer has approved it. Changes land in small pieces, each one reviewed on its own, which keeps the history easy to follow.

## Appendix part 5

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Teams adopt it gradually, usually starting with the parts that remove the most repeated manual effort. Nothing here depends on a particular editor, and the same steps work from a terminal or an integrated tool. Do not skip the review after a hotfix; the smaller the change, the easier it is to review it properly. The wording is deliberately plain, since the people reading it range from new joiners to long-time maintainers.

This section explains the reasoning behind the workflow so a new reader understands why each part exists. Record decisions where the next person will look for them, not in a chat thread that scrolls away. When a step fails, stop and fix it before moving on, rather than stacking more work on a broken state. Record decisions where the next person will look for them, not in a chat thread that scrolls away.
