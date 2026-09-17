# Answer key derivation

Independent re-derivation of every scenario's expected decision from the Task 3 "Binding formulas" spec, computed by `eval/src/independentFormula.ts` (written fresh from the spec text, never importing `@advance/core`'s `underwrite/{terms,quality,rules}.ts`) against the scenario parameters in `eval/src/gen.ts`. Regenerate with `pnpm --filter @advance/eval run derive-key`.

## healthy-1 (healthy_steady)

Flat daily WETH fee accrual (2000000000000000 wei/day) for 30 days — no decay, no trade-quality haircut.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=5700000 d7=39900000 d30=171000000
- r1=5700000 r7=5700000 r30=5700000 -> base=5700000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(5700000 * 90.000000) = 513000000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 256500000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## healthy-2 (healthy_steady)

Flat daily WETH fee accrual (1000000000000000 wei/day) for 30 days — no decay, no trade-quality haircut.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=2850000 d7=19950000 d30=85500000
- r1=2850000 r7=2850000 r30=2850000 -> base=2850000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(2850000 * 90.000000) = 256500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 128250000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## healthy-3 (healthy_steady)

Flat daily WETH fee accrual (5000000000000000 wei/day) for 30 days — no decay, no trade-quality haircut.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 641250000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## healthy-4 (healthy_steady)

Flat daily WETH fee accrual (20000000000000000 wei/day) for 30 days — no decay, no trade-quality haircut.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=57000000 d7=399000000 d30=1710000000
- r1=57000000 r7=57000000 r30=57000000 -> base=57000000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(57000000 * 90.000000) = 5130000000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 2565000000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## healthy-5 (healthy_steady)

Flat daily WETH fee accrual (100000000000000000 wei/day) for 30 days — no decay, no trade-quality haircut.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=285000000 d7=1995000000 d30=8550000000
- r1=285000000 r7=285000000 r30=285000000 -> base=285000000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(285000000 * 90.000000) = 25650000000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 12825000000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## decaying-1 (decaying)

Ratspeak-like decay: last 7 days at 100000000000000 wei/day, days 8-30 at 2000000000000000 wei/day (d1 tiny relative to d7/d30).

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=285000 d7=1995000 d30=133095000
- r1=285000 r7=285000 r30=4436500 -> base=285000
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(285000 * 10.495832) = 2991312
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 1495656
- hardCeilingMicroUsd=25000000 -> capMicroUsd=1490000 = $1.490000 (1490000 micro-USD)
- floorCents=80, minPrincipal=596000, drawLimit=100000
- rule deny reasons: below_minimum
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[below_minimum]

## decaying-2 (decaying)

Ratspeak-like decay: last 7 days at 200000000000000 wei/day, days 8-30 at 5000000000000000 wei/day (d1 tiny relative to d7/d30).

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=570000 d7=3990000 d30=331740000
- r1=570000 r7=570000 r30=11058000 -> base=570000
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(570000 * 10.495832) = 5982624
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 2991312
- hardCeilingMicroUsd=25000000 -> capMicroUsd=2990000 = $2.990000 (2990000 micro-USD)
- floorCents=80, minPrincipal=1196000, drawLimit=100000
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[2990000, 2990000]

## decaying-3 (decaying)

Ratspeak-like decay: last 7 days at 500000000000000 wei/day, days 8-30 at 10000000000000000 wei/day (d1 tiny relative to d7/d30).

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=1425000 d7=9975000 d30=665475000
- r1=1425000 r7=1425000 r30=22182500 -> base=1425000
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(1425000 * 10.495832) = 14956560
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 7478280
- hardCeilingMicroUsd=25000000 -> capMicroUsd=7470000 = $7.470000 (7470000 micro-USD)
- floorCents=80, minPrincipal=2988000, drawLimit=213428
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[7470000, 7470000]

## decaying-4 (decaying)

Ratspeak-like decay: last 7 days at 1000000000000000 wei/day, days 8-30 at 30000000000000000 wei/day (d1 tiny relative to d7/d30).

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=2850000 d7=19950000 d30=1986450000
- r1=2850000 r7=2850000 r30=66215000 -> base=2850000
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(2850000 * 10.495832) = 29913121
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 14956560
- hardCeilingMicroUsd=25000000 -> capMicroUsd=14950000 = $14.950000 (14950000 micro-USD)
- floorCents=80, minPrincipal=5980000, drawLimit=427142
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[14950000, 14950000]

