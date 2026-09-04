# Contributing

```bash
npm ci
npm run typecheck
npm run lint
npm run format
npm test
npm run build
npm run test:dist       # the built package, imported by name
npm run check:package   # publint and arethetypeswrong
```

`npm run test:coverage` writes a report to `coverage/`.

The protocol documents in the Bellhop repository (PROTOCOL.md,
TRANSPORTS.md, PAIRING.md, LICENSING.md) are normative. Where this library
disagrees with them, the library is wrong; change the library. The JSON
schemas under `test/fixtures` are copies of the normative ones, and a test
fails when they drift.

A change to `Store` needs the conformance suite in `test/store-conformance.ts`
to pass for both shipped stores. A change to the wire format needs a schema
change first.
