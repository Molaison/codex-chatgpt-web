# Historical evidence archive

CONTRIBUTING.md excludes generated logs from Git. The inherited MOL-184 and MOL-185 raw execution output is preserved byte-for-byte in the companion review artifact `mol184185-inherited-logs-20261017.tar.gz` (SHA-256 `55bd088271a3e166e1a0574b6f8790b4723a5214db4ea8e5c37f6ad78485e44d`, 50613 bytes). Obtain it from this change's review handoff; there is no public download URL recorded here. Archive entries retain their original repository-relative paths. `archive:` references in the historical documents refer to these entries.

The archive preserves failures and previous version boundaries; it is not evidence that the current candidate passed. Source diagnostics (`dot-*.ts.txt`, `receipt-memory-integration.test.ts.txt`), canary scripts, manifests, hash indices, and the manually written failure classification remain in Git. The mixed final build log is archived in full; its content hashes are also retained in `docs/mol185-evidence/final-source-hashes.txt`.

For current CPR identity behavior and reproducible checks, see [MOL-189](../mol189-cpr-identity.md). Historical reproduction commands and the unchanged eleven-case diagnostic remain in [admission evidence](mol-184/admission/README.md); MOL-185 commands remain in [network validation](../mol185-network-validation.md).

## Archived entry hashes

