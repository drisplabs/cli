# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker (`drisplabs/cli` on GitHub).

| Canonical role    | Label in our tracker | Meaning                                  |
| ----------------- | -------------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`    | Requires human implementation            |
| `wontfix`         | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

`wontfix` and `ready-for-agent` already exist on `drisplabs/cli`. Create any of the others on first use (skip any that already exist):

```bash
gh label create needs-triage    --repo drisplabs/cli --color FBCA04 --description "Maintainer needs to evaluate"
gh label create needs-info      --repo drisplabs/cli --color D4C5F9 --description "Waiting on reporter for more info"
gh label create ready-for-human --repo drisplabs/cli --color 1D76DB --description "Needs human implementation"
```

Edit the right-hand column to match whatever vocabulary you actually use.
