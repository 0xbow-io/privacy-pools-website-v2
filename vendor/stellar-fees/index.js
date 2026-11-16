// GENERATED from @privacy-pools-v2/stellar-sdk 0.0.0-prerelease.1449fe37-p30.
// Regenerate: bun scripts/stellar/build-fee-module.mjs. See README.md.
// sdk:../src/utils/StellarResourceFee.ts
import { xdr } from "@stellar/stellar-sdk";
var TX_BASE_RESULT_SIZE = 300, TTL_ENTRY_SIZE = 48, INSTRUCTIONS_INCREMENT = 10000n, DATA_SIZE_1KB_INCREMENT = 1024n, MINIMUM_RENT_WRITE_FEE_PER_1KB = 1000n, CODE_ENTRY_RENT_DISCOUNT_FACTOR = 3n, I64_MAX = (1n << 63n) - 1n, I64_MIN = -(1n << 63n), I128_MAX = (1n << 127n) - 1n, I128_MIN = -(1n << 127n), U32_MAX = 0xffffffffn, clampTo = (v, min, max) => v > max ? max : v < min ? min : v, satI64 = (v) => clampTo(v, I64_MIN, I64_MAX), satI128 = (v) => clampTo(v, I128_MIN, I128_MAX), satU32 = (v) => clampTo(v, 0n, U32_MAX), divCeil = (num, den) => {
  let d = den > 0n ? den : 1n;
  return num >= 0n ? (num + d - 1n) / d : -(-num / d);
}, clampFee = (fee) => fee < 0n ? I64_MAX : fee, clampFee128 = (fee) => fee < 0n || fee > I64_MAX ? I64_MAX : fee, perIncrement = (value, rate, increment) => divCeil(satI64(BigInt(value) * rate), increment);
function stellarResourceFee(resources, settings) {
  for (let field of ["instructions", "diskReadEntries", "writeEntries", "diskReadBytes", "writeBytes", "txSizeBytes", "eventsBytes"])
    assertU32(`resources.${field}`, resources[field]);
  let compute = perIncrement(resources.instructions, settings.feeRatePerInstructionsIncrement, INSTRUCTIONS_INCREMENT), readEntries = satI64(settings.feeDiskReadLedgerEntry * BigInt(resources.diskReadEntries)), writeEntries = satI64(settings.feeWriteLedgerEntry * BigInt(resources.writeEntries)), readBytes = perIncrement(resources.diskReadBytes, settings.feeDiskRead1Kb, DATA_SIZE_1KB_INCREMENT), writeBytes = perIncrement(resources.writeBytes, settings.feeWrite1Kb, DATA_SIZE_1KB_INCREMENT), historical = perIncrement(satU32(BigInt(resources.txSizeBytes) + BigInt(TX_BASE_RESULT_SIZE)), settings.feeHistorical1Kb, DATA_SIZE_1KB_INCREMENT), events = perIncrement(resources.eventsBytes, settings.feeContractEvents1Kb, DATA_SIZE_1KB_INCREMENT), bandwidth = perIncrement(resources.txSizeBytes, settings.feeTxSize1Kb, DATA_SIZE_1KB_INCREMENT);
  return { nonRefundable: [readEntries, writeEntries, readBytes, writeBytes, historical, bandwidth].reduce((sum, part) => satI64(sum + part), compute), refundable: events };
}
function stellarRentFeePer1Kb(settings) {
  assertU32("settings.sorobanStateRentFeeGrowthFactor", settings.sorobanStateRentFeeGrowthFactor);
  let low = settings.rentFee1KbSorobanStateSizeLow, high = settings.rentFee1KbSorobanStateSizeHigh, multiplier = clampFee(satI64(high - low)), size = settings.averageSorobanStateSize, target = settings.sorobanStateTargetSizeBytes, fee;
  if (size < target)
    fee = satI64(clampFee128(divCeil(satI128(multiplier * size), target)) + low);
  else {
    let past = satI64(size - target), postTargetFee = clampFee128(divCeil(satI128(satI128(multiplier * past) * BigInt(settings.sorobanStateRentFeeGrowthFactor)), target));
    fee = satI64(high + postTargetFee);
  }
  return fee > MINIMUM_RENT_WRITE_FEE_PER_1KB ? fee : MINIMUM_RENT_WRITE_FEE_PER_1KB;
}
function rentForSizeAndLedgers(isPersistent, size, ledgers, settings, perKb) {
  let denominator = isPersistent ? settings.persistentRentRateDenominator : settings.tempRentRateDenominator;
  return divCeil(satI64(satI64(size * perKb) * ledgers), satI64(DATA_SIZE_1KB_INCREMENT * denominator));
}
function stellarRentFee(changes, settings, currentLedger) {
  assertU32("currentLedger", currentLedger), changes.forEach((e, i) => {
    for (let field of ["oldSizeBytes", "newSizeBytes", "oldLiveUntilLedger", "newLiveUntilLedger"])
      assertU32(`changes[${i}].${field}`, e[field]);
  });
  let perKb = stellarRentFeePer1Kb(settings), current = BigInt(currentLedger), fee = 0n, extended = 0n, extendedKeyBytes = 0n;
  for (let e of changes) {
    let oldUntil = BigInt(e.oldLiveUntilLedger), newUntil = BigInt(e.newLiveUntilLedger), isNew = e.oldSizeBytes === 0 && e.oldLiveUntilLedger === 0, entryFee = 0n, before = isNew ? satU32(current - 1n) : oldUntil;
    newUntil >= before && (entryFee = satI64(entryFee + rentForSizeAndLedgers(e.isPersistent, BigInt(e.newSizeBytes), newUntil - before, settings, perKb))), !isNew && oldUntil >= current && e.newSizeBytes >= e.oldSizeBytes && (entryFee = satI64(entryFee + rentForSizeAndLedgers(e.isPersistent, BigInt(e.newSizeBytes - e.oldSizeBytes), satU32(oldUntil - current + 1n), settings, perKb))), e.isCodeEntry && (entryFee = divCeil(entryFee, CODE_ENTRY_RENT_DISCOUNT_FACTOR)), fee = satI64(fee + entryFee), oldUntil < newUntil && (extended = satI64(extended + 1n), extendedKeyBytes = satU32(extendedKeyBytes + BigInt(TTL_ENTRY_SIZE)));
  }
  return fee = satI64(fee + satI64(settings.feeWriteLedgerEntry * extended)), satI64(fee + perIncrement(extendedKeyBytes, settings.feeWrite1Kb, DATA_SIZE_1KB_INCREMENT));
}
function stellarNewEntriesRent(persistentBytes, temporaryBytes, settings) {
  persistentBytes.forEach((b, i) => assertU32(`persistentBytes[${i}]`, b)), temporaryBytes.forEach((b, i) => assertU32(`temporaryBytes[${i}]`, b)), assertU32("settings.minPersistentTtl", settings.minPersistentTtl), assertU32("settings.minTemporaryTtl", settings.minTemporaryTtl);
  let ledger = 1e6, entry = (bytes, isPersistent) => ({
    isPersistent,
    isCodeEntry: !1,
    oldSizeBytes: 0,
    newSizeBytes: bytes,
    oldLiveUntilLedger: 0,
    newLiveUntilLedger: ledger + (isPersistent ? settings.minPersistentTtl : settings.minTemporaryTtl) - 1
  });
  return stellarRentFee(
    [...persistentBytes.map((b) => entry(b, !0)), ...temporaryBytes.map((b) => entry(b, !1))],
    settings,
    ledger
  );
}
var FEE_SETTING_IDS = [
  "configSettingContractComputeV0",
  "configSettingContractLedgerCostV0",
  "configSettingContractLedgerCostExtV0",
  "configSettingContractHistoricalDataV0",
  "configSettingContractEventsV0",
  "configSettingContractBandwidthV0",
  "configSettingStateArchival",
  "configSettingLiveSorobanStateSizeWindow"
];
function stellarFeeSettingKeys() {
  return FEE_SETTING_IDS.map(
    (id) => xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId[id]() }))
  );
}
function parseStellarFeeSettings(entries, latestLedger) {
  assertU32("latestLedger", latestLedger);
  let byId = /* @__PURE__ */ new Map();
  for (let entry of entries) {
    let data = entry.val;
    data.switch().name === "configSetting" && byId.set(data.configSetting().switch().name, data.configSetting());
  }
  let missing = FEE_SETTING_IDS.filter((id) => !byId.has(id)), window = byId.get("configSettingLiveSorobanStateSizeWindow")?.liveSorobanStateSizeWindow() ?? [];
  if (byId.has("configSettingLiveSorobanStateSizeWindow") && window.length === 0 && missing.push("configSettingLiveSorobanStateSizeWindow"), missing.length > 0) throw new StellarFeeSettingsUnavailable(missing);
  let get = (id) => byId.get(id), big = (v) => BigInt(v.toString()), compute = get("configSettingContractComputeV0").contractCompute(), ledger = get("configSettingContractLedgerCostV0").contractLedgerCost(), ledgerExt = get("configSettingContractLedgerCostExtV0").contractLedgerCostExt(), archival = get("configSettingStateArchival").stateArchivalSettings(), sum = window.reduce((s, v) => s + big(v), 0n);
  return {
    latestLedger,
    feeRatePerInstructionsIncrement: big(compute.feeRatePerInstructionsIncrement()),
    txMaxInstructions: big(compute.txMaxInstructions()),
    feeDiskReadLedgerEntry: big(ledger.feeDiskReadLedgerEntry()),
    feeWriteLedgerEntry: big(ledger.feeWriteLedgerEntry()),
    feeDiskRead1Kb: big(ledger.feeDiskRead1Kb()),
    sorobanStateTargetSizeBytes: big(ledger.sorobanStateTargetSizeBytes()),
    rentFee1KbSorobanStateSizeLow: big(ledger.rentFee1KbSorobanStateSizeLow()),
    rentFee1KbSorobanStateSizeHigh: big(ledger.rentFee1KbSorobanStateSizeHigh()),
    sorobanStateRentFeeGrowthFactor: ledger.sorobanStateRentFeeGrowthFactor(),
    feeWrite1Kb: big(ledgerExt.feeWrite1Kb()),
    feeHistorical1Kb: big(get("configSettingContractHistoricalDataV0").contractHistoricalData().feeHistorical1Kb()),
    feeContractEvents1Kb: big(get("configSettingContractEventsV0").contractEvents().feeContractEvents1Kb()),
    feeTxSize1Kb: big(get("configSettingContractBandwidthV0").contractBandwidth().feeTxSize1Kb()),
    minPersistentTtl: archival.minPersistentTtl(),
    minTemporaryTtl: archival.minTemporaryTtl(),
    persistentRentRateDenominator: big(archival.persistentRentRateDenominator()),
    tempRentRateDenominator: big(archival.tempRentRateDenominator()),
    averageSorobanStateSize: sum / BigInt(window.length)
  };
}
async function readStellarFeeSettings(server) {
  let { entries, latestLedger } = await getLedgerEntriesAcrossSnapshotGap(server, ...stellarFeeSettingKeys());
  return parseStellarFeeSettings(entries, latestLedger);
}