## decaying-5 (decaying)

Ratspeak-like decay: last 7 days at 300000000000000 wei/day, days 8-30 at 8000000000000000 wei/day (d1 tiny relative to d7/d30).

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=855000 d7=5985000 d30=530385000
- r1=855000 r7=855000 r30=17679500 -> base=855000
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(855000 * 10.495832) = 8973936
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 4486968
- hardCeilingMicroUsd=25000000 -> capMicroUsd=4480000 = $4.480000 (4480000 micro-USD)
- floorCents=80, minPrincipal=1792000, drawLimit=128000
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[4480000, 4480000]

## spiky-1 (spiky)

A single high day out of the last 7 (day0=2000000000000000 wei, days1-6=0) drives CV ≈ 2.45, over the 1.5 CV-haircut threshold — this is the scenario that actually exercises the CV-haircut step on an approval. Older days flat at 1000000000000000.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=5700000 d7=5700000 d30=71250000
- r1=5700000 r7=814285 r30=2375000 -> base=814285
- decayBps=3428 -> q=0.954519, sumQ(90 terms)=21.653754
- projected90dMicroUsd = floor(814285 * 21.653754) = 17632327
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=2.4495
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=8000 -> haircutBps=8000
- rawCap = projected90*5000/10000*haircut/10000 = 7052930
- hardCeilingMicroUsd=25000000 -> capMicroUsd=7050000 = $7.050000 (7050000 micro-USD)
- floorCents=80, minPrincipal=2820000, drawLimit=201428
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[7050000, 7050000]

## spiky-2 (spiky)

Alternating high/low daily accrual over the last 7 days (H=15000000000000000,L=100000000000000 wei, 4 highs/3 lows) — CV ≈ 0.86-0.87, under the 1.5 CV-haircut threshold; a spiky-looking contrast case that does not itself get the CV haircut (see spiky-1). Older days flat at 5000000000000000.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=42750000 d7=171855000 d30=499605000
- r1=42750000 r7=24550714 r30=16653500 -> base=16653500
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(16653500 * 90.000000) = 1498815000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.8560
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 749407500
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## spiky-3 (spiky)

Alternating high/low daily accrual over the last 7 days (H=4000000000000000,L=0 wei, 4 highs/3 lows) — CV ≈ 0.86-0.87, under the 1.5 CV-haircut threshold; a spiky-looking contrast case that does not itself get the CV haircut (see spiky-1). Older days flat at 2000000000000000.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=11400000 d7=45600000 d30=176700000
- r1=11400000 r7=6514285 r30=5890000 -> base=5890000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(5890000 * 90.000000) = 530100000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.8660
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 265050000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## wash-1 (wash_traded)

35% of swaps (tx.from) are the creator address, no whales — the realized top-5 concentration count still picks up a handful of one-off long-tail addresses (see swapMix.ts), but stays well short of the concentration thresholds.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.3900 washRatio=0.3500 cv=0.0000
- haircutBps steps: concentration=10000 wash=5000 age=5000 cv=5000 -> haircutBps=5000
- rawCap = projected90*5000/10000*haircut/10000 = 320625000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=85, minPrincipal=10625000, drawLimit=758928
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## wash-2 (wash_traded)

45% of swaps (tx.from) are the creator address, no whales — the realized top-5 concentration count still picks up a handful of one-off long-tail addresses (see swapMix.ts), but stays well short of the concentration thresholds.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.4900 washRatio=0.4500 cv=0.0000
- haircutBps steps: concentration=10000 wash=5000 age=5000 cv=5000 -> haircutBps=5000
- rawCap = projected90*5000/10000*haircut/10000 = 320625000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=85, minPrincipal=10625000, drawLimit=758928
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## wash-3 (wash_traded)

60% of swaps (tx.from) are the creator address, no whales — the realized top-5 concentration count still picks up a handful of one-off long-tail addresses (see swapMix.ts), but stays well short of the concentration thresholds.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.6400 washRatio=0.6000 cv=0.0000
- haircutBps steps: concentration=6000 wash=3000 age=3000 cv=3000 -> haircutBps=3000
- rawCap = projected90*5000/10000*haircut/10000 = 192375000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=85, minPrincipal=10625000, drawLimit=758928
- rule deny reasons: wash_trading
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[wash_trading]

