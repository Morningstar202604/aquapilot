//! AquaPilot deterministic simulation core.
//!
//! M1 starts with the ASM2d state/stoichiometry/rate surface, ported from the
//! TypeScript reference implementation. The reference implementation remains the
//! oracle until parity is proven.

pub mod aeration;
pub mod asm1;
pub mod asm2d;
pub mod network;
