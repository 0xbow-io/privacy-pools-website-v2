//! circomlib's Poseidon over BN254, for the ppv2 mobile app.
//!
//! Hermes has no WebAssembly, so circomlibjs cannot run on the phone, and a
//! pure-BigInt Poseidon is slow where thousands of hashes run (Merkle trees,
//! keystore leaves, note discovery). This is the same function, natively:
//! circomlibjs's optimized rounds (`poseidon_opt.js`) over its own constants,
//! with arkworks' BN254 scalar field doing the arithmetic.
//!
//! The FFI surface is hex in, hex out: each field element is exactly 64 hex
//! characters (32 bytes big-endian), elements concatenated with no separator.
//! One string each way is the cheapest thing to move across the React Native
//! bridge, and a batch call hashes many same-arity inputs in one crossing.

uniffi::setup_scaffolding!();

use std::sync::OnceLock;

use ark_bn254::Fr;
use ark_ff::{BigInteger, Field, PrimeField, Zero};

pub const MAX_INPUTS: usize = 16;
const N_ROUNDS_F: usize = 8;
const N_ROUNDS_P: [usize; MAX_INPUTS] = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68];
const MAX_T: usize = MAX_INPUTS + 1;
const HEX: usize = 64;

/// circomlibjs's `poseidon_constants_opt.json`, written by
/// `scripts/generate.ts`: per t = 2..17, C then S then M then P, each element
/// 32 bytes little-endian.
static CONSTANTS: &[u8] = include_bytes!("constants.bin");

#[derive(Debug, thiserror::Error, uniffi::Error, PartialEq, Eq)]
pub enum PoseidonError {
    #[error("Poseidon: {arity} inputs are not supported (1 to 16)")]
    Arity { arity: u32 },
    #[error("Poseidon: {reason}")]
    Input { reason: String },
}

struct Params {
    t: usize,
    rp: usize,
    c: Vec<Fr>,
    s: Vec<Fr>,
    m: Vec<Fr>,
    p: Vec<Fr>,
}

fn sizes(t: usize, rp: usize) -> [usize; 4] {
    [t * N_ROUNDS_F + rp, rp * (2 * t - 1), t * t, t * t]
}

fn params(arity: usize) -> &'static Params {
    static PARAMS: [OnceLock<Params>; MAX_INPUTS] = [const { OnceLock::new() }; MAX_INPUTS];
    PARAMS[arity - 1].get_or_init(|| {
        let mut offset = 0;
        for a in 1..arity {
            offset += sizes(a + 1, N_ROUNDS_P[a - 1]).iter().sum::<usize>();
        }
        let t = arity + 1;
        let rp = N_ROUNDS_P[arity - 1];
        let mut take = |n: usize| -> Vec<Fr> {
            let v = CONSTANTS[offset * 32..(offset + n) * 32]
                .chunks_exact(32)
                .map(Fr::from_le_bytes_mod_order)
                .collect();
            offset += n;
            v
        };
        let [nc, ns, nm, np] = sizes(t, rp);
        Params { t, rp, c: take(nc), s: take(ns), m: take(nm), p: take(np) }
    })
}

#[inline(always)]
fn pow5(a: Fr) -> Fr {
    let a2 = a.square();
    a * a2.square()
}

/// state[i] = sum_j matrix[j][i] * state[j], matrix row-major t*t.
#[inline(always)]
fn mix(state: &mut [Fr; MAX_T], t: usize, matrix: &[Fr]) {
    let mut out = [Fr::zero(); MAX_T];
    for (i, o) in out.iter_mut().enumerate().take(t) {
        let mut acc = Fr::zero();
        for j in 0..t {
            acc += matrix[j * t + i] * state[j];
        }
        *o = acc;
    }
    state[..t].copy_from_slice(&out[..t]);
}

/// Poseidon of 1 to 16 field elements, identical to circomlibjs's
/// `poseidon(inputs)` followed by `F.toObject`.
pub fn hash(inputs: &[Fr]) -> Result<Fr, PoseidonError> {
    let n = inputs.len();
    if n == 0 || n > MAX_INPUTS {
        return Err(PoseidonError::Arity { arity: n as u32 });
    }
    let Params { t, rp, c, s, m, p } = params(n);
    let (t, rp) = (*t, *rp);
    let half = N_ROUNDS_F / 2;

    let mut state = [Fr::zero(); MAX_T];
    state[1..t].copy_from_slice(inputs);
    for i in 0..t {
        state[i] += c[i];
    }
    for r in 0..half - 1 {
        for i in 0..t {
            state[i] = pow5(state[i]) + c[(r + 1) * t + i];
        }
        mix(&mut state, t, m);
    }
    for i in 0..t {
        state[i] = pow5(state[i]) + c[half * t + i];
    }
    mix(&mut state, t, p);

    let base = (half + 1) * t;
    let w = 2 * t - 1;
    for r in 0..rp {
        state[0] = pow5(state[0]) + c[base + r];
        let row = &s[w * r..w * (r + 1)];
        let mut s0 = Fr::zero();
        for j in 0..t {
            s0 += row[j] * state[j];
        }
        for k in 1..t {
            state[k] += state[0] * row[t + k - 1];
        }
        state[0] = s0;
    }

    for r in 0..half - 1 {
        for i in 0..t {
            state[i] = pow5(state[i]) + c[base + rp + r * t + i];
        }
        mix(&mut state, t, m);
    }
    for i in 0..t {
        state[i] = pow5(state[i]);
    }
    mix(&mut state, t, m);
    Ok(state[0])
}

