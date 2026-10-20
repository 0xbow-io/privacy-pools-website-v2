//! Hashes per second on this machine, no bridge involved:
//!   field   hash() on field elements (the arithmetic alone)
//!   single  poseidon_hex, one call per hash (hex parse + hash + format)
//!   batch   poseidon_batch_hex over BATCH hashes in one call
//!
//! cargo run --release --example bench

use std::hint::black_box;
use std::time::Instant;

use ark_bn254::Fr;
use light_poseidon::{Poseidon, PoseidonHasher};
use native_poseidon::{hash, poseidon_batch_hex, poseidon_hex};

const BATCH: usize = 10_000;

fn rate(n: usize, f: impl FnOnce()) -> f64 {
    let start = Instant::now();
    f();
    n as f64 / start.elapsed().as_secs_f64()
}

fn hex_of(i: u64) -> String {
    format!("{:064x}", i.wrapping_mul(0x9e37_79b9_7f4a_7c15))
}

fn main() {
    println!("arity  field/s     single/s    batch/s     light-poseidon/s");
    for arity in [1usize, 2, 3, 4, 8, 16] {
        // Warm the lazily decoded constants.
        let _ = poseidon_hex("0".repeat(64 * arity));
        let n = BATCH;
        let elems: Vec<Fr> = (0..arity as u64).map(|i| Fr::from(i + 1)).collect();
        let field = rate(n, || {
            for _ in 0..n {
                black_box(hash(black_box(&elems)).unwrap());
            }
        });
        let one: String = (0..arity as u64).map(hex_of).collect();
        let single = rate(n, || {
            for _ in 0..n {
                black_box(poseidon_hex(black_box(one.clone())).unwrap());
            }
        });
        let many: String = (0..(n * arity) as u64).map(hex_of).collect();
        let batch = rate(n, || {
            black_box(poseidon_batch_hex(arity as u32, black_box(many.clone())).unwrap());
        });
        // light-poseidon (unoptimized rounds) stops at 12 inputs.
        let light = if arity <= 12 {
            let mut h = Poseidon::<Fr>::new_circom(arity).unwrap();
            format!("{:>10.0}", rate(n, || {
                for _ in 0..n {
                    black_box(h.hash(black_box(&elems)).unwrap());
                }
            }))
        } else {
            assert!(Poseidon::<Fr>::new_circom(arity).is_err());
            "     n/a".to_string()
        };
        println!("{arity:>5}  {field:>10.0}  {single:>10.0}  {batch:>10.0}  {light}");
    }
}
