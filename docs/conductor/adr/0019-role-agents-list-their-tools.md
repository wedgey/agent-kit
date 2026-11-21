# The read-only and mechanical role agents list their tools

Every tool and skill a delegate can see is sent again on each of its turns. On 2026-11-21 a haiku delegate in a large repo started at 36.0k input tokens with the role agents' deny lists, which removed only `Agent` and the edit tools. About 11k of that was the `Skill` tool's skill listing, and much of the rest was tools the role never calls.

So the explorer, reviewer and editor name their tools with a `tools:` allowlist and start at about 16.8k. `ToolSearch` is on each list, which keeps rare tools deferred until called. They have no `Skill`, and read a `SKILL.md` the brief points to. The reviewer gains the most: it runs more often than any other role, on the frontier tier.

A list can name a whole MCP server but has no wildcard, and a published plugin cannot name the servers each repo uses, so these three get no MCP tools. Their past use was small: 4 reviewer calls in 376 runs, all in one review checking a flag's rollout, and 16 explorer calls in 25 runs. A review that depends on live state gets it in its brief or leaves the check to the verifier, and an explorer that needs MCP data is spawned as `Explore`.

The lane, implementer and verifier keep their deny lists. Their work can reach any service a repo uses, such as deploying or checking a real event, and a list fixed in the plugin cannot follow that. Their saving from a list would have been 4.6k to 8.3k a turn. This amends ADR 0006 for the three roles that list their tools.
