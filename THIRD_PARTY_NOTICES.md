# Third-party notices

atproto-acl depends directly on the following runtime packages. Their authors
retain their respective copyrights and licenses.

| Package | Purpose | License |
| --- | --- | --- |
| [PyYAML](https://pyyaml.org/) | YAML parsing | MIT |
| [cryptography](https://cryptography.io/) | label signature verification | Apache-2.0 OR BSD-3-Clause |
| [cbor2](https://pypi.org/project/cbor2/) | protocol signing bytes | MIT |
| [@atproto/api](https://www.npmjs.com/package/@atproto/api) | ATProto API client | MIT |
| [@atproto/jwk-jose](https://www.npmjs.com/package/@atproto/jwk-jose) | OAuth signing keys | MIT |
| [@atproto/oauth-client-node](https://www.npmjs.com/package/@atproto/oauth-client-node) | server-side ATProto OAuth | MIT |
| [yaml](https://www.npmjs.com/package/yaml) | hosted policy YAML parsing | ISC |

The lockfiles and built package metadata are authoritative for the exact versions
and transitive dependency set in a release. A deployment must preserve notices
and license files supplied by those packages. Development and CI dependencies are
also governed by their own included licenses.
