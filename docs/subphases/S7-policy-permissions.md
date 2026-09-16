# S7 policy permissions

Authorable grant keys are navigation, action, network headers/body, secret use/read, and
store write. Store-write values name workflow tables. The graph compiler validates proposals
against each kind's actual registry and strips account-baseline denials before publication.

There are no MCP-call or asset-write grants because those execution surfaces were removed.
