# Contributing

Contributions are accepted under MIT OR Apache-2.0, at the recipient's option.
Preserve copyright and attribution when adapting code or other materials.

Run `python -m pytest` before submitting a change. Tests must remain offline;
network-backed verification is separate and documented in `PROVENANCE.md`.
Changes to policy, admissibility, identity binding, or enforcement require
behavioral regression tests. Preserve the named invariants in `INVARIANTS.md`.

Keep policy evaluation pure. Do not introduce credentials, network clients, or
write capabilities into it. An adapter must declare its capabilities and limits;
a successful historical action is not proof of current ownership.

V0 uses PyYAML for configuration, cryptography for ECDSA verification, and cbor2
for protocol signing bytes. New runtime dependencies need a concrete purpose.
Use Python 3.10-compatible code. The CLI and library are both supported interfaces.

Version incompatible policy, receipt, and state changes explicitly. Refuse
unrecognized schemas rather than silently reinterpreting them. Keep repository
contract filenames uppercase; use lower-kebab names for documents below the root.

Do not commit credentials, live account state, real-user receipts, production
identifiers, logs, generated reports, or campaign records. Fixtures must use
obviously synthetic identities and content. Describe changes using the final
behavior and relevant verification.

GitHub Issues are not the support channel for the hosted beta. Use the contact in
[README.md](README.md) for ordinary support and the private process in
[SECURITY.md](SECURITY.md) for vulnerabilities.
