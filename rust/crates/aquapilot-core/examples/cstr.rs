use aquapilot_core::asm2d::{Component, CstrOptions, Params, State, step_cstr};
fn main() {
    let mut inf = State::zero();
    for (c, v) in [
        (Component::SA, 60.0),
        (Component::SF, 30.0),
        (Component::SPO4, 5.0),
        (Component::SNH4, 30.0),
        (Component::SNO3, 0.1),
        (Component::XH, 2000.0),
        (Component::XPAO, 300.0),
        (Component::XAUT, 80.0),
        (Component::XPP, 300.0),
        (Component::XPHA, 50.0),
        (Component::SAlk, 8.0),
    ] {
        inf.set(c, v);
    }
    let mut st = inf;
    st.set(Component::SO, 0.0);
    st.set(Component::SNO3, 0.0);
    for _ in 0..24 {
        st = step_cstr(
            &st,
            &inf,
            &Params::default(),
            CstrOptions {
                volume: 1000.0,
                flow: 100.0,
                dt_hours: 1.0,
                temperature_c: 20.0,
            },
        );
    }
    println!("{:?}", st.v);
}