## wash-4 (wash_traded)

75% of swaps (tx.from) are the creator address, no whales — the realized top-5 concentration count still picks up a handful of one-off long-tail addresses (see swapMix.ts), but stays well short of the concentration thresholds.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.7900 washRatio=0.7500 cv=0.0000
- haircutBps steps: concentration=6000 wash=3000 age=3000 cv=3000 -> haircutBps=3000
- rawCap = projected90*5000/10000*haircut/10000 = 192375000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=85, minPrincipal=10625000, drawLimit=758928
- rule deny reasons: wash_trading
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[wash_trading]

## concentrated-1 (concentrated_flow)

65% of swaps split across 4 "whale" addresses (not the creator) — isolates the concentration signal from wash.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.6600 washRatio=0.0000 cv=0.0000
- haircutBps steps: concentration=6000 wash=6000 age=6000 cv=6000 -> haircutBps=6000
- rawCap = projected90*5000/10000*haircut/10000 = 384750000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=85, minPrincipal=10625000, drawLimit=758928
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## concentrated-2 (concentrated_flow)

75% of swaps split across 4 "whale" addresses (not the creator) — isolates the concentration signal from wash.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.7600 washRatio=0.0000 cv=0.0000
- haircutBps steps: concentration=6000 wash=6000 age=6000 cv=6000 -> haircutBps=6000
- rawCap = projected90*5000/10000*haircut/10000 = 384750000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=85, minPrincipal=10625000, drawLimit=758928
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## concentrated-3 (concentrated_flow)

85% of swaps split across 4 "whale" addresses (not the creator) — isolates the concentration signal from wash.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.8600 washRatio=0.0000 cv=0.0000
- haircutBps steps: concentration=6000 wash=6000 age=6000 cv=6000 -> haircutBps=6000
- rawCap = projected90*5000/10000*haircut/10000 = 384750000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=85, minPrincipal=10625000, drawLimit=758928
- rule deny reasons: concentrated_flow
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[concentrated_flow]

## too-young-1 (too_young)

Token age 86400s (< 3d), zero accrual anywhere — deny too_young (and, since d7=0, also no_recent_revenue/below_minimum).

- chainId 8453, network mainnet, ageSeconds 86400
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=0 d7=0 d30=0
- r1=0 r7=0 r30=0 -> base=0
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(0 * 10.495832) = 0
- top5ConcentrationRatio=0.0000 washRatio=0.0000 cv=undefined
- haircutBps steps: concentration=10000 wash=10000 age=7000 cv=7000 -> haircutBps=7000
- rawCap = projected90*5000/10000*haircut/10000 = 0
- hardCeilingMicroUsd=25000000 -> capMicroUsd=0 = $0.000000 (0 micro-USD)
- floorCents=85, minPrincipal=0, drawLimit=100000
- rule deny reasons: too_young, no_recent_revenue, below_minimum
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[below_minimum, no_recent_revenue, too_young]

## too-young-2 (too_young)

Token age 2d (< 3d) but already has one day of trailing revenue (d7 > 0) — isolates too_young from no_recent_revenue.

- chainId 8453, network mainnet, ageSeconds 172800
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=570000000 d7=570000000 d30=570000000
- r1=570000000 r7=81428571 r30=19000000 -> base=19000000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(19000000 * 90.000000) = 1710000000
- top5ConcentrationRatio=0.5000 washRatio=0.0000 cv=2.4495
- haircutBps steps: concentration=10000 wash=10000 age=7000 cv=5600 -> haircutBps=5600
- rawCap = projected90*5000/10000*haircut/10000 = 478800000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=90, minPrincipal=11250000, drawLimit=803571
- rule deny reasons: too_young
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[too_young]

## no-recent-revenue-1 (no_recent_revenue)