// sdk:../src/utils/StellarRelayPricing.ts
var STELLAR_RECORD_NAMING_ACTIONS = ["relay", "transfer", "yield_withdraw"], shapeKey = ({ n, m }) => `${n}x${m}`;
function addRelayResources(a, b) {
  return {
    instructions: a.instructions + b.instructions,
    diskReadEntries: a.diskReadEntries + b.diskReadEntries,
    writeEntries: a.writeEntries + b.writeEntries,
    diskReadBytes: a.diskReadBytes + b.diskReadBytes,
    writeBytes: a.writeBytes + b.writeBytes,
    txSizeBytes: a.txSizeBytes + b.txSizeBytes,
    eventsBytes: a.eventsBytes + b.eventsBytes,
    newPersistentEntryBytes: [...a.newPersistentEntryBytes, ...b.newPersistentEntryBytes].sort((x, y) => x - y),
    newTemporaryEntryBytes: [...a.newTemporaryEntryBytes, ...b.newTemporaryEntryBytes].sort((x, y) => x - y)
  };
}
function stellarRelayResources(table, action, shape, options = {}) {
  let entry = table.actions[action]?.[shapeKey(shape)];
  if (!entry) throw new StellarRelayShapeUnpriced(action, shape);
  return options.keystoreRecord && STELLAR_RECORD_NAMING_ACTIONS.includes(action) && (entry = addRelayResources(entry, table.keystoreRecord.call)), options.ownerReserve && action === "register_and_relay" && (entry = addRelayResources(entry, table.ownerReserve)), options.contractRecipient ? withContractRecipient(table, entry) : entry;
}
function stellarRelayResourceFee(resources, settings) {
  let { nonRefundable, refundable } = stellarResourceFee(resources, settings), rent = stellarNewEntriesRent(resources.newPersistentEntryBytes, resources.newTemporaryEntryBytes, settings);
  return { nonRefundable, events: refundable, rent, resourceFee: nonRefundable + refundable + rent };
}
function withContractRecipient(table, entry) {
  return addRelayResources(entry, table.contractRecipient);
}

