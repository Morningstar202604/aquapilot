//! Sludge-line smoke example: 48 h at 0.5 h steps with a constant feed.

use aquapilot_core::sludge_line::{SludgeFeed, SludgeLine};

fn main() {
    let feed = SludgeFeed {
        was_flow_m3h: 80.0,
        feed_ss_kg_m3: 8000.0,
        feed_cod_kg_m3: 12000.0,
        feed_n_kg_m3: 600.0,
        feed_p_kg_m3: 120.0,
        ambient_temp_c: 18.0,
    };
    let mut line = SludgeLine::new(true);
    for _ in 0..96 {
        line.step(&feed, 0.5);
    }
    println!("{line:#?}");
}