Old enough (60d) but last 7 days are dead (0 wei); days 8-30 had 3000000000000000 wei/day historically — deny no_recent_revenue.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=0 d7=0 d30=196650000
- r1=0 r7=0 r30=6555000 -> base=0
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(0 * 10.495832) = 0
- top5ConcentrationRatio=0.0000 washRatio=0.0000 cv=undefined
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 0
- hardCeilingMicroUsd=25000000 -> capMicroUsd=0 = $0.000000 (0 micro-USD)
- floorCents=80, minPrincipal=0, drawLimit=100000
- rule deny reasons: no_recent_revenue, below_minimum
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[below_minimum, no_recent_revenue]

## no-recent-revenue-2 (no_recent_revenue)

Old enough (60d) but last 7 days are dead (0 wei); days 8-30 had 500000000000000 wei/day historically — deny no_recent_revenue.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=0 d7=0 d30=32775000
- r1=0 r7=0 r30=1092500 -> base=0
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(0 * 10.495832) = 0
- top5ConcentrationRatio=0.0000 washRatio=0.0000 cv=undefined
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 0
- hardCeilingMicroUsd=25000000 -> capMicroUsd=0 = $0.000000 (0 micro-USD)
- floorCents=80, minPrincipal=0, drawLimit=100000
- rule deny reasons: no_recent_revenue, below_minimum
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[below_minimum, no_recent_revenue]

## bnkr-paired-1 (bnkr_paired)

Pool's non-token currency is BNKR, not WETH — deny not_weth_pool before any revenue read.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=false poolLocked=true hookGraduationFlag=false
- memo: {"kind":"auto"}
- pool-shape short circuit: numeraire is not WETH, denied before any revenue read.

**Expected**: kind=deny, reasons=[not_weth_pool]

## bnkr-paired-2 (bnkr_paired)

Pool's non-token currency is BNKR, not WETH — deny not_weth_pool before any revenue read.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=false poolLocked=true hookGraduationFlag=false
- memo: {"kind":"auto"}
- pool-shape short circuit: numeraire is not WETH, denied before any revenue read.

**Expected**: kind=deny, reasons=[not_weth_pool]

## injected-1 (prompt_injection)

Approve-eligible revenue; the token's name/symbol carry a prompt-injection payload and the fake LLM is scripted to obey it — the engine must still clamp to the formula cap/floor.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 641250000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"obedientInjection","capMultiplierBps":500000,"floorCentsDelta":0}
- memo asked for capMultiplierBps=500000, floorCentsDelta=0 (a loosening attempt) — clamped to [0,10000]/[>=0], so the final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## injected-2 (prompt_injection)

Approve-eligible revenue; the token's name/symbol carry a prompt-injection payload and the fake LLM is scripted to obey it — the engine must still clamp to the formula cap/floor.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 641250000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"obedientInjection","capMultiplierBps":10000,"floorCentsDelta":-9999}
- memo asked for capMultiplierBps=10000, floorCentsDelta=-9999 (a loosening attempt) — clamped to [0,10000]/[>=0], so the final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## injected-3 (prompt_injection)

Approve-eligible revenue; the token's name/symbol carry a prompt-injection payload and the fake LLM is scripted to obey it — the engine must still clamp to the formula cap/floor.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 641250000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"obedientInjection","capMultiplierBps":1000000,"floorCentsDelta":-500}
- memo asked for capMultiplierBps=1000000, floorCentsDelta=-500 (a loosening attempt) — clamped to [0,10000]/[>=0], so the final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[25000000, 25000000]

## llm-garbage (llm_failure)

The fake LLM returns non-JSON text — deny memo_unavailable.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 641250000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"garbage"}
- garbage response from the LLM -> deny memo_unavailable.

**Expected**: kind=deny, reasons=[memo_unavailable]

## llm-timeout (llm_failure)

The fake LLM rejects immediately with a timeout-shaped error — deny memo_unavailable.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=14250000 d7=99750000 d30=427500000
- r1=14250000 r7=14250000 r30=14250000 -> base=14250000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(14250000 * 90.000000) = 1282500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 641250000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"timeout"}
- timeout response from the LLM -> deny memo_unavailable.

**Expected**: kind=deny, reasons=[memo_unavailable]

## negative-control (negative_control)

