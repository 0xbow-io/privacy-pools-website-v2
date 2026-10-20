//! circomlibjs's own outputs (tests/vectors.json, written by
//! scripts/generate.ts from its WASM Poseidon) for every arity 1..16, through
//! both FFI entry points, plus agreement with light-poseidon for 1..12.

use ark_bn254::Fr;
use light_poseidon::{Poseidon, PoseidonHasher};
use native_poseidon::{hash, parse_element, poseidon_batch_hex, poseidon_hex};

struct Vector {
    inputs: Vec<String>,
    output: String,
}

fn vectors() -> Vec<Vector> {
    let raw: serde_json::Value = serde_json::from_str(include_str!("vectors.json")).unwrap();
    raw.as_array()
        .unwrap()
        .iter()
        .map(|v| Vector {
            inputs: v["inputs"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect(),
            output: v["output"].as_str().unwrap().to_string(),
        })
        .collect()
}

#[test]
fn single_matches_circomlibjs_for_every_arity() {
    let vs = vectors();
    for arity in 1..=16 {
        assert!(vs.iter().filter(|v| v.inputs.len() == arity).count() >= 6, "arity {arity} has vectors");
    }
    for v in &vs {
        assert_eq!(poseidon_hex(v.inputs.concat()).unwrap(), v.output, "inputs {:?}", v.inputs);
    }
}

#[test]
fn batch_matches_circomlibjs_for_every_arity() {
    let vs = vectors();
    for arity in 1..=16usize {
        let group: Vec<&Vector> = vs.iter().filter(|v| v.inputs.len() == arity).collect();
        let input: String = group.iter().map(|v| v.inputs.concat()).collect();
        let expected: String = group.iter().map(|v| v.output.as_str()).collect();
        assert_eq!(poseidon_batch_hex(arity as u32, input).unwrap(), expected, "arity {arity}");
    }
}

#[test]
fn uppercase_hex_is_accepted() {
    let v = &vectors()[0];
    assert_eq!(poseidon_hex(v.inputs.concat().to_uppercase()).unwrap(), v.output);
}

#[test]
fn agrees_with_light_poseidon_for_1_to_12() {
    for v in vectors().iter().filter(|v| v.inputs.len() <= 12) {
        let inputs: Vec<Fr> = v.inputs.iter().map(|x| parse_element(x.as_bytes()).unwrap()).collect();
        let mut light = Poseidon::<Fr>::new_circom(inputs.len()).unwrap();
        assert_eq!(hash(&inputs).unwrap(), light.hash(&inputs).unwrap());
    }
}
