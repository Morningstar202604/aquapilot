//! AquaPilot deterministic simulation core.
//!
//! M1 starts with the ASM2d state/stoichiometry/rate surface, ported from the
//! TypeScript reference implementation. The reference implementation remains the
//! oracle until parity is proven.

pub mod adm1;
pub mod aeration;
pub mod asm1;
pub mod asm1_network;
pub mod asm2d;
pub mod hydraulics;
pub mod network;
pub mod plant_boundary;
pub mod sludge_line;
pub mod takacs;