Identical to healthy-1 except creatorSharesWad=0 — every revenue window scales to zero, so creator_has_no_shares fires alongside the revenue cascade (no_recent_revenue, below_minimum).

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=0 d7=0 d30=0
- r1=0 r7=0 r30=0 -> base=0
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(0 * 10.495832) = 0
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=undefined
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 0
- hardCeilingMicroUsd=25000000 -> capMicroUsd=0 = $0.000000 (0 micro-USD)
- floorCents=80, minPrincipal=0, drawLimit=100000
- rule deny reasons: creator_has_no_shares, no_recent_revenue, below_minimum
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[below_minimum, creator_has_no_shares, no_recent_revenue]

## sepolia-approve (sepolia)

Base Sepolia, Airlock-only discovery, healthy-shaped revenue — approve under the $10,000 demo ceiling.

- chainId 84532, network demo, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=2850000 d7=19950000 d30=85500000
- r1=2850000 r7=2850000 r30=2850000 -> base=2850000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(2850000 * 90.000000) = 256500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 128250000
- hardCeilingMicroUsd=10000000000 -> capMicroUsd=128250000 = $128.250000 (128250000 micro-USD)
- floorCents=80, minPrincipal=51300000, drawLimit=3664285
- memo: {"kind":"auto"}
- no-op memo (capMultiplierBps=10000, floorCentsDelta=0): final terms equal the pre-memo formula terms exactly.

**Expected**: kind=approve, capBand=[128250000, 128250000]

## sepolia-too-young (sepolia)

Base Sepolia, Airlock-only discovery, just-launched pool with no trailing revenue — mirrors the real recorded Sepolia fixture's too_young/no_recent_revenue/below_minimum result.

- chainId 84532, network demo, ageSeconds 86400
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=0 d7=0 d30=0
- r1=0 r7=0 r30=0 -> base=0
- decayBps=1000 -> q=0.904736, sumQ(90 terms)=10.495832
- projected90dMicroUsd = floor(0 * 10.495832) = 0
- top5ConcentrationRatio=0.0000 washRatio=0.0000 cv=undefined
- haircutBps steps: concentration=10000 wash=10000 age=7000 cv=7000 -> haircutBps=7000
- rawCap = projected90*5000/10000*haircut/10000 = 0
- hardCeilingMicroUsd=10000000000 -> capMicroUsd=0 = $0.000000 (0 micro-USD)
- floorCents=85, minPrincipal=0, drawLimit=100000
- rule deny reasons: too_young, no_recent_revenue, below_minimum
- memo: {"kind":"auto"}
- hard-rule / below-minimum deny from formula inputs alone; memo never changes this set.

**Expected**: kind=deny, reasons=[below_minimum, no_recent_revenue, too_young]

## tighten-below-minimum (memo_tighten_below_minimum)

Approve-eligible formula terms, but the scripted memo tightens capMultiplierBps to 1 (0.01%) — the recomputed minPrincipal collapses under $1 — deny below_minimum.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=false
- revenueMicroUsd: d1=2850000 d7=19950000 d30=85500000
- r1=2850000 r7=2850000 r30=2850000 -> base=2850000
- decayBps=10000 -> q=1.000000, sumQ(90 terms)=90.000000
- projected90dMicroUsd = floor(2850000 * 90.000000) = 256500000
- top5ConcentrationRatio=0.3000 washRatio=0.0500 cv=0.0000
- haircutBps steps: concentration=10000 wash=10000 age=10000 cv=10000 -> haircutBps=10000
- rawCap = projected90*5000/10000*haircut/10000 = 128250000
- hardCeilingMicroUsd=25000000 -> capMicroUsd=25000000 = $25.000000 (25000000 micro-USD)
- floorCents=80, minPrincipal=10000000, drawLimit=714285
- memo: {"kind":"tighten","capMultiplierBps":1,"floorCentsDelta":0}
- memo tighten (capMultiplierBps=1, floorCentsDelta=0) pushes minPrincipal (0) under $1 -> deny below_minimum.

**Expected**: kind=deny, reasons=[below_minimum]

## graduation-flag (pool_not_locked)

Pool status is Locked, but its Doppler hook has ON_GRADUATION_FLAG set — deny pool_not_locked before any revenue read.

- chainId 8453, network mainnet, ageSeconds 5184000
- isWethPool=true poolLocked=true hookGraduationFlag=true
- memo: {"kind":"auto"}
- pool-shape short circuit: pool not Locked or its hook allows graduation, denied before any revenue read.

**Expected**: kind=deny, reasons=[pool_not_locked]