fn nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 64 hex characters, big-endian, any value below 2^256 (reduced mod p, as
/// circomlibjs's F.e does).
pub fn parse_element(hex: &[u8]) -> Result<Fr, PoseidonError> {
    if hex.len() != HEX {
        return Err(PoseidonError::Input { reason: format!("an element is {HEX} hex characters, got {}", hex.len()) });
    }
    let mut bytes = [0u8; 32];
    for (i, pair) in hex.chunks_exact(2).enumerate() {
        match (nibble(pair[0]), nibble(pair[1])) {
            (Some(hi), Some(lo)) => bytes[i] = hi << 4 | lo,
            _ => return Err(PoseidonError::Input { reason: "not a hex string".into() }),
        }
    }
    Ok(Fr::from_be_bytes_mod_order(&bytes))
}

const DIGITS: &[u8; 16] = b"0123456789abcdef";

pub fn push_element(out: &mut String, x: Fr) {
    let bytes = x.into_bigint().to_bytes_be();
    let mut buf = [0u8; HEX];
    for (i, b) in bytes.iter().enumerate() {
        buf[2 * i] = DIGITS[(b >> 4) as usize];
        buf[2 * i + 1] = DIGITS[(b & 15) as usize];
    }
    // Only ASCII hex digits were written.
    out.push_str(std::str::from_utf8(&buf).expect("hex is ASCII"));
}

fn hash_chunk(chunk: &[u8], arity: usize) -> Result<Fr, PoseidonError> {
    let mut inputs = [Fr::zero(); MAX_INPUTS];
    for (i, el) in chunk.chunks_exact(HEX).enumerate() {
        inputs[i] = parse_element(el)?;
    }
    hash(&inputs[..arity])
}

/// One hash. `inputs_hex` is 1 to 16 elements of 64 hex characters each,
/// concatenated; the result is 64 hex characters.
#[uniffi::export]
pub fn poseidon_hex(inputs_hex: String) -> Result<String, PoseidonError> {
    let bytes = inputs_hex.as_bytes();
    if bytes.len() % HEX != 0 {
        return Err(PoseidonError::Input { reason: format!("length {} is not a multiple of {HEX}", bytes.len()) });
    }
    let arity = bytes.len() / HEX;
    if arity == 0 || arity > MAX_INPUTS {
        return Err(PoseidonError::Arity { arity: arity as u32 });
    }
    let mut out = String::with_capacity(HEX);
    push_element(&mut out, hash_chunk(bytes, arity)?);
    Ok(out)
}

/// Many hashes of the same arity in one call. `inputs_hex` is the inputs of
/// every hash back to back (count * arity elements); the result is count
/// outputs of 64 hex characters, in order.
#[uniffi::export]
pub fn poseidon_batch_hex(arity: u32, inputs_hex: String) -> Result<String, PoseidonError> {
    let arity_usize = arity as usize;
    if arity_usize == 0 || arity_usize > MAX_INPUTS {
        return Err(PoseidonError::Arity { arity });
    }
    let bytes = inputs_hex.as_bytes();
    let stride = HEX * arity_usize;
    if bytes.len() % stride != 0 {
        return Err(PoseidonError::Input { reason: format!("length {} is not a multiple of {stride} ({arity} inputs)", bytes.len()) });
    }
    let mut out = String::with_capacity(bytes.len() / arity_usize);
    for chunk in bytes.chunks_exact(stride) {
        push_element(&mut out, hash_chunk(chunk, arity_usize)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_arity_and_input() {
        assert_eq!(poseidon_hex(String::new()), Err(PoseidonError::Arity { arity: 0 }));
        assert_eq!(poseidon_hex("0".repeat(64 * 17)), Err(PoseidonError::Arity { arity: 17 }));
        assert!(poseidon_hex("0".repeat(63)).is_err());
        assert!(poseidon_hex(format!("{}g", "0".repeat(63))).is_err());
        assert_eq!(poseidon_batch_hex(0, String::new()), Err(PoseidonError::Arity { arity: 0 }));
        assert!(poseidon_batch_hex(2, "0".repeat(64 * 3)).is_err());
        assert_eq!(poseidon_batch_hex(2, String::new()), Ok(String::new()));
    }

    #[test]
    fn constants_cover_every_arity_exactly() {
        let total: usize = (1..=MAX_INPUTS).map(|a| sizes(a + 1, N_ROUNDS_P[a - 1]).iter().sum::<usize>()).sum();
        assert_eq!(CONSTANTS.len(), total * 32);
    }
}
