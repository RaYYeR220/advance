# contracts

Foundry project for the Advance protocol.

## Build

```
forge build
```

## Test

Offline unit and invariant suite (no network access):

```
forge test
```

Fork suite against real Base mainnet USDC (network access required):

```
FOUNDRY_PROFILE=fork forge test --match-contract AgentCard
```

The `fork` profile (see `foundry.toml`) pins the fork to `https://mainnet.base.org` at block
`51403692`, sets the `optimism:holocene` hardfork (works around a Foundry/op-revm panic when
forking Base past that point), and scopes itself to `test/fork/*` so the command above only runs
the fork suite, never the offline unit tests.