// sdk:../src/constant/stellarRelayResources.json
var stellarRelayResources_default = {
  measuredOn: {
    protocol: 29,
    node: "packages/contracts-stellar/scripts/local-stellar.sh (quickstart-limits-mainnet.p29.json)",
    generator: "packages/stellar-sdk/e2e/ops/relay-pricing.stellar.e2e.test.ts (STELLAR_E2E_RELAY_PRICING=generate)",
    measured: [
      "relay 1x1",
      "relay 2x2",
      "relay 5x5",
      "relay 2x1",
      "relay 1x1 to a contract",
      "register_and_relay 5x5",
      "register_and_relay 5x5 with an owner reserve",
      "transfer 1x2",
      "relay_batch {1x1}",
      "relay_batch {1x1, 1x1}",
      "relay 1x1 naming a keystore record",
      "relay_batch {1x1} naming a keystore record"
    ],
    note: "measured: only the relays listed in `measured`, each a native-XLM payout (a classic asset's trustline writes and longer asset topic are not measured); every other entry is derived from them by the affine model of e2e/harness/relayResourceTable.ts (relay's per-input and per-output steps for every action); actions are for an account (G...) recipient, contractRecipient the delta of the measured contract recipient, keystoreRecord the deltas of the measured relays naming a keystore supersession record (instructions at least 0), ownerReserve the delta of the measured register_and_relay creating its owner's account (instructions at least 0); trees of a fresh deployment; instructions declared (simulated + RPC margin + tree-insert leeway); yield_withdraw carried over from the previous table, not measured over the test-only mock venue",
    date: "2026-10-12"
  },
  actions: {
    relay: {
      "1x1": {
        instructions: 78583129,
        diskReadEntries: 2,
        writeEntries: 8,
        diskReadBytes: 288,
        writeBytes: 2868,
        txSizeBytes: 4048,
        eventsBytes: 1924,
        newPersistentEntryBytes: [
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x2": {
        instructions: 84191957,
        diskReadEntries: 2,
        writeEntries: 9,
        diskReadBytes: 288,
        writeBytes: 3004,
        txSizeBytes: 4792,
        eventsBytes: 2336,
        newPersistentEntryBytes: [
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x3": {
        instructions: 89800785,
        diskReadEntries: 2,
        writeEntries: 10,
        diskReadBytes: 288,
        writeBytes: 3140,
        txSizeBytes: 5536,
        eventsBytes: 2748,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x4": {
        instructions: 95409613,
        diskReadEntries: 2,
        writeEntries: 11,
        diskReadBytes: 288,
        writeBytes: 3276,
        txSizeBytes: 6280,
        eventsBytes: 3160,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x5": {
        instructions: 101018441,
        diskReadEntries: 2,
        writeEntries: 12,
        diskReadBytes: 288,
        writeBytes: 3412,
        txSizeBytes: 7024,
        eventsBytes: 3572,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x1": {
        instructions: 84191957,
        diskReadEntries: 2,
        writeEntries: 9,
        diskReadBytes: 288,
        writeBytes: 3004,
        txSizeBytes: 4232,
        eventsBytes: 1996,
        newPersistentEntryBytes: [
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x2": {
        instructions: 89800785,
        diskReadEntries: 2,
        writeEntries: 10,
        diskReadBytes: 288,
        writeBytes: 3140,
        txSizeBytes: 4976,
        eventsBytes: 2408,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x3": {
        instructions: 95409613,
        diskReadEntries: 2,
        writeEntries: 11,
        diskReadBytes: 288,
        writeBytes: 3276,
        txSizeBytes: 5720,
        eventsBytes: 2820,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x4": {
        instructions: 101018441,
        diskReadEntries: 2,
        writeEntries: 12,
        diskReadBytes: 288,
        writeBytes: 3412,
        txSizeBytes: 6464,
        eventsBytes: 3232,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x5": {
        instructions: 106627269,
        diskReadEntries: 2,
        writeEntries: 13,
        diskReadBytes: 288,
        writeBytes: 3548,
        txSizeBytes: 7208,
        eventsBytes: 3644,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x1": {
        instructions: 89800785,
        diskReadEntries: 2,
        writeEntries: 10,
        diskReadBytes: 288,
        writeBytes: 3140,
        txSizeBytes: 4416,
        eventsBytes: 2068,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x2": {
        instructions: 95409613,
        diskReadEntries: 2,
        writeEntries: 11,
        diskReadBytes: 288,
        writeBytes: 3276,
        txSizeBytes: 5160,
        eventsBytes: 2480,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x3": {
        instructions: 101018441,
        diskReadEntries: 2,
        writeEntries: 12,
        diskReadBytes: 288,
        writeBytes: 3412,
        txSizeBytes: 5904,
        eventsBytes: 2892,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x4": {
        instructions: 106627269,
        diskReadEntries: 2,
        writeEntries: 13,
        diskReadBytes: 288,
        writeBytes: 3548,
        txSizeBytes: 6648,
        eventsBytes: 3304,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x5": {
        instructions: 112236097,
        diskReadEntries: 2,
        writeEntries: 14,
        diskReadBytes: 288,
        writeBytes: 3684,
        txSizeBytes: 7392,
        eventsBytes: 3716,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x1": {
        instructions: 95409613,
        diskReadEntries: 2,
        writeEntries: 11,
        diskReadBytes: 288,
        writeBytes: 3276,
        txSizeBytes: 4600,
        eventsBytes: 2140,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x2": {
        instructions: 101018441,
        diskReadEntries: 2,
        writeEntries: 12,
        diskReadBytes: 288,
        writeBytes: 3412,
        txSizeBytes: 5344,
        eventsBytes: 2552,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x3": {
        instructions: 106627269,
        diskReadEntries: 2,
        writeEntries: 13,
        diskReadBytes: 288,
        writeBytes: 3548,
        txSizeBytes: 6088,
        eventsBytes: 2964,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x4": {
        instructions: 112236097,
        diskReadEntries: 2,
        writeEntries: 14,
        diskReadBytes: 288,
        writeBytes: 3684,
        txSizeBytes: 6832,
        eventsBytes: 3376,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x5": {
        instructions: 117844925,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 3820,
        txSizeBytes: 7576,
        eventsBytes: 3788,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x1": {
        instructions: 101018441,
        diskReadEntries: 2,
        writeEntries: 12,
        diskReadBytes: 288,
        writeBytes: 3412,
        txSizeBytes: 4784,
        eventsBytes: 2212,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x2": {
        instructions: 106627269,
        diskReadEntries: 2,
        writeEntries: 13,
        diskReadBytes: 288,
        writeBytes: 3548,
        txSizeBytes: 5528,
        eventsBytes: 2624,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x3": {
        instructions: 112236097,
        diskReadEntries: 2,
        writeEntries: 14,
        diskReadBytes: 288,
        writeBytes: 3684,
        txSizeBytes: 6272,
        eventsBytes: 3036,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x4": {
        instructions: 117844925,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 3820,
        txSizeBytes: 7016,
        eventsBytes: 3448,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x5": {
        instructions: 123453753,
        diskReadEntries: 2,
        writeEntries: 16,
        diskReadBytes: 288,
        writeBytes: 3956,
        txSizeBytes: 7760,
        eventsBytes: 3860,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      }
    },
    register_and_relay: {
      "1x1": {
        instructions: 117340849,
        diskReadEntries: 2,
        writeEntries: 14,
        diskReadBytes: 288,
        writeBytes: 7836,
        txSizeBytes: 5284,
        eventsBytes: 2688,
        newPersistentEntryBytes: [
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "1x2": {
        instructions: 122949677,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 7972,
        txSizeBytes: 6028,
        eventsBytes: 3100,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "1x3": {
        instructions: 128558505,
        diskReadEntries: 2,
        writeEntries: 16,
        diskReadBytes: 288,
        writeBytes: 8108,
        txSizeBytes: 6772,
        eventsBytes: 3512,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "1x4": {
        instructions: 134167333,
        diskReadEntries: 2,
        writeEntries: 17,
        diskReadBytes: 288,
        writeBytes: 8244,
        txSizeBytes: 7516,
        eventsBytes: 3924,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "1x5": {
        instructions: 139776161,
        diskReadEntries: 2,
        writeEntries: 18,
        diskReadBytes: 288,
        writeBytes: 8380,
        txSizeBytes: 8260,
        eventsBytes: 4336,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "2x1": {
        instructions: 122949677,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 7972,
        txSizeBytes: 5468,
        eventsBytes: 2760,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "2x2": {
        instructions: 128558505,
        diskReadEntries: 2,
        writeEntries: 16,
        diskReadBytes: 288,
        writeBytes: 8108,
        txSizeBytes: 6212,
        eventsBytes: 3172,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "2x3": {
        instructions: 134167333,
        diskReadEntries: 2,
        writeEntries: 17,
        diskReadBytes: 288,
        writeBytes: 8244,
        txSizeBytes: 6956,
        eventsBytes: 3584,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "2x4": {
        instructions: 139776161,
        diskReadEntries: 2,
        writeEntries: 18,
        diskReadBytes: 288,
        writeBytes: 8380,
        txSizeBytes: 7700,
        eventsBytes: 3996,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "2x5": {
        instructions: 145384989,
        diskReadEntries: 2,
        writeEntries: 19,
        diskReadBytes: 288,
        writeBytes: 8516,
        txSizeBytes: 8444,
        eventsBytes: 4408,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "3x1": {
        instructions: 128558505,
        diskReadEntries: 2,
        writeEntries: 16,
        diskReadBytes: 288,
        writeBytes: 8108,
        txSizeBytes: 5652,
        eventsBytes: 2832,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "3x2": {
        instructions: 134167333,
        diskReadEntries: 2,
        writeEntries: 17,
        diskReadBytes: 288,
        writeBytes: 8244,
        txSizeBytes: 6396,
        eventsBytes: 3244,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "3x3": {
        instructions: 139776161,
        diskReadEntries: 2,
        writeEntries: 18,
        diskReadBytes: 288,
        writeBytes: 8380,
        txSizeBytes: 7140,
        eventsBytes: 3656,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "3x4": {
        instructions: 145384989,
        diskReadEntries: 2,
        writeEntries: 19,
        diskReadBytes: 288,
        writeBytes: 8516,
        txSizeBytes: 7884,
        eventsBytes: 4068,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "3x5": {
        instructions: 150993817,
        diskReadEntries: 2,
        writeEntries: 20,
        diskReadBytes: 288,
        writeBytes: 8652,
        txSizeBytes: 8628,
        eventsBytes: 4480,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "4x1": {
        instructions: 134167333,
        diskReadEntries: 2,
        writeEntries: 17,
        diskReadBytes: 288,
        writeBytes: 8244,
        txSizeBytes: 5836,
        eventsBytes: 2904,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "4x2": {
        instructions: 139776161,
        diskReadEntries: 2,
        writeEntries: 18,
        diskReadBytes: 288,
        writeBytes: 8380,
        txSizeBytes: 6580,
        eventsBytes: 3316,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "4x3": {
        instructions: 145384989,
        diskReadEntries: 2,
        writeEntries: 19,
        diskReadBytes: 288,
        writeBytes: 8516,
        txSizeBytes: 7324,
        eventsBytes: 3728,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "4x4": {
        instructions: 150993817,
        diskReadEntries: 2,
        writeEntries: 20,
        diskReadBytes: 288,
        writeBytes: 8652,
        txSizeBytes: 8068,
        eventsBytes: 4140,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "4x5": {
        instructions: 156602645,
        diskReadEntries: 2,
        writeEntries: 21,
        diskReadBytes: 288,
        writeBytes: 8788,
        txSizeBytes: 8812,
        eventsBytes: 4552,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "5x1": {
        instructions: 139776161,
        diskReadEntries: 2,
        writeEntries: 18,
        diskReadBytes: 288,
        writeBytes: 8380,
        txSizeBytes: 6020,
        eventsBytes: 2976,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "5x2": {
        instructions: 145384989,
        diskReadEntries: 2,
        writeEntries: 19,
        diskReadBytes: 288,
        writeBytes: 8516,
        txSizeBytes: 6764,
        eventsBytes: 3388,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "5x3": {
        instructions: 150993817,
        diskReadEntries: 2,
        writeEntries: 20,
        diskReadBytes: 288,
        writeBytes: 8652,
        txSizeBytes: 7508,
        eventsBytes: 3800,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "5x4": {
        instructions: 156602645,
        diskReadEntries: 2,
        writeEntries: 21,
        diskReadBytes: 288,
        writeBytes: 8788,
        txSizeBytes: 8252,
        eventsBytes: 4212,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      },
      "5x5": {
        instructions: 162211473,
        diskReadEntries: 2,
        writeEntries: 22,
        diskReadBytes: 288,
        writeBytes: 8924,
        txSizeBytes: 8996,
        eventsBytes: 4624,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          140,
          144,
          172
        ],
        newTemporaryEntryBytes: [
          76,
          316
        ]
      }
    },
    transfer: {
      "1x1": {
        instructions: 76397341,
        diskReadEntries: 1,
        writeEntries: 5,
        diskReadBytes: 144,
        writeBytes: 2256,
        txSizeBytes: 3616,
        eventsBytes: 1176,
        newPersistentEntryBytes: [
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x2": {
        instructions: 82006169,
        diskReadEntries: 1,
        writeEntries: 6,
        diskReadBytes: 144,
        writeBytes: 2392,
        txSizeBytes: 4360,
        eventsBytes: 1588,
        newPersistentEntryBytes: [
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x3": {
        instructions: 87614997,
        diskReadEntries: 1,
        writeEntries: 7,
        diskReadBytes: 144,
        writeBytes: 2528,
        txSizeBytes: 5104,
        eventsBytes: 2e3,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x4": {
        instructions: 93223825,
        diskReadEntries: 1,
        writeEntries: 8,
        diskReadBytes: 144,
        writeBytes: 2664,
        txSizeBytes: 5848,
        eventsBytes: 2412,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x5": {
        instructions: 98832653,
        diskReadEntries: 1,
        writeEntries: 9,
        diskReadBytes: 144,
        writeBytes: 2800,
        txSizeBytes: 6592,
        eventsBytes: 2824,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x1": {
        instructions: 82006169,
        diskReadEntries: 1,
        writeEntries: 6,
        diskReadBytes: 144,
        writeBytes: 2392,
        txSizeBytes: 3800,
        eventsBytes: 1248,
        newPersistentEntryBytes: [
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x2": {
        instructions: 87614997,
        diskReadEntries: 1,
        writeEntries: 7,
        diskReadBytes: 144,
        writeBytes: 2528,
        txSizeBytes: 4544,
        eventsBytes: 1660,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x3": {
        instructions: 93223825,
        diskReadEntries: 1,
        writeEntries: 8,
        diskReadBytes: 144,
        writeBytes: 2664,
        txSizeBytes: 5288,
        eventsBytes: 2072,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x4": {
        instructions: 98832653,
        diskReadEntries: 1,
        writeEntries: 9,
        diskReadBytes: 144,
        writeBytes: 2800,
        txSizeBytes: 6032,
        eventsBytes: 2484,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x5": {
        instructions: 104441481,
        diskReadEntries: 1,
        writeEntries: 10,
        diskReadBytes: 144,
        writeBytes: 2936,
        txSizeBytes: 6776,
        eventsBytes: 2896,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x1": {
        instructions: 87614997,
        diskReadEntries: 1,
        writeEntries: 7,
        diskReadBytes: 144,
        writeBytes: 2528,
        txSizeBytes: 3984,
        eventsBytes: 1320,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x2": {
        instructions: 93223825,
        diskReadEntries: 1,
        writeEntries: 8,
        diskReadBytes: 144,
        writeBytes: 2664,
        txSizeBytes: 4728,
        eventsBytes: 1732,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x3": {
        instructions: 98832653,
        diskReadEntries: 1,
        writeEntries: 9,
        diskReadBytes: 144,
        writeBytes: 2800,
        txSizeBytes: 5472,
        eventsBytes: 2144,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x4": {
        instructions: 104441481,
        diskReadEntries: 1,
        writeEntries: 10,
        diskReadBytes: 144,
        writeBytes: 2936,
        txSizeBytes: 6216,
        eventsBytes: 2556,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x5": {
        instructions: 110050309,
        diskReadEntries: 1,
        writeEntries: 11,
        diskReadBytes: 144,
        writeBytes: 3072,
        txSizeBytes: 6960,
        eventsBytes: 2968,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x1": {
        instructions: 93223825,
        diskReadEntries: 1,
        writeEntries: 8,
        diskReadBytes: 144,
        writeBytes: 2664,
        txSizeBytes: 4168,
        eventsBytes: 1392,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x2": {
        instructions: 98832653,
        diskReadEntries: 1,
        writeEntries: 9,
        diskReadBytes: 144,
        writeBytes: 2800,
        txSizeBytes: 4912,
        eventsBytes: 1804,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x3": {
        instructions: 104441481,
        diskReadEntries: 1,
        writeEntries: 10,
        diskReadBytes: 144,
        writeBytes: 2936,
        txSizeBytes: 5656,
        eventsBytes: 2216,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x4": {
        instructions: 110050309,
        diskReadEntries: 1,
        writeEntries: 11,
        diskReadBytes: 144,
        writeBytes: 3072,
        txSizeBytes: 6400,
        eventsBytes: 2628,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x5": {
        instructions: 115659137,
        diskReadEntries: 1,
        writeEntries: 12,
        diskReadBytes: 144,
        writeBytes: 3208,
        txSizeBytes: 7144,
        eventsBytes: 3040,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x1": {
        instructions: 98832653,
        diskReadEntries: 1,
        writeEntries: 9,
        diskReadBytes: 144,
        writeBytes: 2800,
        txSizeBytes: 4352,
        eventsBytes: 1464,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x2": {
        instructions: 104441481,
        diskReadEntries: 1,
        writeEntries: 10,
        diskReadBytes: 144,
        writeBytes: 2936,
        txSizeBytes: 5096,
        eventsBytes: 1876,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x3": {
        instructions: 110050309,
        diskReadEntries: 1,
        writeEntries: 11,
        diskReadBytes: 144,
        writeBytes: 3072,
        txSizeBytes: 5840,
        eventsBytes: 2288,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x4": {
        instructions: 115659137,
        diskReadEntries: 1,
        writeEntries: 12,
        diskReadBytes: 144,
        writeBytes: 3208,
        txSizeBytes: 6584,
        eventsBytes: 2700,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x5": {
        instructions: 121267965,
        diskReadEntries: 1,
        writeEntries: 13,
        diskReadBytes: 144,
        writeBytes: 3344,
        txSizeBytes: 7328,
        eventsBytes: 3112,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      }
    },
    yield_withdraw: {
      "1x1": {
        instructions: 97410499,
        diskReadEntries: 2,
        writeEntries: 11,
        diskReadBytes: 288,
        writeBytes: 4156,
        txSizeBytes: 3720,
        eventsBytes: 2632,
        newPersistentEntryBytes: [
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x2": {
        instructions: 103558223,
        diskReadEntries: 2,
        writeEntries: 12,
        diskReadBytes: 288,
        writeBytes: 4292,
        txSizeBytes: 4464,
        eventsBytes: 3044,
        newPersistentEntryBytes: [
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x3": {
        instructions: 109705947,
        diskReadEntries: 2,
        writeEntries: 13,
        diskReadBytes: 288,
        writeBytes: 4428,
        txSizeBytes: 5208,
        eventsBytes: 3456,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x4": {
        instructions: 115853671,
        diskReadEntries: 2,
        writeEntries: 14,
        diskReadBytes: 288,
        writeBytes: 4564,
        txSizeBytes: 5952,
        eventsBytes: 3868,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x5": {
        instructions: 122001395,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 4700,
        txSizeBytes: 6696,
        eventsBytes: 4280,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x1": {
        instructions: 103558223,
        diskReadEntries: 2,
        writeEntries: 12,
        diskReadBytes: 288,
        writeBytes: 4292,
        txSizeBytes: 3904,
        eventsBytes: 2704,
        newPersistentEntryBytes: [
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x2": {
        instructions: 109705947,
        diskReadEntries: 2,
        writeEntries: 13,
        diskReadBytes: 288,
        writeBytes: 4428,
        txSizeBytes: 4648,
        eventsBytes: 3116,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x3": {
        instructions: 115853671,
        diskReadEntries: 2,
        writeEntries: 14,
        diskReadBytes: 288,
        writeBytes: 4564,
        txSizeBytes: 5392,
        eventsBytes: 3528,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x4": {
        instructions: 122001395,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 4700,
        txSizeBytes: 6136,
        eventsBytes: 3940,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x5": {
        instructions: 128149119,
        diskReadEntries: 2,
        writeEntries: 16,
        diskReadBytes: 288,
        writeBytes: 4836,
        txSizeBytes: 6880,
        eventsBytes: 4352,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x1": {
        instructions: 109705947,
        diskReadEntries: 2,
        writeEntries: 13,
        diskReadBytes: 288,
        writeBytes: 4428,
        txSizeBytes: 4088,
        eventsBytes: 2776,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x2": {
        instructions: 115853671,
        diskReadEntries: 2,
        writeEntries: 14,
        diskReadBytes: 288,
        writeBytes: 4564,
        txSizeBytes: 4832,
        eventsBytes: 3188,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x3": {
        instructions: 122001395,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 4700,
        txSizeBytes: 5576,
        eventsBytes: 3600,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x4": {
        instructions: 128149119,
        diskReadEntries: 2,
        writeEntries: 16,
        diskReadBytes: 288,
        writeBytes: 4836,
        txSizeBytes: 6320,
        eventsBytes: 4012,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x5": {
        instructions: 134296843,
        diskReadEntries: 2,
        writeEntries: 17,
        diskReadBytes: 288,
        writeBytes: 4972,
        txSizeBytes: 7064,
        eventsBytes: 4424,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x1": {
        instructions: 115853671,
        diskReadEntries: 2,
        writeEntries: 14,
        diskReadBytes: 288,
        writeBytes: 4564,
        txSizeBytes: 4272,
        eventsBytes: 2848,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x2": {
        instructions: 122001395,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 4700,
        txSizeBytes: 5016,
        eventsBytes: 3260,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x3": {
        instructions: 128149119,
        diskReadEntries: 2,
        writeEntries: 16,
        diskReadBytes: 288,
        writeBytes: 4836,
        txSizeBytes: 5760,
        eventsBytes: 3672,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x4": {
        instructions: 134296843,
        diskReadEntries: 2,
        writeEntries: 17,
        diskReadBytes: 288,
        writeBytes: 4972,
        txSizeBytes: 6504,
        eventsBytes: 4084,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x5": {
        instructions: 140444567,
        diskReadEntries: 2,
        writeEntries: 18,
        diskReadBytes: 288,
        writeBytes: 5108,
        txSizeBytes: 7248,
        eventsBytes: 4496,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x1": {
        instructions: 122001395,
        diskReadEntries: 2,
        writeEntries: 15,
        diskReadBytes: 288,
        writeBytes: 4700,
        txSizeBytes: 4456,
        eventsBytes: 2920,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x2": {
        instructions: 128149119,
        diskReadEntries: 2,
        writeEntries: 16,
        diskReadBytes: 288,
        writeBytes: 4836,
        txSizeBytes: 5200,
        eventsBytes: 3332,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x3": {
        instructions: 134296843,
        diskReadEntries: 2,
        writeEntries: 17,
        diskReadBytes: 288,
        writeBytes: 4972,
        txSizeBytes: 5944,
        eventsBytes: 3744,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x4": {
        instructions: 140444567,
        diskReadEntries: 2,
        writeEntries: 18,
        diskReadBytes: 288,
        writeBytes: 5108,
        txSizeBytes: 6688,
        eventsBytes: 4156,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x5": {
        instructions: 146592291,
        diskReadEntries: 2,
        writeEntries: 19,
        diskReadBytes: 288,
        writeBytes: 5244,
        txSizeBytes: 7432,
        eventsBytes: 4568,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      }
    }
  },
  relayBatch: {
    base: {
      instructions: 25239138,
      diskReadEntries: 2,
      writeEntries: 6,
      diskReadBytes: 288,
      writeBytes: 2596,
      txSizeBytes: 1688,
      eventsBytes: 792,
      newPersistentEntryBytes: [],
      newTemporaryEntryBytes: []
    },
    item: {
      "1x1": {
        instructions: 54499465,
        diskReadEntries: 0,
        writeEntries: 2,
        diskReadBytes: 0,
        writeBytes: 272,
        txSizeBytes: 2976,
        eventsBytes: 1164,
        newPersistentEntryBytes: [
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x2": {
        instructions: 60108293,
        diskReadEntries: 0,
        writeEntries: 3,
        diskReadBytes: 0,
        writeBytes: 408,
        txSizeBytes: 3720,
        eventsBytes: 1576,
        newPersistentEntryBytes: [
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x3": {
        instructions: 65717121,
        diskReadEntries: 0,
        writeEntries: 4,
        diskReadBytes: 0,
        writeBytes: 544,
        txSizeBytes: 4464,
        eventsBytes: 1988,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x4": {
        instructions: 71325949,
        diskReadEntries: 0,
        writeEntries: 5,
        diskReadBytes: 0,
        writeBytes: 680,
        txSizeBytes: 5208,
        eventsBytes: 2400,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "1x5": {
        instructions: 76934777,
        diskReadEntries: 0,
        writeEntries: 6,
        diskReadBytes: 0,
        writeBytes: 816,
        txSizeBytes: 5952,
        eventsBytes: 2812,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x1": {
        instructions: 60108293,
        diskReadEntries: 0,
        writeEntries: 3,
        diskReadBytes: 0,
        writeBytes: 408,
        txSizeBytes: 3160,
        eventsBytes: 1236,
        newPersistentEntryBytes: [
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x2": {
        instructions: 65717121,
        diskReadEntries: 0,
        writeEntries: 4,
        diskReadBytes: 0,
        writeBytes: 544,
        txSizeBytes: 3904,
        eventsBytes: 1648,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x3": {
        instructions: 71325949,
        diskReadEntries: 0,
        writeEntries: 5,
        diskReadBytes: 0,
        writeBytes: 680,
        txSizeBytes: 4648,
        eventsBytes: 2060,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x4": {
        instructions: 76934777,
        diskReadEntries: 0,
        writeEntries: 6,
        diskReadBytes: 0,
        writeBytes: 816,
        txSizeBytes: 5392,
        eventsBytes: 2472,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "2x5": {
        instructions: 82543605,
        diskReadEntries: 0,
        writeEntries: 7,
        diskReadBytes: 0,
        writeBytes: 952,
        txSizeBytes: 6136,
        eventsBytes: 2884,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x1": {
        instructions: 65717121,
        diskReadEntries: 0,
        writeEntries: 4,
        diskReadBytes: 0,
        writeBytes: 544,
        txSizeBytes: 3344,
        eventsBytes: 1308,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x2": {
        instructions: 71325949,
        diskReadEntries: 0,
        writeEntries: 5,
        diskReadBytes: 0,
        writeBytes: 680,
        txSizeBytes: 4088,
        eventsBytes: 1720,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x3": {
        instructions: 76934777,
        diskReadEntries: 0,
        writeEntries: 6,
        diskReadBytes: 0,
        writeBytes: 816,
        txSizeBytes: 4832,
        eventsBytes: 2132,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x4": {
        instructions: 82543605,
        diskReadEntries: 0,
        writeEntries: 7,
        diskReadBytes: 0,
        writeBytes: 952,
        txSizeBytes: 5576,
        eventsBytes: 2544,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "3x5": {
        instructions: 88152433,
        diskReadEntries: 0,
        writeEntries: 8,
        diskReadBytes: 0,
        writeBytes: 1088,
        txSizeBytes: 6320,
        eventsBytes: 2956,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x1": {
        instructions: 71325949,
        diskReadEntries: 0,
        writeEntries: 5,
        diskReadBytes: 0,
        writeBytes: 680,
        txSizeBytes: 3528,
        eventsBytes: 1380,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x2": {
        instructions: 76934777,
        diskReadEntries: 0,
        writeEntries: 6,
        diskReadBytes: 0,
        writeBytes: 816,
        txSizeBytes: 4272,
        eventsBytes: 1792,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x3": {
        instructions: 82543605,
        diskReadEntries: 0,
        writeEntries: 7,
        diskReadBytes: 0,
        writeBytes: 952,
        txSizeBytes: 5016,
        eventsBytes: 2204,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x4": {
        instructions: 88152433,
        diskReadEntries: 0,
        writeEntries: 8,
        diskReadBytes: 0,
        writeBytes: 1088,
        txSizeBytes: 5760,
        eventsBytes: 2616,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "4x5": {
        instructions: 93761261,
        diskReadEntries: 0,
        writeEntries: 9,
        diskReadBytes: 0,
        writeBytes: 1224,
        txSizeBytes: 6504,
        eventsBytes: 3028,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x1": {
        instructions: 76934777,
        diskReadEntries: 0,
        writeEntries: 6,
        diskReadBytes: 0,
        writeBytes: 816,
        txSizeBytes: 3712,
        eventsBytes: 1452,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x2": {
        instructions: 82543605,
        diskReadEntries: 0,
        writeEntries: 7,
        diskReadBytes: 0,
        writeBytes: 952,
        txSizeBytes: 4456,
        eventsBytes: 1864,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x3": {
        instructions: 88152433,
        diskReadEntries: 0,
        writeEntries: 8,
        diskReadBytes: 0,
        writeBytes: 1088,
        txSizeBytes: 5200,
        eventsBytes: 2276,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x4": {
        instructions: 93761261,
        diskReadEntries: 0,
        writeEntries: 9,
        diskReadBytes: 0,
        writeBytes: 1224,
        txSizeBytes: 5944,
        eventsBytes: 2688,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      },
      "5x5": {
        instructions: 99370089,
        diskReadEntries: 0,
        writeEntries: 10,
        diskReadBytes: 0,
        writeBytes: 1360,
        txSizeBytes: 6688,
        eventsBytes: 3100,
        newPersistentEntryBytes: [
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136,
          136
        ],
        newTemporaryEntryBytes: []
      }
    }
  },
  contractRecipient: {
    instructions: 2225948,
    diskReadEntries: -1,
    writeEntries: 0,
    diskReadBytes: -144,
    writeBytes: 80,
    txSizeBytes: 64,
    eventsBytes: -8,
    newPersistentEntryBytes: [
      224
    ],
    newTemporaryEntryBytes: []
  },
  keystoreRecord: {
    call: {
      instructions: 5566265,
      diskReadEntries: 0,
      writeEntries: 0,
      diskReadBytes: 0,
      writeBytes: 0,
      txSizeBytes: 316,
      eventsBytes: 0,
      newPersistentEntryBytes: [],
      newTemporaryEntryBytes: []
    },
    batchItem: {
      instructions: 2311274,
      diskReadEntries: 0,
      writeEntries: 0,
      diskReadBytes: 0,
      writeBytes: 0,
      txSizeBytes: 324,
      eventsBytes: 0,
      newPersistentEntryBytes: [],
      newTemporaryEntryBytes: []
    }
  },
  ownerReserve: {
    instructions: 8819805,
    diskReadEntries: 1,
    writeEntries: 1,
    diskReadBytes: 0,
    writeBytes: 92,
    txSizeBytes: 304,
    eventsBytes: 380,
    newPersistentEntryBytes: [],
    newTemporaryEntryBytes: []
  }
};

// sdk:../src/constant/stellarRelayResources.ts
var STELLAR_RELAY_RESOURCE_TABLE = stellarRelayResources_default;

// sdk:../src/utils/StellarU32.ts
var STELLAR_U32_MAX = 4294967295;
function assertU32(argument, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > STELLAR_U32_MAX)
    throw new InvalidStellarU32(argument, value);
}

// sdk:../src/utils/StellarPreflightSnapshotGap.ts
import { Account, Keypair, rpc as rpc2, xdr as xdr2 } from "@stellar/stellar-sdk";
var STELLAR_PREFLIGHT_SNAPSHOT_GAP_RETRY_MS = 500;
var LEDGER_ENTRIES_GAP_MESSAGE = "could not query captive core: http request failed with non-200 status code (404)";
function isLedgerEntriesSnapshotGap(error) {
  return typeof error == "object" && error !== null && error.code === -32603 && stellarErrorMessage(error) === LEDGER_ENTRIES_GAP_MESSAGE;
}
async function getLedgerEntriesAcrossSnapshotGap(server, ...keys) {
  try {
    return await server.getLedgerEntries(...keys);
  } catch (error) {
    if (!isLedgerEntriesSnapshotGap(error)) throw error;
    return await sleep(STELLAR_PREFLIGHT_SNAPSHOT_GAP_RETRY_MS), server.getLedgerEntries(...keys);
  }
}

// sdk:../src/utils/StellarErrorMessage.ts
function stellarErrorMessage(error) {
  return error instanceof Error || typeof error == "object" && error !== null && "message" in error && typeof error.message == "string" ? error.message : String(error);
}

// sdk:../src/errors/StellarRPCInteractor.ts
var StellarRPCInteractorBaseError = class extends Error {
  /** @param reason - Short description of the error. */
  constructor(reason) {
    super(reason), this.name = "StellarRPCInteractorBaseError";
  }
};
var StellarFeeSettingsUnavailable = class extends StellarRPCInteractorBaseError {
  /** @param missing - The `ConfigSettingId` names that were absent. */
  constructor(missing) {
    super(`The RPC returned no ${missing.join(", ")}: the network's Soroban fee cannot be priced`);
    this.missing = missing;
    this.name = "StellarFeeSettingsUnavailable";
  }
};

// sdk:../src/errors/StellarRelayPricing.ts
var StellarRelayPricingBaseError = class extends Error {
  /** @param reason - Short description of the error. */
  constructor(reason) {
    super(reason), this.name = "StellarRelayPricingBaseError";
  }
}, StellarRelayShapeUnpriced = class extends StellarRelayPricingBaseError {
  /**
   * @param what - The action (`relay`, `register_and_relay`, `transfer`, `yield_withdraw`) or `relay_batch item`.
   * @param shape - The proof shape the table lacks.
   */
  constructor(what, shape) {
    super(`the relay resource table has no ${what} ${shape.n}x${shape.m} entry`);
    this.what = what;
    this.shape = shape;
    this.name = "StellarRelayShapeUnpriced";
  }
};

// sdk:../src/errors/StellarValue.ts
var InvalidStellarU32 = class extends Error {
  /** The argument or field, e.g. `"latestLedger"` or `"changes[0].newSizeBytes"`. */
  argument;
  /** The value refused. */
  value;
  /**
   * @param argument - The argument or field.
   * @param value - The value refused.
   */
  constructor(argument, value) {
    super(`${argument} must be a u32: an integer from 0 to 4294967295, got ${String(value)}`), this.name = "InvalidStellarU32", this.argument = argument, this.value = value;
  }
};

// sdk:../../core-sdk/src/utils/sleep.ts
function sleep(ms) {
  return !Number.isInteger(ms) || ms < 0 || ms > MAX_TIMER_DELAY_MS ? Promise.reject(new InvalidTimerArgument("ms", ms, 0, MAX_TIMER_DELAY_MS)) : new Promise((resolve) => setTimeout(resolve, ms));
}

// sdk:../../core-sdk/src/errors/Timer.ts
var InvalidTimerArgument = class extends Error {
  /**
   * @param argument - The parameter's name.
   * @param value - The refused value.
   * @param min - The smallest accepted value.
   * @param max - The largest accepted value.
   */
  constructor(argument, value, min, max) {
    super(`${argument} must be an integer from ${min} to ${max} (ms), got ${String(value)}`);
    this.argument = argument;
    this.value = value;
    this.min = min;
    this.max = max;
    this.name = "InvalidTimerArgument";
  }
};

// sdk:../../core-sdk/src/schemas/HTTPClient.ts
import { z } from "zod";
var HTTPRequestRetryAttemptsSchema = z.number().int("retryAttempts must be an integer").nonnegative("retryAttempts must be non-negative"), MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
function timerMsSchema(field, min) {
  return z.custom(
    (value) => typeof value == "number" && Number.isInteger(value) && value >= min && value <= MAX_TIMER_DELAY_MS,
    { error: (issue) => `${field} must be an integer from ${min} to ${MAX_TIMER_DELAY_MS} (ms), got ${String(issue.input)}` }
  );
}
var HTTPRequestTimeoutSchema = timerMsSchema("timeout", 1), HTTPClientConfigSchema = z.object({
  timeout: timerMsSchema("timeout", 1).optional().default(15e3),
  retryAttempts: z.number().int("retryAttempts must be an integer").nonnegative("retryAttempts must be non-negative").optional().default(3),
  retryDelay: timerMsSchema("retryDelay", 0).optional().default(500),
  headers: z.record(z.string(), z.string()).optional()
});
export {
  STELLAR_RELAY_RESOURCE_TABLE,
  readStellarFeeSettings,
  stellarRelayResourceFee,
  stellarRelayResources
};
