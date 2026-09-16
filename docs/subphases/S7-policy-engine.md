# S7 policy engine

Implemented. Policy checks run at host capability boundaries: browser navigation/actions/network
reads, secret use/redaction, and decision store writes. Account baselines can deny or require
approval for authorable grants. Proposed grants remain inert until approved and are carried by
task identity across compatible publications.

Capabilities absent from a kind's registry cannot be granted into existence. In particular,
browser tasks cannot access the store and decision tasks cannot access a browser.