| Entry | SHA-256 |
| --- | --- |
| `docs/evidence/mol-184/admission/after-eight.log` | `769df2cb86aa4f1c90a537d5cea196ddab498f8f88c8d36457542937d23fcd7c` |
| `docs/evidence/mol-184/admission/after-eleven.log` | `21ba2b8adc958b935e355617a48014f60da01d8c1626752c0fa0a0b3858b4cef` |
| `docs/evidence/mol-184/admission/after-proof.log` | `247abad337ce37a5992444079e7af6fd46754b63f9dd15f44f62b49161789274` |
| `docs/evidence/mol-184/admission/after-steer.log` | `6861b1f622ac7a16d966a79b3e22669736fe5bc8880fb58ff678db0448f20aaf` |
| `docs/evidence/mol-184/admission/after-targets.log` | `17300a386aa80a514dea13dbdbcfe618032973362c19509b7418d074e8eb6e0f` |
| `docs/evidence/mol-184/admission/baseline-eight.log` | `34e6760be99d781c4cb458a6a179af0d118258188aaccaa3939a5104d5f7542b` |
| `docs/evidence/mol-184/admission/baseline-ephemeral-path-failure.log` | `a750da758e622a7980792d1911ce5c5de0ed772a665d0246fe3fc6a7b217950c` |
| `docs/evidence/mol-184/admission/capacity-boundary.log` | `944741443fef3ae38ee49df6d4bd0b4eb20c94381e78148a683647dc7cf76e23` |
| `docs/evidence/mol-184/admission/independent-after-eight.log` | `81b3f96e588f341bf19a5b0600d6c5d4a2294e56e9aa7cf4e9db28e38ca44418` |
| `docs/evidence/mol-184/admission/independent-baseline-eight.log` | `f376577b3877bb2337534cf838f97ea70299a007747a919809aa359d092cea06` |
| `docs/evidence/mol-184/admission/independent-delta-steer.log` | `0a261785298ede695399be3935bf905a178ef1974a18c2cd240feffdb4372039` |
| `docs/evidence/mol-184/admission/independent-focused.log` | `aeccf33f142a94784c532d40b5ee89d7cc509371c4a6a7a3bd79775bf541bb74` |
| `docs/evidence/mol-184/admission/independent-original-eleven.log` | `c1567246f42e1e616482edef1f566cf90f4b79bac25ccc09b813a64d70444a6e` |
| `docs/evidence/mol-184/admission/independent-typecheck.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/evidence/mol-184/admission/repo-drain.log` | `684bfb251326781c8b233cda170cb72e4c18e794c76c9bd6ca85841319a956e8` |
| `docs/evidence/mol-184/admission/repo-focused.log` | `f2629f8699e9df1e389448ff7b48b831be9249fad985d44b8d419e917b60335a` |
| `docs/evidence/mol-184/admission/repo-pool-focused.log` | `3cc016137e2b52249d6de2b24cc8465e27bf5303f4b352af97d5f40e4ec4692a` |
| `docs/evidence/mol-184/admission/risk-review.log` | `1e5317f4e3d6f9be0e059050c960933cb03b475db90945c36cbb63455d9d4a04` |
| `docs/evidence/mol-184/admission/typecheck-final.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/evidence/mol-184/admission/typecheck.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/evidence/mol-184/baseline-expiry.log` | `32721e52482e042824aa4336e075b5b1849624b205bc05afc6f42ea2de6e0c80` |
| `docs/evidence/mol-184/candidate-expiry.log` | `b254c16c07afc75dc5623d6c814137a86033d89617b1fe824e66abea2a77e18d` |
| `docs/evidence/mol-184/candidate-mapping.log` | `933995df696bf5beaabc797698a9f5668d3b78c006442772f5e7a03355f51573` |
| `docs/evidence/mol-184/identity-guard/guard-pr6-focused.log` | `5527dba054e6969b47a96d5770e5b01c7fb7e6bd139bb6e29c9391feefc6e452` |
| `docs/evidence/mol-184/identity-guard/guard-pr6-typecheck.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/evidence/mol-184/identity-guard/guard-red.log` | `a86b37c0041b721da1f66f9d5718937049cb1615d5983f1acc837f7544631ed4` |
| `docs/evidence/mol-184/receipt-budget-focused.log` | `0e13531f11a3c5a4cee2baea49fc85c2b3cdacc36447865d80745eef75b16da8` |
| `docs/evidence/mol-184/receipt-budget-single.log` | `b361170ffce9a29b17bf04c17166cb10d2d69035428b8da91c5367297bc15614` |
| `docs/evidence/mol-184/receipt-budget-types.log` | `e576e4d30f5392d9dec436980fdafe8b9b900832b6fe6adc3043841047674093` |
| `docs/evidence/mol-184/receipt-candidate-suite.log` | `59eb50d032ba1bbd7617a14cd54cc54527e0dbdf7833b20f4a840aefad172a54` |
| `docs/evidence/mol-184/receipt-candidate-types.log` | `e576e4d30f5392d9dec436980fdafe8b9b900832b6fe6adc3043841047674093` |
| `docs/evidence/mol-184/receipt-coordinator-baseline-observations.json` | `6b961f8e0f7ee5696b5915b5cd8a40de0db5968ea5d6be8ed1279d47ce937e50` |
| `docs/evidence/mol-184/receipt-coordinator-baseline.log` | `06e4283dbc1e3b65837c6516eaa72d116155ad2773daf0c94caa39f23bfcddc3` |
| `docs/evidence/mol-184/receipt-coordinator-repeat-observations.json` | `fedf6c1fe4b45dc8700bfe62c21b9bfeed21533d1c09a529792a491f4882708c` |
| `docs/evidence/mol-184/receipt-coordinator-repeat.log` | `9b33b6a6a6077e23429f4bd7b53704154c5113f459fd9ab5a2b12085260781ea` |
| `docs/evidence/mol-184/receipt-intermediate-baseline-memory-observations.json` | `be415f923cb3290a82e7f02b7b279e20d5869ad75969fa888df774b0b7aac050` |
| `docs/evidence/mol-184/receipt-intermediate-baseline-memory-run.log` | `fdc1fa4cc183e05507f45f3ba109cc7c6178c5d578ee2070b47dc579340d6ed2` |
| `docs/evidence/mol-184/receipt-intermediate-candidate-memory-observations.json` | `004e9eb16eda46948ee9b154c9280da7c2ca437b814dcd9379aa3e275729ea9b` |
| `docs/evidence/mol-184/receipt-intermediate-candidate-memory-run.log` | `3b3252c667a92e2a9a78c7ed3ef5124b4ab66ff06a566b62aa424195544e338a` |
| `docs/evidence/mol-184/receipt-related.log` | `3316f445e122247e16981286ac810c16d50c8066e882847d274506c4fb5be52e` |
| `docs/evidence/mol-184/receipt-three-regressions-base.jsonl` | `116805a8546164e192bbb0240a8dac45743b1013913e1ee73960eebabe732208` |
| `docs/evidence/mol-184/receipt-three-regressions-candidate.jsonl` | `d640962cdb70cf5354e3701b4e5e4527fd5d163ca07427a173693f3d946bfef7` |
| `docs/evidence/mol-184/receipt-three-regressions-fixed.jsonl` | `5850c8ce7b71cbc720a9bf097528c52a31e45334c6b6e64fa54d72d67421d9fc` |
| `docs/evidence/mol-184/receipt-three-regressions-focused.log` | `1770f763b4ac1a495d4e13f03cad261c1edecd93da24ed459dc9070dbb0182af` |
| `docs/evidence/mol-184/receipt-three-regressions-red.log` | `8eae9e0e11c842929db7e5bbab7793edb6e56dba2ff2db06d5db0d2bb20c20a6` |
| `docs/evidence/mol-184/receipt-three-regressions-related.log` | `2ab027b5c23dfd55c7b7712b250d1258b72e3e1950841e9096273a79135f859e` |
| `docs/evidence/mol-184/receipt-three-regressions-types.log` | `e576e4d30f5392d9dec436980fdafe8b9b900832b6fe6adc3043841047674093` |
| `docs/evidence/mol-184/receipt-two-pool-mutation-red.log` | `29d5ee8c975e48ef7fcc45dd48d56e3cc238616695827cee156275d5c8e15bb4` |
| `docs/evidence/mol-184/receipt-two-pool.log` | `fc002b9f45184a104b04544dfce14646e0aece38ea9b42ad900fa54ae2711718` |
| `docs/mol185-evidence/event-replay-identity-after.txt` | `0711b3262754f7ac99fdfa272f72022743df4426952c520403595f0c8228b078` |
| `docs/mol185-evidence/event-replay-identity-before.txt` | `871701eea3179e7116287ade424da5511b149b54ad06f5188af841cca75e1e3a` |
| `docs/mol185-evidence/event-replay-identity-recovery-metrics.txt` | `994c9c9eb5eeed2f5cc1228e2704ca5f2df71fbd28b464e30186af76e374f10d` |
| `docs/mol185-evidence/event-replay-identity-regression.txt` | `1719e20fcda5a85d0855a0e41b1a4f508db0604afa5931e51998ea1dce22e7ca` |
| `docs/mol185-evidence/final-build.txt` | `39497eb02ddcbf801a292df20be751d95d8d6c00fb353709bf44a10d3f897f3d` |
| `docs/mol185-evidence/json-terminal-after.txt` | `20993a09cd8ba011d9e1b7d92ff30d66e4b889adc7e4dc115cbd9fd9209689c9` |
| `docs/mol185-evidence/json-terminal-before.txt` | `4d06fd06f83452a3ca74912c6716573ba685fa6a312c19d32101a74d14fa938e` |
| `docs/mol185-evidence/live-canary-mock.txt` | `89fe35fcd96b56c88642305f441211f5813bec50e4a01965ce52acfda8d04469` |
| `docs/mol185-evidence/pristine-existing-failures.txt` | `c313bb26fb07813f54ac9b43c98a21b0af6e582d9856415e638bd140e9790ee5` |
| `docs/mol185-evidence/pristine-http-harness.txt` | `7a9643771cc70729d53bd55aab19ab9ece806adc4cd09e2ba3b651ea20852c59` |
| `docs/mol185-evidence/provider-reset-after.txt` | `e735a611b9e409be9b93d9cc33a48ff0e3a34afa24fadd8e609cf3c32a9e062f` |
| `docs/mol185-evidence/provider-reset-before.txt` | `f0f343bd34088b26403e074db7673eab649cc0f80c7d80babb239bf29c68b846` |
| `docs/mol185-evidence/stage2-broker-lifecycle-focused.txt` | `d2110d971ddbb8958fe4d43cca4be410b12ae84c45e402bf484e7ef91e14b75d` |
| `docs/mol185-evidence/stage2-combined-independent.txt` | `420e8e31eb8a35a6c3ccf6e0615299c46070337a37d913cfc2fa33ef991620d8` |
| `docs/mol185-evidence/stage2-observation-adjacent.txt` | `063e4e6dbbe0da44a190e4e5df9c1e71e1a4a72c469c22555e170b295aae3bed` |
| `docs/mol185-evidence/stage2-observation-after.txt` | `55a240471022f259e90c12df099d144f4edd52017d97dc38be2bbe1dfb6ce0de` |
| `docs/mol185-evidence/stage2-observation-before.txt` | `ead16eb6515b2da8a9e2a318c60ed1bcd1a0f78ae482fb22e02ced265f500438` |
| `docs/mol185-evidence/stage2-observation-controls.txt` | `ffdbe5c3ebe3c3a969c05115a271eca27a3a01b73ce3c56a38dd36b6ad700270` |
| `docs/mol185-evidence/stage2-runtime-build-isolated.txt` | `b1f484fa0399303c1361201c6d5e7675cce97b8931a9541ce0ac1e64ecc116b4` |
| `docs/mol185-evidence/stage2-runtime-build.txt` | `fe58719f6890b867bf1c156e2253852df89766e53989744e104d3b915584a6e9` |
| `docs/mol185-evidence/stage2-tool-ack-after.txt` | `242c68be04b5c718e3b8caf73c5dbd4b1d21221a15219d4b126739ba448e2bfc` |
| `docs/mol185-evidence/stage2-tool-ack-before.txt` | `7779ba3796e3cc8bd57a335cadfd53d9836edc51d0f1bd19802fd01ba80b6e85` |
| `docs/mol185-evidence/submission-retry-after.txt` | `685e2b10c965ec4246509fe1f93f56841b5ad2ba653a40cc6b0b23eed12d23e6` |
| `docs/mol185-evidence/submission-retry-before.txt` | `358a5bb3420246f4a85ba1c59fbd9d9bb41abfebdb0b9668e46426672d64f9fc` |
| `docs/mol185-evidence/submission-retry-expanded-after.txt` | `685e2b10c965ec4246509fe1f93f56841b5ad2ba653a40cc6b0b23eed12d23e6` |
| `docs/mol185-evidence/submission-retry-legacy-after.txt` | `ee80d61e01b14d30e041d1e8b074ab9be2f8df04d1591a367bcc3e2e12b6e5d0` |
