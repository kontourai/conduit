# Framework lifecycle bindings

Conduit does not import or pin an agent framework. An application translates
the framework's public hook or event objects at its composition root and
supplies that translation as a `LifecycleRegistrar`.

```ts
const adapter = createVoltAgentAdapter({
  installAsset: applicationAssetRegistry.install,
  applyOutcome: voltAgentOutcomeBridge,
});

const dispose = bindAdapterLifecycle({
  adapter,
  registrar: {
    register(phase, handler) {
      return applicationVoltAgentHooks.on(phase, frameworkEvent =>
        handler(toConduitEvent(phase, frameworkEvent)),
      );
    },
  },
  evaluate: event => applicationLifecyclePolicy.evaluate(event),
});
```

The same composition works with `createStrandsAdapter`; only the registrar and
outcome translator change. `evaluate` stays application-owned, so workflow,
approval, evidence, and model-routing policy never enters Conduit.

The committed matrix labels both framework references `caller-bound`. It
proves Conduit's side of the contract but does not claim a particular framework
package version. A consumer should generate evidence with its actual framework
version after registering real hooks.
