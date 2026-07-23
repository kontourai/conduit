# Conduit domain context

Conduit projects portable agent integration into a host. A host may be a CLI
harness, an IDE agent, an SDK, or an in-process framework. Capabilities are
evidence-bearing declarations, not optimistic compatibility claims.

Flow Agents is a consumer: it owns workflow and policy semantics. Station is a
consumer and reference host: it owns orchestration, approvals, memory, and UI.
Relay owns model invocation. Dispatch owns model routing. Conduit owns none of
those concerns.

Named adapters are capability profiles plus caller bindings. Local harness
bindings own target resolution and writes; framework bindings own hook
registration and framework objects. A named adapter is not evidence that
Conduit loaded, configured, or authenticated the host.
