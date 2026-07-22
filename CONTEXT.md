# Conduit domain context

Conduit projects portable agent integration into a host. A host may be a CLI
harness, an IDE agent, an SDK, or an in-process framework. Capabilities are
evidence-bearing declarations, not optimistic compatibility claims.

Flow Agents is a consumer: it owns workflow and policy semantics. Station is a
consumer and reference host: it owns orchestration, approvals, memory, and UI.
Relay owns model invocation. Dispatch owns model routing. Conduit owns none of
those concerns.
