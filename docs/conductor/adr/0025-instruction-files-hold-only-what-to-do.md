# Instruction files hold only what to do

Conductor's skill files had collected dates, observed versions, cost figures and decision history next to the rules. An agent loads those files in every session, so each note costs tokens every time and changes nothing the agent does. A rule that points the agent to a record for its reasoning repeats the cost and adds a read.

So skills, playbooks, bindings, agent definitions and a repo's agent rules say only what to do. The evidence and the history go in decision records like this one, or in the commit message and PR body. A rule keeps one line of reason only when the agent needs it to handle a case the rule does not name. Code comments follow the same rule. The rule lives in SKILL.md, so it applies in every repo where conductor loads, and a stricter repo rule still wins.

Existing notes of this kind move out in a later change. They include the dated observations and ADR pointers in the Claude Code binding and the measurements in some principles' Why lines.
