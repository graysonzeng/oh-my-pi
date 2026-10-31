# R1–R8 Measurements

## Status

**Engineering verified; live quality / cost wins NOT verified.**
No `claimedLiveWin`.

## D4 wire fixture (`r4-wire-fixture-report.json`)

| View | UTF-8 | est tokens | Jev tokens |
| --- | ---: | ---: | ---: |
| Base | 3065 | 767 | 841 |
| Deduped | 3469 | 867 | 973 |
| Naive dup | 5593 | 1398 | 1645 |
| Saved vs naive | 2124 | — | 672 |

`bytesAfterHandoff`=881 (extract-only, not wire).

## E3 hash/wall (`e3-hash-wallclock-report.json`)

| Scenario | diskReads | saves | wallMs | bytes |
| --- | ---: | ---: | ---: | ---: |
| first_retain_trust_identity | 0 | 1 | 1.02 | 18 |
| verify_by_reread | 1 | 1 | 0.411 | 19 |
| consecutive_identical | 0 | 2 | 0.225 | 17 |
| long_file_trust | 0 | 1 | 0.361 | 84400 |

## Not measured

- Live provider $, false-accept rates, production load beyond artifact microbench
