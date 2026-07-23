# Host conformance matrix

Generated from `conformance/host-conformance.json`. Do not edit by hand.

| Adapter | Adapter version | Host version | Session start | Before model | Before tool | After tool | Stop | Context | Blocking | Probe | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | 0.2.0 | public-hooks | native | approximated | native | native | native | native | native | pass | before-model is projected through prompt submission hooks; context assets are static instructions |
| codex | 0.2.0 | public-config | unavailable | unavailable | unavailable | unavailable | observational | static-only | unavailable | pass | lifecycle observation requires host-owned notification binding; no public synchronous tool-blocking hook |
| opencode | 0.2.0 | public-plugin-api | native | native | native | native | approximated | native | native | pass | stop is derived from session lifecycle events |
| strands | 0.2.0 | caller-bound | native | native | native | native | native | native | native | pass | framework objects and hook registration are supplied by the caller |
| voltagent | 0.2.0 | caller-bound | native | native | native | native | native | native | native | pass | framework objects and hook registration are supplied by the caller |
