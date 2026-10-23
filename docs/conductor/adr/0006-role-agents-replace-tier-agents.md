# Each delegate role is a defined agent

Where a harness supports agent definition files, its binding ships one agent per delegate role, not one per tier. Each carries its role's default model and effort, the tools that role may not use, its rules and the report shape. The harness's package ships them (ADR 0008) and the doctor probes them. This applies to every such harness, including ones that can also pick a model per spawn.

Role agents enforce what briefs could only ask for. Explorers and reviewers cannot edit, and no delegate can spawn its own. A spawn that forgets its model still lands on the role's tier instead of the session model. Briefs shrink to the work itself. Tier agents were rejected because a tier says nothing about which tools a role needs. An editor and an explorer share a tier but not their tools. The cost is that a role's rules live in `roles.md` and again in each binding's agent files, and the two must be kept in step.
