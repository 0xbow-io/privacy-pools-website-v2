//! The two FFI entry points on stdin/stdout, so the bun test can run the JS
//! shim against the real Rust code on the host:
//!   wire single          < inputs_hex   -> poseidon_hex
//!   wire batch <arity>   < inputs_hex   -> poseidon_batch_hex
//! services/__tests__/native-poseidon-module.test.ts uses
//! target/release/examples/wire when it has been built.

use std::io::Read;

use native_poseidon::{poseidon_batch_hex, poseidon_hex};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let usage = || -> ! {
        eprintln!("usage: wire single | wire batch <arity>  (inputs hex on stdin)");
        std::process::exit(2);
    };
    let result = match (args.get(1).map(String::as_str), args.get(2)) {
        (Some("single"), None) => poseidon_hex(input),
        (Some("batch"), Some(arity)) => match arity.parse() {
            Ok(arity) => poseidon_batch_hex(arity, input),
            Err(_) => usage(),
        },
        _ => usage(),
    };
    match result {
        Ok(out) => print!("{out}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
